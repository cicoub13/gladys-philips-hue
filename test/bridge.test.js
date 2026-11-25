import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { HueBridgeClient, HUE_LINK_BUTTON_NOT_PRESSED, findHueError } from '../src/hue/bridge.js';
import { RequestQueue } from '../src/hue/queue.js';
import { stubHttps } from './fake-https.js';

const USERNAME = 'super-secret-username';

/**
 * Replace global fetch with a queue of canned responses.
 * @param {Array<{ ok?: boolean, status?: number, body?: any, throws?: Error }>} responses - Queued answers.
 * @returns {{ calls: Array<{ url: string, options: object }> }} Recorded calls.
 */
function mockFetch(responses) {
  const calls = [];
  const queue = [...responses];
  mock.method(global, 'fetch', async (url, options) => {
    calls.push({ url, options });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next.throws) {
      throw next.throws;
    }
    return {
      ok: next.ok !== undefined ? next.ok : true,
      status: next.status || 200,
      json: async () => next.body,
    };
  });
  return { calls };
}

afterEach(() => mock.restoreAll());

test('findHueError spots an error in both body shapes', () => {
  assert.equal(findHueError({ 1: { name: 'Salon' } }), undefined);
  assert.equal(findHueError([{ success: {} }]), undefined);
  assert.deepEqual(findHueError([{ error: { type: 3, description: 'resource not available' } }]), {
    type: 3,
    description: 'resource not available',
  });
});

test('getLights returns the lights of a healthy bridge', async () => {
  mockFetch([{ body: { 3: { name: 'Salon' } } }]);
  const lights = await new HueBridgeClient('192.168.1.10', USERNAME).getLights();
  assert.deepEqual(lights, { 3: { name: 'Salon' } });
});

test('a Hue error returned with HTTP 200 is raised, not returned as data', async () => {
  // The v1 API answers 200 with an error body: without this the caller would
  // iterate over the error array and publish a ghost device.
  mockFetch([{ body: [{ error: { type: 1, address: '/lights', description: 'unauthorized user' } }] }]);
  const client = new HueBridgeClient('192.168.1.10', USERNAME);
  await assert.rejects(() => client.getLights(), /unauthorized user/);
});

test('a refused setLightState fails the command instead of reporting success', async () => {
  mockFetch([{ body: [{ error: { type: 201, description: 'parameter not modifiable, device is set to off' } }] }]);
  const client = new HueBridgeClient('192.168.1.10', USERNAME);
  await assert.rejects(() => client.setLightState('3', { bri: 10 }), /not modifiable/);
});

test('getGroups and getScenes read the rooms and scenes of the bridge', async () => {
  const { calls } = mockFetch([{ body: { 1: { name: 'Salon' } } }]);
  const client = new HueBridgeClient('192.168.1.10', USERNAME);
  assert.deepEqual(await client.getGroups(), { 1: { name: 'Salon' } });
  await client.getScenes();
  assert.deepEqual(
    calls.map((call) => call.url),
    [`http://192.168.1.10/api/${USERNAME}/groups`, `http://192.168.1.10/api/${USERNAME}/scenes`],
  );
});

test('recallScene sets the scene on its group', async () => {
  const { calls } = mockFetch([{ body: [{ success: { '/groups/1/action/scene': 'abc' } }] }]);
  await new HueBridgeClient('192.168.1.10', USERNAME).recallScene('1', 'abc');
  assert.equal(calls[0].url, `http://192.168.1.10/api/${USERNAME}/groups/1/action`);
  assert.equal(calls[0].options.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[0].options.body), { scene: 'abc' });
});

test('the scene calls refuse to run before pairing', async () => {
  const client = new HueBridgeClient('192.168.1.10');
  await assert.rejects(() => client.getScenes(), /not paired yet/);
  await assert.rejects(() => client.getGroups(), /not paired yet/);
  await assert.rejects(() => client.recallScene('1', 'abc'), /not paired yet/);
});

test('the username never leaks into an error message', async () => {
  mockFetch([{ ok: false, status: 404 }]);
  const client = new HueBridgeClient('192.168.1.10', USERNAME);
  await assert.rejects(
    () => client.getLights(),
    (error) => {
      assert.ok(!error.message.includes(USERNAME), `username leaked: ${error.message}`);
      assert.match(error.message, /\*\*\*/);
      return true;
    },
  );
});

test('a Hue error message is redacted too', async () => {
  mockFetch([{ body: [{ error: { type: 1, description: 'unauthorized user' } }] }]);
  const client = new HueBridgeClient('192.168.1.10', USERNAME);
  await assert.rejects(
    () => client.getLights(),
    (error) => !error.message.includes(USERNAME),
  );
});

test('a transient failure is retried once', async () => {
  const { calls } = mockFetch([{ throws: new Error('socket hang up') }, { body: { 3: { name: 'Salon' } } }]);
  const lights = await new HueBridgeClient('192.168.1.10', USERNAME).getLights();
  assert.deepEqual(lights, { 3: { name: 'Salon' } });
  assert.equal(calls.length, 2);
});

test('a bridge overloaded with 503 is retried', async () => {
  const { calls } = mockFetch([{ ok: false, status: 503 }, { body: {} }]);
  await new HueBridgeClient('192.168.1.10', USERNAME).getLights();
  assert.equal(calls.length, 2);
});

test('a busy bridge is retried several times, each time later', async (t) => {
  // A burst of commands (a scene on 15 lights) gets 429/503 for a moment: one
  // retry 400 ms later used to lose the command.
  const { calls } = mockFetch([
    { ok: false, status: 429 },
    { ok: false, status: 503 },
    { ok: false, status: 503 },
    { body: { 3: { name: 'Salon' } } },
  ]);
  const delays = [];
  const setTimeoutOriginal = global.setTimeout;
  t.mock.method(global, 'setTimeout', (callback, delay) => {
    delays.push(delay);
    return setTimeoutOriginal(callback, 0);
  });
  assert.deepEqual(await new HueBridgeClient('192.168.1.10', USERNAME).getLights(), { 3: { name: 'Salon' } });
  assert.equal(calls.length, 4);
  // The pauses between attempts, without the queue spacing and the request timeouts.
  assert.deepEqual(
    delays.filter((delay) => delay !== 100 && delay !== 8000),
    [250, 500, 1000],
  );
});

test('a bridge that stays busy fails the request after the last retry', async (t) => {
  const { calls } = mockFetch([{ ok: false, status: 503 }]);
  const setTimeoutOriginal = global.setTimeout;
  t.mock.method(global, 'setTimeout', (callback) => setTimeoutOriginal(callback, 0));
  const client = new HueBridgeClient('192.168.1.10', USERNAME);
  await assert.rejects(() => client.getLights(), /HTTP 503/);
  assert.equal(calls.length, 4);
});

test('a bridge that does not answer is retried once only: each attempt costs a full timeout', async () => {
  const { calls } = mockFetch([{ throws: new Error('connect EHOSTUNREACH') }]);
  await assert.rejects(() => new HueBridgeClient('192.168.1.10', USERNAME).getLights(), /EHOSTUNREACH/);
  assert.equal(calls.length, 2);
});

test('the requests of a bridge share its queue', async () => {
  let inFlight = 0;
  let most = 0;
  mock.method(global, 'fetch', async () => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight -= 1;
    return { ok: true, status: 200, json: async () => [{ success: {} }] };
  });
  const queue = new RequestQueue({ spacingMs: 0 });
  const clients = [1, 2, 3, 4, 5].map(() => new HueBridgeClient('192.168.1.10', USERNAME, { queue }));
  await Promise.all(clients.map((client, index) => client.setLightState(String(index), { on: true })));
  assert.equal(most, 3);
});

test('a business error is never retried', async () => {
  const { calls } = mockFetch([{ body: [{ error: { type: 3, description: 'resource not available' } }] }]);
  await assert.rejects(() => new HueBridgeClient('192.168.1.10', USERNAME).getLights());
  assert.equal(calls.length, 1, 'retrying would fail identically');
});

test('a 404 is not retried either', async () => {
  const { calls } = mockFetch([{ ok: false, status: 404 }]);
  await assert.rejects(() => new HueBridgeClient('192.168.1.10', USERNAME).getLights());
  assert.equal(calls.length, 1);
});

test('createUser returns the username the bridge granted', async () => {
  mockFetch([{ body: [{ success: { username: 'brand-new-key' } }] }]);
  const client = new HueBridgeClient('192.168.1.10');
  assert.equal(await client.createUser('gladys#test'), 'brand-new-key');
  assert.equal(client.username, 'brand-new-key');
});

test('createUser surfaces the "link button not pressed" case as a typed error', async () => {
  mockFetch([{ body: [{ error: { type: 101, description: 'link button not pressed' } }] }]);
  await assert.rejects(
    () => new HueBridgeClient('192.168.1.10').createUser(),
    (error) => error.hueErrorType === HUE_LINK_BUTTON_NOT_PRESSED,
  );
});

test('createUser is never retried: it would leave an orphan user on the bridge', async () => {
  const { calls } = mockFetch([{ throws: new Error('socket hang up') }, { body: [{ success: { username: 'x' } }] }]);
  await assert.rejects(() => new HueBridgeClient('192.168.1.10').createUser());
  assert.equal(calls.length, 1);
});

test('an unpaired bridge refuses to build a request', async () => {
  const client = new HueBridgeClient('192.168.1.10');
  await assert.rejects(() => client.getLights(), /not paired yet/);
  await assert.rejects(() => client.setLightState('3', { on: true }), /not paired yet/);
});

test('requests target the bridge over plain HTTP with a JSON content type', async () => {
  const { calls } = mockFetch([{ body: {} }]);
  await new HueBridgeClient('192.168.1.10', USERNAME).setLightState('3', { on: true });
  assert.equal(calls[0].url, `http://192.168.1.10/api/${USERNAME}/lights/3/state`);
  assert.equal(calls[0].options.method, 'PUT');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].options.body, JSON.stringify({ on: true }));
});

// What firmware 1.78+ answers on plain HTTP (aiohue issue 708).
const HTTP_BLOCKED = { ok: false, status: 403, body: [{ error: { description: 'HTTP access is blocked' } }] };
const BRIDGE_ID = '001788fffe123456';

/**
 * A client for a bridge paired over HTTP, recording the HTTPS upgrades it reports.
 * @param {string} [id] - Stored bridge id (`''` for bridges paired by 1.0.x/1.1.0, which have none).
 * @returns {{ client: HueBridgeClient, upgrades: object[] }} Client and recorded upgrades.
 */
function pairedOverHttp(id = BRIDGE_ID) {
  const upgrades = [];
  const client = new HueBridgeClient('192.168.1.10', USERNAME, {
    scheme: 'http',
    id,
    onHttpsUpgrade: async (transport) => {
      upgrades.push(transport);
    },
  });
  return { client, upgrades };
}

/**
 * A bridge answering on HTTPS: its identity card on `/api/config`, `body` elsewhere.
 * @param {any} body - Answer to the authenticated requests.
 * @param {{ cn?: string, bridgeid?: string }} [identity] - Certificate CN and announced id.
 * @returns {Function} Responder for `stubHttps`.
 */
function bridgeOverHttps(body, { cn = BRIDGE_ID, bridgeid = BRIDGE_ID.toUpperCase() } = {}) {
  return (url) => ({ body: url.endsWith('/api/config') ? { bridgeid, modelid: 'BSB002' } : body, cn });
}

test('a bridge that blocks HTTP is switched to HTTPS with the same username', async () => {
  // No link-button press: the application key is not tied to the transport.
  mockFetch([HTTP_BLOCKED]);
  const { calls } = stubHttps(bridgeOverHttps({ 3: { name: 'Salon' } }));
  const { client, upgrades } = pairedOverHttp();

  assert.deepEqual(await client.getLights(), { 3: { name: 'Salon' } });
  assert.deepEqual(
    calls.map((call) => call.url),
    ['https://192.168.1.10/api/config', `https://192.168.1.10/api/${USERNAME}/lights`],
    'the bridge is proven without the username first',
  );
  assert.equal(client.scheme, 'https');
  assert.equal(upgrades.length, 1);
  assert.equal(upgrades[0].scheme, 'https');
  assert.ok(upgrades[0].certFingerprint, 'the certificate is pinned and persisted');
});

test('a bridge that closed port 80 is switched to HTTPS too', async () => {
  const refused = new TypeError('fetch failed');
  refused.cause = { code: 'ECONNREFUSED' };
  mockFetch([{ throws: refused }]);
  stubHttps(bridgeOverHttps([{ success: {} }]));
  const { client, upgrades } = pairedOverHttp();

  await client.setLightState('3', { on: true });
  assert.equal(client.scheme, 'https');
  assert.equal(upgrades.length, 1);
});

test('once switched, the client talks HTTPS only', async () => {
  const fetchMock = mockFetch([HTTP_BLOCKED]);
  const { calls } = stubHttps(bridgeOverHttps({}));
  const { client, upgrades } = pairedOverHttp();

  await client.getLights();
  await client.getLights();
  assert.equal(fetchMock.calls.length, 1);
  assert.equal(calls.length, 3, 'one proof, then the two reads');
  assert.equal(upgrades.length, 1);
});

test('concurrent requests refused over HTTP share one switch', async () => {
  // A scene reads the groups and the scenes at once: two switches used to race,
  // and one could persist `scheme: 'http'` while the log said HTTPS.
  mockFetch([HTTP_BLOCKED]);
  const { calls } = stubHttps(bridgeOverHttps({}));
  const { client, upgrades } = pairedOverHttp();

  await Promise.all([client.getGroups(), client.getScenes()]);
  assert.equal(calls.filter((call) => call.url.endsWith('/api/config')).length, 1);
  assert.deepEqual(
    upgrades.map((upgrade) => upgrade.scheme),
    ['https'],
  );
});

test('the switch never sends the username to a certificate that is not the bridge one', async () => {
  mockFetch([HTTP_BLOCKED]);
  const { calls } = stubHttps(bridgeOverHttps({}, { cn: 'someone-else' }));
  const { client, upgrades } = pairedOverHttp();

  const error = await client.getLights().catch((caught) => caught);
  assert.match(error.message, /HTTP 403.*HTTPS failed too: Refused the TLS certificate/);
  assert.equal(error.httpStatus, 403, 'the bridge answered: it is not reported unreachable');
  assert.deepEqual(calls, [], 'nothing is written on a refused connection');
  assert.equal(client.scheme, 'http');
  assert.deepEqual(upgrades, []);
});

test('the switch refuses another bridge answering at the same address', async () => {
  // Its own certificate is refused by the TLS layer, before anything is sent.
  mockFetch([HTTP_BLOCKED]);
  stubHttps(bridgeOverHttps({}, { cn: 'ecb5fafffe000000', bridgeid: 'ECB5FAFFFE000000' }));
  const { client, upgrades } = pairedOverHttp();

  await assert.rejects(() => client.getLights(), /HTTPS failed too: Refused the TLS certificate/);
  assert.deepEqual(upgrades, []);
});

test('the switch says so when the bridge announces another id than its certificate', async () => {
  mockFetch([HTTP_BLOCKED]);
  stubHttps(bridgeOverHttps({}, { bridgeid: 'ECB5FAFFFE000000' }));
  const { client, upgrades } = pairedOverHttp();

  const error = await client.getLights().catch((caught) => caught);
  assert.match(error.message, /announces bridge ecb5fafffe000000 on HTTPS, expected 001788fffe123456/);
  assert.equal(error.httpStatus, 403, 'not a transient failure');
  assert.deepEqual(upgrades, []);
});

test('a bridge stored without an id is switched only if its certificate names the id it announces', async () => {
  // Paired by 1.0.x/1.1.0 through the manual IP field: no id to check against,
  // so the certificate must at least match the bridge's own identity card.
  mockFetch([HTTP_BLOCKED]);
  stubHttps(bridgeOverHttps({}, { cn: '' }));
  const impostor = pairedOverHttp('');
  await assert.rejects(() => impostor.client.getLights(), /certificate for ""/);
  assert.deepEqual(impostor.upgrades, []);

  mock.restoreAll();
  mockFetch([HTTP_BLOCKED]);
  stubHttps(bridgeOverHttps({}));
  const genuine = pairedOverHttp('');
  await genuine.client.getLights();
  assert.equal(genuine.upgrades.length, 1);
});

test('a transient HTTPS failure during the switch is retried like any request', async () => {
  // Hidden behind the HTTP 403, a busy bridge (503) used to fail the command
  // without the retry every other request gets.
  mockFetch([HTTP_BLOCKED]);
  let busy = true;
  const answer = bridgeOverHttps({ 3: { name: 'Salon' } });
  stubHttps((url) => {
    if (busy) {
      busy = false;
      return { status: 503, body: {}, cn: BRIDGE_ID };
    }
    return answer(url);
  });
  const { client, upgrades } = pairedOverHttp();

  assert.deepEqual(await client.getLights(), { 3: { name: 'Salon' } });
  assert.equal(upgrades.length, 1);
});

test('a bridge that answers neither HTTP nor HTTPS is reported unreachable', async () => {
  mockFetch([HTTP_BLOCKED]);
  stubHttps();
  const { client } = pairedOverHttp();

  const error = await client.getLights().catch((caught) => caught);
  assert.match(error.message, /HTTP 403.*HTTPS failed too: connect ECONNREFUSED/);
  assert.equal(error.httpStatus, undefined);
});

test('an HTTP error other than "blocked" does not trigger the switch', async () => {
  mockFetch([{ ok: false, status: 404 }]);
  const { calls } = stubHttps();
  const { client, upgrades } = pairedOverHttp();

  await assert.rejects(() => client.getLights(), /HTTP 404/);
  assert.equal(calls.length, 0);
  assert.deepEqual(upgrades, []);
});

test('a client without an upgrade hook never switches (identification)', async () => {
  mockFetch([HTTP_BLOCKED]);
  const { calls } = stubHttps();
  await assert.rejects(() => new HueBridgeClient('192.168.1.10').getConfig({ retries: 0 }), /HTTP 403/);
  assert.equal(calls.length, 0);
});

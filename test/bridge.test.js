import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { HueBridgeClient, HUE_LINK_BUTTON_NOT_PRESSED, findHueError } from '../src/hue/bridge.js';

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

test('a business error is never retried', async () => {
  const { calls } = mockFetch([{ body: [{ error: { type: 3, description: 'resource not available' } }] }]);
  await assert.rejects(() => new HueBridgeClient('192.168.1.10', USERNAME).getLight('99'));
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

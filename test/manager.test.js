import { test, mock } from 'node:test';
import { PassThrough } from 'node:stream';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { HueManager, nextResyncDelay } from '../src/manager.js';
import { BridgeStore } from '../src/hue/store.js';
import { FEATURE } from '../src/hue/mapping.js';
import { resetDiscoveryCache } from '../src/hue/discovery.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { fingerprintOf } from '../src/hue/https.js';
import { RequestQueue } from '../src/hue/queue.js';
import { stubHttps } from './fake-https.js';

// The SDK's fake Gladys, recording everything published. The `test` selector
// gives the `ext:test:…` external ids the tests below expect.
const makeGladys = () => createFakeGladys({ selector: 'test' });

// Fake bridge client with an in-memory light.
function makeFakeClient() {
  const light = {
    name: 'Salon',
    type: 'Extended color light',
    uniqueid: '00:17:88:01:aa',
    state: { on: false, bri: 100, xy: [0.4, 0.4], ct: 300 },
    capabilities: { control: { ct: { min: 153, max: 500 } } },
  };
  return {
    light,
    lastSetState: null,
    down: false,
    async getLights() {
      if (this.down) {
        throw new Error('connect EHOSTUNREACH');
      }
      return { 3: light };
    },
    async setLightState(id, state) {
      this.lastSetState = { id, state };
      Object.assign(light.state, state);
      return [{ success: true }];
    },
    // A firmware without the v2 API: no event stream (see withPush).
    async switchToHttps() {},
    async isV2() {
      return false;
    },
  };
}

async function makeManager() {
  // A discovery cached by an earlier test would send real requests.
  resetDiscoveryCache();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hue-mgr-'));
  const store = new BridgeStore(path.join(dir, 'bridges.json'));
  await store.load();
  await store.upsert({ id: 'b1', ip: '192.168.1.10', username: 'user-1' });

  const gladys = makeGladys();
  const manager = new HueManager(gladys, { ...DEFAULT_CONFIG }, store);
  const client = makeFakeClient();
  manager.clientFor = () => client;
  return { manager, gladys, client, store };
}

/**
 * Register the lights and return the external_id of the only device.
 * @param {HueManager} manager - Manager under test.
 * @returns {Promise<string>} Device external id.
 */
async function firstDeviceId(manager) {
  await manager.buildDiscoveredDevices();
  return [...manager.registry.keys()][0];
}

/**
 * Register the lights and create every one of them in Gladys, as the user
 * would from the Discovery tab.
 * @param {HueManager} manager - Manager under test.
 * @param {object} gladys - Its fake Gladys.
 * @returns {Promise<string>} External id of the first device.
 */
async function createAll(manager, gladys) {
  await manager.buildDiscoveredDevices();
  gladys.devices = [...manager.registry.keys()].map((externalId) => ({ external_id: externalId }));
  return gladys.devices[0].external_id;
}

/**
 * Count the getLights() calls of a fake client.
 * @param {object} client - Fake bridge client.
 * @returns {{ count: number }} Live counter.
 */
function countReads(client) {
  const reads = { count: 0 };
  const getLights = client.getLights;
  client.getLights = function () {
    reads.count += 1;
    return getLights.call(this);
  };
  return reads;
}

/**
 * Make every bridge that is not answering look silent for long enough to be
 * forgotten (a single missed read may be a reboot).
 * @param {HueManager} manager - Manager under test.
 */
function silentForLong(manager) {
  for (const key of manager.silentSince.keys()) {
    manager.silentSince.set(key, performance.now() - 10 * 60 * 1000);
  }
}

// Let the refresh started by a mocked timer run to its end (the fakes only
// chain promises, no real I/O).
const settle = () => new Promise(setImmediate);

test('buildDiscoveredDevices maps bridge lights to Gladys devices', async () => {
  const { manager } = await makeManager();
  const { devices, reachable, unreachable } = await manager.buildDiscoveredDevices();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, 'Salon');
  assert.equal(reachable, 1);
  assert.equal(unreachable, 0);
  // The registry is populated for later dispatch.
  assert.equal(manager.registry.size, 1);
});

test('the discovered lights do not ask Gladys to poll them, and keep their ids', async () => {
  // The integration refreshes the lights itself: Gladys never polled them (no
  // should_poll), so poll_frequency was a dead field.
  const { manager } = await makeManager();
  const { devices } = await manager.buildDiscoveredDevices();
  assert.equal('poll_frequency' in devices[0], false);
  assert.equal('should_poll' in devices[0], false);
  // Unchanged external_ids and features: the devices already created keep working.
  assert.equal(devices[0].external_id, SALON_ID);
  assert.deepEqual(
    devices[0].features.map((feature) => feature.external_id),
    ['on-off', 'brightness', 'color', 'temperature'].map((key) => `${SALON_ID}:${key}`),
  );
});

test('setValue sends the right Hue state and echoes it', async () => {
  const { manager, gladys, client } = await makeManager();
  const deviceId = await firstDeviceId(manager);
  const ids = gladys.externalIds('light', manager.registry.get(deviceId).platformId);

  await manager.setValue({ external_id: deviceId }, { external_id: ids.feature(FEATURE.BRIGHTNESS) }, 100);
  assert.deepEqual(client.lastSetState, { id: '3', state: { on: true, bri: 254 } });
  const brightness = gladys.fake.states.find((s) => s.device_feature_external_id === ids.feature(FEATURE.BRIGHTNESS));
  assert.equal(brightness.state, 100);
});

test('setValue also publishes the on/off state a command implies', async () => {
  const { manager, gladys } = await makeManager();
  const deviceId = await firstDeviceId(manager);
  const ids = gladys.externalIds('light', manager.registry.get(deviceId).platformId);

  // The light starts off; setting a colour turns it on.
  await manager.setValue({ external_id: deviceId }, { external_id: ids.feature(FEATURE.COLOR) }, 0xff0000);
  const onOff = gladys.fake.states.find((s) => s.device_feature_external_id === ids.feature(FEATURE.ON_OFF));
  assert.ok(onOff, 'the on/off state is published alongside the colour');
  assert.equal(onOff.state, 1);
});

test('setValue rejects a feature that does not belong to the light', async () => {
  const { manager } = await makeManager();
  const deviceId = await firstDeviceId(manager);
  await assert.rejects(
    () => manager.setValue({ external_id: deviceId }, { external_id: 'ext:test:light:x:nope' }, 1),
    /Unknown feature/,
  );
});

test('a refresh publishes the current state of the created lights', async () => {
  const { manager, gladys } = await makeManager();
  const deviceId = await createAll(manager, gladys);

  await manager.pollLights();
  const ids = gladys.externalIds('light', manager.registry.get(deviceId).platformId);
  const onOff = gladys.fake.states.find((s) => s.device_feature_external_id === ids.feature(FEATURE.ON_OFF));
  assert.ok(onOff, 'on/off state published');
  assert.equal(onOff.state, 0);
});

test('a refresh does not republish states that did not change', async () => {
  const { manager, gladys } = await makeManager();
  await createAll(manager, gladys);

  await manager.pollLights();
  const afterFirstRefresh = gladys.fake.states.length;
  assert.ok(afterFirstRefresh > 0);

  // Gladys caps an integration at 300 states per minute: an unchanged light
  // must cost nothing.
  await manager.pollLights();
  assert.equal(gladys.fake.states.length, afterFirstRefresh);
});

test('a refresh publishes again once a value really changed (Hue app, wall switch...)', async () => {
  const { manager, gladys, client } = await makeManager();
  await createAll(manager, gladys);

  await manager.pollLights();
  const afterFirstRefresh = gladys.fake.states.length;

  client.light.state.on = true;
  await manager.pollLights();
  assert.deepEqual(gladys.fake.states.slice(afterFirstRefresh), [
    { device_feature_external_id: `${SALON_ID}:on-off`, state: 1 },
  ]);
});

test('a light deleted then created again in Gladys gets its states again', async () => {
  // The dedup used to survive the deletion: the new device stayed without states
  // until a value changed on the bridge.
  const { manager, gladys } = await makeManager();
  await manager.syncDevices();
  const [device] = gladys.fake.discoveredDevices;
  await gladys.fake.deviceCreated(device);
  await manager.pollLights();
  const sent = gladys.fake.states.length;
  assert.ok(sent > 0);

  await gladys.fake.deviceDeleted(device);
  await gladys.fake.deviceCreated(device);
  await manager.pollLights();
  assert.deepEqual(
    gladys.fake.states.slice(sent).map((s) => s.device_feature_external_id),
    ['on-off', 'brightness', 'color', 'temperature'].map((key) => `${SALON_ID}:${key}`),
  );
});

test('a refresh neither reads nor publishes the lights not created in Gladys', async () => {
  // Gladys drops their states but counts them in its 300 states/minute limit.
  const { manager, gladys, client } = await makeManager();
  await manager.buildDiscoveredDevices();
  const reads = countReads(client);
  await manager.pollLights();
  assert.equal(reads.count, 0);
  assert.equal(gladys.fake.states.length, 0);
});

test('a refresh that read a light before a command does not flip it back', async () => {
  const { manager, gladys, client } = await makeManager();
  await createAll(manager, gladys);
  await manager.pollLights(); // on-off = 0 published

  // The bridge answers the refresh with the state from before the command.
  let answer;
  client.getLights = () =>
    new Promise((resolve) => {
      answer = resolve;
    });
  const stale = { ...client.light, state: { ...client.light.state } };
  const refresh = manager.pollLights();
  await manager.setValue({ external_id: SALON_ID }, { external_id: `${SALON_ID}:on-off` }, 1);
  answer({ 3: stale });
  await refresh;

  const onOff = gladys.fake.states.filter((s) => s.device_feature_external_id === `${SALON_ID}:on-off`);
  assert.equal(onOff.at(-1).state, 1, 'the command echo stays the last word');
});

test('resolve throws a helpful error for an unknown device', async () => {
  const { manager } = await makeManager();
  await manager.buildDiscoveredDevices();
  assert.throws(() => manager.resolve({ external_id: 'ext:test:light:b1-nope' }), /run a scan/);
  // A light of a bridge that is no longer stored (forgotten): say so.
  assert.throws(
    () => manager.resolve({ external_id: 'ext:test:light:b9-nope' }),
    /bridge of light .* no longer paired/,
  );
});

test('resolve tells the user when the bridge is no longer paired', async () => {
  const { manager, store } = await makeManager();
  const deviceId = await firstDeviceId(manager);
  store.bridges.length = 0; // the user removed the pairing
  assert.throws(() => manager.resolve({ external_id: deviceId }), /no longer paired/);
});

test('an unreachable bridge keeps its lights dispatchable', async () => {
  const { manager, client } = await makeManager();
  const deviceId = await firstDeviceId(manager);

  // A network glitch on the next scan must not wipe the registry: every command
  // would then fail with a misleading "unknown light".
  client.down = true;
  const { devices, reachable, unreachable } = await manager.buildDiscoveredDevices();
  assert.equal(devices.length, 1, 'its lights stay listed in Discovery too');
  assert.equal(reachable, 0);
  assert.equal(unreachable, 1);
  assert.equal(manager.registry.size, 1);

  client.down = false;
  await assert.doesNotReject(() =>
    manager.setValue({ external_id: deviceId }, { external_id: `${deviceId}:on-off` }, 1),
  );
});

test('syncDevices does not wipe the published devices when every bridge is down', async () => {
  const { manager, gladys, client } = await makeManager();
  await manager.syncDevices();
  assert.equal(gladys.fake.discoveredDevices.length, 1);

  client.down = true;
  await manager.syncDevices();
  assert.equal(gladys.fake.bodies('POST', '/discovered_device').length, 1, 'no empty list published');
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.fr, /injoignable/);
});

test('syncDevices reports the missing pairing when no bridge is stored', async () => {
  const { manager, gladys, store } = await makeManager();
  store.bridges.length = 0;
  const devices = await manager.syncDevices();
  assert.deepEqual(devices, []);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /No Hue bridge paired/);
});

test('syncDevices reports a healthy connection once lights are published', async () => {
  const { manager, gladys } = await makeManager();
  await manager.syncDevices();
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('init loads the bridges persisted by a previous run', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hue-init-'));
  const file = path.join(dir, 'bridges.json');
  const seed = new BridgeStore(file);
  await seed.load();
  await seed.upsert({ id: 'b1', ip: '192.168.1.10', username: 'user-1' });

  const manager = new HueManager(makeGladys(), { ...DEFAULT_CONFIG }, new BridgeStore(file));
  await manager.init();
  assert.equal(manager.store.list().length, 1);
});

/**
 * A manager over a bridges.json exactly as 1.0.x/1.1.0 wrote it for a bridge
 * paired through the manual IP field: no bridge id, so its lights' external_ids
 * are built from the IP.
 * @returns {Promise<{ manager: HueManager, client: object, store: BridgeStore, file: string }>} Handles.
 */
async function makeLegacyManager() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hue-legacy-'));
  const file = path.join(dir, 'bridges.json');
  await fs.writeFile(file, JSON.stringify({ bridges: [{ id: '', ip: '192.168.1.10', username: 'user-1' }] }, null, 2));
  const store = new BridgeStore(file);
  await store.load();
  const manager = new HueManager(makeGladys(), { ...DEFAULT_CONFIG }, store);
  const client = makeFakeClient();
  manager.clientFor = () => client;
  return { manager, client, store, file };
}

test('a bridge paired by 1.1.0 without an id keeps its external_ids when paired again', async () => {
  // Re-pairing used to append a second entry keyed by the real bridge id: every
  // light came back under new external_ids, orphaning the devices already created.
  const { manager, store } = await makeLegacyManager();
  await manager.buildDiscoveredDevices();
  const before = [...manager.registry.keys()];
  assert.match(before[0], /:192\.168\.1\.10-/, 'the legacy external_id is IP-based');

  await store.upsert({ id: 'abc', ip: '192.168.1.10', username: 'user-2', scheme: 'http' });
  assert.equal(store.list().length, 1, 'the legacy entry is updated, not duplicated');
  assert.equal(store.list()[0].username, 'user-2');

  await manager.buildDiscoveredDevices();
  assert.deepEqual([...manager.registry.keys()], before);
});

test('a legacy bridge learns its id, so a later IP change keeps its external_ids', async () => {
  const { manager, client, store, file } = await makeLegacyManager();
  client.getConfig = async () => ({ bridgeid: '001788FFFE1234AB', modelid: 'BSB002', apiversion: '1.63.0' });
  await manager.buildDiscoveredDevices();
  const before = [...manager.registry.keys()];

  const reopened = new BridgeStore(file);
  await reopened.load();
  assert.equal(reopened.list()[0].id, '001788fffe1234ab', 'the id is persisted');

  // The DHCP lease changes, the user pairs again at the new address.
  await store.upsert({ id: '001788fffe1234ab', ip: '192.168.1.99', username: 'user-2', scheme: 'http' });
  assert.equal(store.list().length, 1);
  await manager.buildDiscoveredDevices();
  assert.deepEqual([...manager.registry.keys()], before);
});

// A Hue bridge answering the SSDP scan, as the core relays it (raw response text).
const HUE_SSDP_RESPONDER = {
  source_ip: '192.168.1.42',
  source_port: 1900,
  headers:
    'HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.42:80/description.xml\r\n' +
    'hue-bridgeid: 001788FFFE23BFC2\r\nST: urn:schemas-upnp-org:device:basic:1\r\n\r\n',
};

test('candidateBridges merges the discovered bridges with the manual address', async () => {
  const { manager } = await makeManager();
  manager.config = { ...DEFAULT_CONFIG, bridge_ip: '10.0.0.5' };
  manager.gladys.fake.scanResults = { ssdp: [HUE_SSDP_RESPONDER] };
  resetDiscoveryCache();

  const candidates = await manager.candidateBridges();
  assert.deepEqual(candidates.map((c) => c.ip).sort(), ['10.0.0.5', '192.168.1.42']);
});

test('candidateBridges does not duplicate a manual address already discovered', async () => {
  const { manager } = await makeManager();
  manager.config = { ...DEFAULT_CONFIG, bridge_ip: '192.168.1.42' };
  manager.gladys.fake.scanResults = { ssdp: [HUE_SSDP_RESPONDER] };
  resetDiscoveryCache();

  assert.equal((await manager.candidateBridges()).length, 1);
});

// A bridge as `identifyBridge` returns it, once proven through /api/config.
const IDENTIFIED_BRIDGE = {
  ip: '192.168.1.42',
  id: 'abc',
  name: 'Philips hue',
  model: 'BSB002',
  apiVersion: '1.63.0',
  scheme: 'http',
};

test('pairBridges persists the credentials of a bridge whose button was pressed', async () => {
  const { manager, store } = await makeManager();
  store.bridges.length = 0;
  manager.identifiedBridges = async () => ({ bridges: [IDENTIFIED_BRIDGE], ignored: [] });
  mock.method(global, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => [{ success: { username: 'granted-key' } }],
  }));

  const result = await manager.pairBridges();
  assert.deepEqual(
    result.paired.map((bridge) => bridge.ip),
    ['192.168.1.42'],
  );
  assert.equal(store.list()[0].username, 'granted-key', 'credentials survive a restart');
  assert.equal(store.list()[0].scheme, 'http', 'the working scheme is remembered');
  mock.restoreAll();
});

test('pairBridges separates "button not pressed" from an unreachable bridge', async () => {
  const { manager } = await makeManager();
  manager.identifiedBridges = async () => ({
    bridges: [IDENTIFIED_BRIDGE, { ...IDENTIFIED_BRIDGE, ip: '192.168.1.43' }],
    ignored: [],
  });
  mock.method(global, 'fetch', async (url) => {
    if (String(url).includes('192.168.1.42')) {
      return { ok: true, status: 200, json: async () => [{ error: { type: 101, description: 'link button' } }] };
    }
    throw new Error('EHOSTUNREACH');
  });

  const result = await manager.pairBridges();
  assert.deepEqual(
    result.pending.map((bridge) => bridge.ip),
    ['192.168.1.42'],
    'the user just has to press the button',
  );
  assert.deepEqual(
    result.unreachable.map((bridge) => bridge.ip),
    ['192.168.1.43'],
    'this one is a network problem',
  );
  mock.restoreAll();
});

test('pairBridges never tries to pair a device that is not a Hue bridge', async () => {
  // The reported bug: mDNS surfaced a printer and a NAS, and pairing POSTed
  // /api to both, surfacing "fetch failed" and "HTTP 404" to the user.
  const { manager } = await makeManager();
  manager.candidateBridges = async () => [
    { id: '', ip: '192.168.0.243' },
    { id: '', ip: '192.168.0.235' },
  ];

  const calls = [];
  stubHttps();
  mock.method(global, 'fetch', async (url, options = {}) => {
    calls.push(`${options.method || 'GET'} ${url}`);
    if (String(url).includes('192.168.0.243')) {
      throw new Error('fetch failed');
    }
    // An HTTP server that is not a bridge.
    return { ok: false, status: 404, json: async () => ({}) };
  });

  const result = await manager.pairBridges();
  assert.deepEqual(result.paired, []);
  assert.deepEqual(result.pending, []);
  assert.deepEqual(result.notABridge, ['192.168.0.243', '192.168.0.235']);
  assert.ok(
    calls.every((call) => !call.startsWith('POST')),
    `no pairing attempt should be made, got: ${calls.join(' | ')}`,
  );
  mock.restoreAll();
});

test('a bridge paired over HTTP is moved to HTTPS for good once its firmware blocks HTTP', async () => {
  // Bridges paired before firmware 1.78 are stored as `http`: without the
  // switch, every command and refresh fails until the user pairs again.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hue-mgr-'));
  const file = path.join(dir, 'bridges.json');
  const store = new BridgeStore(file);
  await store.load();
  await store.upsert({ id: '001788fffe123456', ip: '192.168.1.10', username: 'user-1', scheme: 'http' });
  const manager = new HueManager(makeGladys(), { ...DEFAULT_CONFIG }, store);
  mock.method(global, 'fetch', async () => ({ ok: false, status: 403, json: async () => [] }));
  stubHttps((url) => ({
    body: url.endsWith('/api/config')
      ? { bridgeid: '001788FFFE123456', modelid: 'BSB002' }
      : { 3: { name: 'Salon', uniqueid: '00:17:88:01:aa' } },
    cn: '001788fffe123456',
  }));

  const { reachable } = await manager.buildDiscoveredDevices();
  assert.equal(reachable, 1);

  const reopened = new BridgeStore(file);
  await reopened.load();
  const [bridge] = reopened.list();
  assert.equal(bridge.scheme, 'https');
  assert.ok(bridge.certFingerprint);
  assert.equal(bridge.username, 'user-1', 'no new pairing');
  assert.equal(bridge.id, '001788fffe123456', 'same bridge: the external_ids are kept');
  mock.restoreAll();
});

/**
 * Answer the plain HTTP requests of the tests below, by URL.
 * @param {(url: string, options: object) => any} answer - Body to serve; a thrown error fails the request.
 * @returns {string[]} The requests made, as `METHOD url`.
 */
function serveHttp(answer) {
  const calls = [];
  mock.method(global, 'fetch', async (url, options = {}) => {
    calls.push(`${options.method || 'GET'} ${url}`);
    const body = answer(String(url), options);
    return { ok: true, status: 200, json: async () => body };
  });
  return calls;
}

const UNAUTHORIZED = [{ error: { type: 1, description: 'unauthorized user' } }];

/**
 * makeManager() with its only light created in Gladys, and its bridge b1 no
 * longer answering (replaced, reset, or moved).
 * @returns {Promise<object>} Same as makeManager().
 */
async function makeLostBridgeManager() {
  const made = await makeManager();
  await createAll(made.manager, made.gladys);
  made.client.down = true;
  await made.manager.syncDevices();
  return made;
}

// What identification returns for b1 at a new address, with its pinned certificate.
const B1_MOVED = { id: 'b1', ip: '192.168.1.11', scheme: 'https', certFingerprint: 'AA:BB' };

/**
 * makeLostBridgeManager() with b1 paired over HTTPS, its certificate pinned.
 * @returns {Promise<object>} Same as makeManager().
 */
async function makeLostHttpsBridgeManager() {
  const made = await makeLostBridgeManager();
  Object.assign(made.store.list()[0], { scheme: 'https', certFingerprint: 'aabb' });
  return made;
}

test('a paired bridge found at a new address is followed there, with the same username', async () => {
  // A new DHCP lease: until now, only a new pairing (and the link button) fixed it.
  const { manager, store } = await makeLostHttpsBridgeManager();
  const moved = await manager.followMovedBridges([B1_MOVED]);
  assert.equal(moved.length, 1);
  assert.deepEqual(
    store.list().map((bridge) => [bridge.ip, bridge.username]),
    [['192.168.1.11', 'user-1']],
  );
  manager.stop();
});

test('a bridge whose old address now answers 404 (another device) is followed too', async () => {
  const { manager, gladys, store, client } = await makeManager();
  Object.assign(store.list()[0], { scheme: 'https', certFingerprint: 'aabb' });
  await createAll(manager, gladys);
  failReads(client, { message: 'HTTP 404', httpStatus: 404 });
  await manager.pollLights();
  assert.ok(manager.resyncTimer, 'the background search runs');
  await manager.followMovedBridges([B1_MOVED]);
  assert.equal(store.list()[0].ip, '192.168.1.11');
  manager.stop();
});

test('a bridge paired over plain HTTP is never followed: nothing proves who claims its id', async () => {
  // The round bridge: anything on the network can announce its id, which is
  // public, and would get its username in clear.
  const { manager, store } = await makeLostBridgeManager();
  await manager.followMovedBridges([{ id: 'b1', ip: '192.168.1.11', scheme: 'http' }]);
  assert.equal(store.list()[0].ip, '192.168.1.10');
  manager.stop();
});

test('a bridge that answers at its address is not moved', async () => {
  const { manager, store } = await makeManager();
  await manager.syncDevices();
  await manager.followMovedBridges([{ id: 'b1', ip: '192.168.1.11', scheme: 'http' }]);
  assert.equal(store.list()[0].ip, '192.168.1.10');
});

test('a bridge is not followed to an address whose certificate is not the one pinned', async () => {
  // The bridge id is public: anything can claim it, and would get the username.
  const { manager, store } = await makeLostBridgeManager();
  Object.assign(store.list()[0], { scheme: 'https', certFingerprint: 'AA:BB' });
  await manager.followMovedBridges([
    { id: 'b1', ip: '192.168.1.11', scheme: 'https', certFingerprint: 'CC:DD' },
    { id: 'b1', ip: '192.168.1.12', scheme: 'http' },
  ]);
  assert.equal(store.list()[0].ip, '192.168.1.10');

  await manager.followMovedBridges([{ id: 'b1', ip: '192.168.1.13', scheme: 'https', certFingerprint: 'aabb' }]);
  assert.equal(store.list()[0].ip, '192.168.1.13');
  manager.stop();
});

test('the background resync finds a bridge that changed address, without the cloud', async () => {
  const { manager, gladys, store, client } = await makeLostBridgeManager();
  Object.assign(store.list()[0], { scheme: 'https', certFingerprint: fingerprintOf(Buffer.from('cert')) });
  const silent = makeFakeClient();
  silent.down = true;
  client.down = false;
  manager.clientFor = (bridge) => (bridge.ip === '192.168.1.11' ? client : silent);
  gladys.fake.scanResults = {
    mdns: [{ name: 'Philips Hue - 1._hue._tcp.local', addresses: ['192.168.1.11'], txt: ['bridgeid=B1'] }],
  };
  resetDiscoveryCache();
  const { calls } = stubHttps(() => ({ body: { bridgeid: 'B1', modelid: 'BSB002' }, cn: 'b1' }));
  serveHttp(() => assert.fail('never the cloud, nor plain HTTP'));

  await manager.resync();
  assert.equal(store.list()[0].ip, '192.168.1.11');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.deepEqual(
    calls.map((call) => call.url),
    ['https://192.168.1.11/api/config'],
  );
  manager.stop();
  mock.restoreAll();
});

test('pairing a bridge again reuses its username when it still works: no link button, no orphan user', async () => {
  const { manager, store } = await makeManager();
  manager.identifiedBridges = async () => ({
    bridges: [{ ...IDENTIFIED_BRIDGE, id: 'b1', ip: '192.168.1.10' }],
    ignored: [],
  });
  const calls = serveHttp(() => ({ 3: { name: 'Salon' } }));

  const result = await manager.pairBridges();
  assert.equal(result.paired.length, 1);
  assert.deepEqual(calls, ['GET http://192.168.1.10/api/user-1/lights']);
  assert.equal(store.list()[0].username, 'user-1');
  mock.restoreAll();
});

test('a bridge migrated to a Bridge Pro keeps the devices, even when the old one still answers', async () => {
  // After the migration the old bridge is reset, but may stay plugged in and
  // answer "unauthorized user". Until now every light came back as a new device.
  const { manager, gladys, store, client } = await makeManager();
  await createAll(manager, gladys);
  failReads(client, { message: 'unauthorized user', hueErrorType: 1 });
  await manager.pollLights();
  const pro = {
    ...IDENTIFIED_BRIDGE,
    ip: '192.168.1.50',
    id: 'c42996fffe0a1b2c',
    model: 'BSB003',
    scheme: 'https',
    certFingerprint: fingerprintOf(Buffer.from('cert')),
  };
  manager.identifiedBridges = async () => ({ bridges: [pro], ignored: [] });
  const { calls } = stubHttps((url, options) => ({
    body:
      options.method === 'POST'
        ? [{ success: { username: 'pro-key' } }]
        : { 7: { name: 'Salon', uniqueid: '00:17:88:01:aa' } },
    cn: pro.id,
  }));

  const result = await manager.pairBridges();
  assert.deepEqual(
    result.replaced.map(({ bridge, previous }) => [bridge.id, previous.id]),
    [['c42996fffe0a1b2c', 'b1']],
  );
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.url}`),
    ['POST https://192.168.1.50/api', 'GET https://192.168.1.50/api/pro-key/lights'],
    'the old username is never sent to the new bridge',
  );
  assert.deepEqual(
    store.list().map((bridge) => [bridge.id, bridge.ip, bridge.username, bridge.platformKey]),
    [['c42996fffe0a1b2c', '192.168.1.50', 'pro-key', 'b1']],
  );

  // Its lights come back under the same external_ids, whatever their new Hue ids.
  client.getLights = async () => ({ 7: client.light });
  await manager.syncDevices();
  assert.deepEqual([...manager.registry.keys()], [SALON_ID]);
  assert.equal(manager.registry.get(SALON_ID).hueId, '7');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  manager.stop();
  mock.restoreAll();
});

test('the username of a paired bridge is never sent to a new bridge', async () => {
  // The id a new bridge announces, and the certificate naming it, prove nothing.
  const { manager } = await makeLostBridgeManager();
  const { calls } = stubHttps(() => ({
    body: [{ error: { type: 101, description: 'link button not pressed' } }],
    cn: 'other',
  }));
  manager.identifiedBridges = async () => ({
    bridges: [
      { ...IDENTIFIED_BRIDGE, id: 'other', scheme: 'https', certFingerprint: fingerprintOf(Buffer.from('cert')) },
    ],
    ignored: [],
  });
  const result = await manager.pairBridges();
  assert.equal(result.pending.length, 1);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.url}`),
    ['POST https://192.168.1.42/api'],
  );
  manager.stop();
  mock.restoreAll();
});

test('a new bridge holding the lights of a bridge that no longer answers takes its place', async () => {
  // A replaced bridge: the bulbs keep their Zigbee MAC (uniqueid).
  const { manager, store } = await makeLostBridgeManager();
  manager.identifiedBridges = async () => ({ bridges: [IDENTIFIED_BRIDGE], ignored: [] });
  serveHttp((url, options) =>
    options.method === 'POST'
      ? [{ success: { username: 'new-key' } }]
      : url.includes('/new-key/')
        ? { 1: { name: 'Salon', uniqueid: '00:17:88:01:aa' } }
        : UNAUTHORIZED,
  );

  const result = await manager.pairBridges();
  assert.equal(result.replaced.length, 1);
  assert.deepEqual(
    store.list().map((bridge) => [bridge.id, bridge.username, bridge.platformKey]),
    [['abc', 'new-key', 'b1']],
  );
  manager.stop();
  mock.restoreAll();
});

test('after a replacement, no command reaches the new bridge with the Hue ids of the old one', async () => {
  // A migration renumbers the lights: /lights/3 was the kitchen on the old
  // bridge, it is the bedroom on the new one.
  const { manager, store } = await makeLostBridgeManager();
  assert.ok(manager.registry.has(SALON_ID));
  manager.identifiedBridges = async () => ({ bridges: [IDENTIFIED_BRIDGE], ignored: [] });
  serveHttp((url, options) =>
    options.method === 'POST' ? [{ success: { username: 'new-key' } }] : { 7: { uniqueid: '00:17:88:01:aa' } },
  );
  await manager.pairBridges();
  mock.restoreAll();
  assert.equal(store.list()[0].platformKey, 'b1');
  assert.equal(manager.registry.has(SALON_ID), false, 'read again from the new bridge before any command');
  manager.stop();
});

test('pairing again a forgotten bridge saved without an id is not announced as replacing itself', async () => {
  const { manager, gladys, store, client } = await makeManager();
  store.list()[0].id = undefined; // paired by 1.1.0 through the IP field
  await createAll(manager, gladys);
  client.down = true;
  await manager.syncDevices();
  silentForLong(manager);
  await manager.forgetUnreachableBridges();
  assert.deepEqual(store.forgotten, [{ ip: '192.168.1.10', platformKey: '192.168.1.10' }]);
  manager.identifiedBridges = async () => ({
    bridges: [{ ...IDENTIFIED_BRIDGE, id: 'b1', ip: '192.168.1.10' }],
    ignored: [],
  });
  serveHttp((url, options) =>
    options.method === 'POST' ? [{ success: { username: 'new-key' } }] : { 3: { uniqueid: '00:17:88:01:aa' } },
  );
  const result = await manager.pairBridges();
  mock.restoreAll();
  assert.deepEqual(result.replaced, []);
  assert.equal(store.list()[0].platformKey, '192.168.1.10', 'its key back, through upsert');
  manager.stop();
});

test('a paired bridge found at a new address gets no stored username when paired over plain HTTP', async () => {
  const { manager, store } = await makeLostBridgeManager();
  manager.identifiedBridges = async () => ({
    bridges: [{ ...IDENTIFIED_BRIDGE, id: 'b1', ip: '192.168.1.11' }],
    ignored: [],
  });
  const calls = serveHttp(() => [{ error: { type: 101, description: 'link button not pressed' } }]);
  const result = await manager.pairBridges();
  mock.restoreAll();
  assert.deepEqual(calls, ['POST http://192.168.1.11/api'], 'the link button, not the stored username');
  assert.equal(result.pending.length, 1);
  assert.equal(store.list()[0].username, 'user-1');
  manager.stop();
});

test('a new bridge holding the lights of a forgotten bridge takes its key back', async () => {
  const { manager, store } = await makeLostBridgeManager();
  silentForLong(manager);
  await manager.forgetUnreachableBridges();
  assert.equal(store.forgotten.length, 1);
  manager.identifiedBridges = async () => ({ bridges: [IDENTIFIED_BRIDGE], ignored: [] });
  serveHttp((url, options) =>
    options.method === 'POST' ? [{ success: { username: 'new-key' } }] : { 1: { uniqueid: '00:17:88:01:aa' } },
  );

  await manager.pairBridges();
  assert.deepEqual(
    store.list().map((bridge) => [bridge.id, bridge.platformKey]),
    [['abc', 'b1']],
  );
  assert.deepEqual(store.forgotten, []);
  manager.stop();
  mock.restoreAll();
});

test('bulbs moved from a bridge that was only busy do not make a new bridge replace it', async () => {
  // Half of bridge A's bulbs moved to a new bridge B (the 50-light limit), while
  // A answered 503 to the last scan: A must stay, with its other lights.
  const { manager, gladys, store, client } = await makeManager();
  await createAll(manager, gladys);
  failReads(client, { message: 'HTTP 503', httpStatus: 503 });
  await manager.syncDevices();
  assert.equal(manager.unreachable.size, 1);
  client.getLights = async () => ({ 3: client.light }); // answers again
  manager.identifiedBridges = async () => ({ bridges: [IDENTIFIED_BRIDGE], ignored: [] });
  serveHttp((url, options) =>
    options.method === 'POST' ? [{ success: { username: 'new-key' } }] : { 1: { uniqueid: '00:17:88:01:aa' } },
  );

  const result = await manager.pairBridges();
  assert.deepEqual(result.replaced, []);
  assert.deepEqual(
    store.list().map((bridge) => bridge.id),
    ['b1', 'abc'],
  );
  manager.stop();
  mock.restoreAll();
});

test("a bridge that just replaced another is not forgotten on the first click for the old one's silence", async () => {
  const { manager, store, client } = await makeLostBridgeManager();
  silentForLong(manager); // the old bridge has been silent for long
  manager.identifiedBridges = async () => ({ bridges: [IDENTIFIED_BRIDGE], ignored: [] });
  serveHttp((url, options) =>
    options.method === 'POST' ? [{ success: { username: 'new-key' } }] : { 1: { uniqueid: '00:17:88:01:aa' } },
  );
  await manager.pairBridges();
  mock.restoreAll();
  assert.equal(store.list()[0].id, 'abc');

  // The new bridge reboots for its first firmware update.
  const { forgotten } = await manager.forgetUnreachableBridges();
  assert.deepEqual(forgotten, []);
  assert.equal(client.down, true, 'the fake still does not answer');
  manager.stop();
});

test('a bulb moved from a working bridge to a new one does not merge the two bridges', async () => {
  const { manager, gladys, store } = await makeManager();
  await createAll(manager, gladys);
  await manager.syncDevices(); // b1 answers
  manager.identifiedBridges = async () => ({ bridges: [IDENTIFIED_BRIDGE], ignored: [] });
  serveHttp((url, options) =>
    options.method === 'POST' ? [{ success: { username: 'new-key' } }] : { 1: { uniqueid: '00:17:88:01:aa' } },
  );

  const result = await manager.pairBridges();
  assert.deepEqual(result.replaced, []);
  assert.deepEqual(
    store.list().map((bridge) => [bridge.id, bridge.platformKey]),
    [
      ['b1', undefined],
      ['abc', undefined],
    ],
  );
  mock.restoreAll();
});

test('clientFor carries the scheme and pinned certificate of an HTTPS bridge', async () => {
  // Without this, a bridge that only answers on TLS would be re-probed as HTTP
  // on every restart, and its pinned certificate would never be enforced.
  // A real manager: makeManager() replaces clientFor with a fake client.
  const manager = new HueManager(makeGladys(), { ...DEFAULT_CONFIG }, new BridgeStore('/tmp/unused-hue-store.json'));
  const client = manager.clientFor({
    ip: '192.168.1.42',
    username: 'granted-key',
    id: 'abc',
    scheme: 'https',
    certFingerprint: 'DEADBEEF',
  });

  assert.equal(client.scheme, 'https');
  assert.equal(client.certFingerprint, 'DEADBEEF');
  assert.equal(client.id, 'abc');
});

// The external_id makeManager()'s only light gets.
const SALON_ID = 'ext:test:light:b1-00:17:88:01:aa';

test('a bridge down at startup: its lights work as soon as it answers, without a manual scan', async () => {
  // After a power cut the container starts before the bridge. The registry
  // stayed empty and every command failed with "unknown light, run a scan"
  // until the user clicked something.
  const { manager, gladys, client } = await makeManager();
  client.down = true;
  await manager.syncDevices();
  assert.equal(manager.registry.size, 0);

  client.down = false;
  await manager.setValue({ external_id: SALON_ID }, { external_id: `${SALON_ID}:on-off` }, 1);
  assert.ok(client.lastSetState, 'the light was commanded');
  assert.equal(gladys.fake.connectionStatus.connected, true, 'the status recovered');
  manager.stop();
});

test('while its bridge is down, a light says so instead of "run a scan"', async () => {
  const { manager, client } = await makeManager();
  client.down = true;
  await manager.syncDevices();
  await assert.rejects(
    () => manager.setValue({ external_id: SALON_ID }, { external_id: `${SALON_ID}:on-off` }, 1),
    /unreachable/,
  );
  manager.stop();
});

test('an unreachable bridge is resynchronized in the background until it answers', async () => {
  const { manager, gladys, client } = await makeManager();
  client.down = true;
  await manager.syncDevices();
  assert.ok(manager.resyncTimer, 'a resync is scheduled');
  const scheduled = manager.resyncTimer;
  await manager.syncDevices();
  assert.equal(manager.resyncTimer, scheduled, 'never two resync loops at once');

  client.down = false;
  await manager.resync();
  assert.equal(gladys.fake.discoveredDevices.length, 1, 'the lights are published');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(manager.resyncTimer, undefined, 'the loop stops once everything answers');
});

test('stop() cancels the resync loop for good', async () => {
  const { manager, client } = await makeManager();
  client.down = true;
  await manager.syncDevices();
  manager.stop();
  assert.equal(manager.resyncTimer, undefined);
  await manager.syncDevices();
  assert.equal(manager.resyncTimer, undefined, 'nothing is rescheduled during shutdown');
});

test('the resync backoff grows exponentially, is capped, and is jittered', () => {
  assert.equal(nextResyncDelay(0, 1), 5000);
  assert.equal(nextResyncDelay(1, 1), 10000);
  assert.equal(nextResyncDelay(20, 1), 300000, 'capped at 5 minutes');
  assert.equal(nextResyncDelay(1, 0), 5000, 'never below half the step');
});

test('the status follows the bridge: false when a refresh cannot reach it, true when it answers again', async () => {
  // The status used to be computed at scan time only: a bridge dying an hour
  // later left "connected" on screen while every command failed.
  const { manager, gladys, client } = await makeManager();
  await manager.syncDevices();
  await createAll(manager, gladys);
  assert.equal(gladys.fake.connectionStatus.connected, true);

  client.down = true;
  await manager.pollLights();
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /unreachable/);
  assert.ok(manager.resyncTimer, 'a resync is scheduled');

  client.down = false;
  await manager.pollLights();
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(manager.resyncTimer, undefined);
});

test('the status is only sent when it changes', async () => {
  const { manager, gladys } = await makeManager();
  await manager.syncDevices();
  await createAll(manager, gladys);
  const sent = gladys.fake.connectionStatuses.length;
  await manager.pollLights();
  await manager.pollLights();
  assert.equal(gladys.fake.connectionStatuses.length, sent);
});

/**
 * A manager with a second bridge (192.168.1.20) and its own light, every
 * light created in Gladys, and the bridge reads counted.
 * @returns {Promise<object>} Manager, fake Gladys, both clients and their read counters.
 */
async function makeTwoBridges() {
  const { manager, gladys, client, store } = await makeManager();
  await store.upsert({ id: 'b2', ip: '192.168.1.20', username: 'user-2' });
  const other = makeFakeClient();
  manager.clientFor = (bridge) => (bridge.ip === '192.168.1.20' ? other : client);
  await createAll(manager, gladys);
  return { manager, gladys, client, other, reads: countReads(client), otherReads: countReads(other) };
}

test('the refresh loop reads each bridge once per interval and publishes its lights', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { manager, gladys, reads, otherReads } = await makeTwoBridges();
  manager.startPolling();

  t.mock.timers.tick(DEFAULT_CONFIG.poll_frequency - 1);
  await settle();
  assert.equal(reads.count, 0, 'nothing before the interval');

  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual([reads.count, otherReads.count], [1, 1], 'one request per bridge, not one per light');
  const onOff = gladys.fake.states.filter((s) => s.device_feature_external_id.endsWith(':on-off'));
  assert.deepEqual(onOff.map((s) => s.device_feature_external_id).sort(), [
    `${SALON_ID}:on-off`,
    'ext:test:light:b2-00:17:88:01:aa:on-off',
  ]);

  t.mock.timers.tick(DEFAULT_CONFIG.poll_frequency);
  await settle();
  assert.deepEqual([reads.count, otherReads.count], [2, 2], 'and again on the next interval');
  manager.stop();
});

test('a new refresh interval re-arms the loop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { manager, reads } = await makeTwoBridges();
  manager.startPolling(); // every 60 s
  t.mock.timers.tick(5000);

  manager.setConfig({ ...DEFAULT_CONFIG, poll_frequency: 10000 });
  t.mock.timers.tick(10000);
  await settle();
  assert.equal(reads.count, 1, 'refreshed 10 s after the change, not at the old 60 s');

  t.mock.timers.tick(10000);
  await settle();
  assert.equal(reads.count, 2);
  manager.stop();
});

/**
 * Give a fake client the v2 API of a square bridge: its light 3 is the v2
 * light `rid-3` of device `dev-3`, and the test writes to its event stream.
 * @param {object} client - Fake bridge client.
 * @returns {object} The same client, with `push(resources)` and its `streams`.
 */
function withPush(client) {
  client.switchToHttps = async () => {};
  client.isV2 = async () => true;
  client.getResources = async (type) =>
    type === 'light'
      ? [{ id: 'rid-3', id_v1: '/lights/3', owner: { rid: 'dev-3', rtype: 'device' }, type: 'light' }]
      : [{ id: 'zb-3', owner: { rid: 'dev-3', rtype: 'device' }, type: 'zigbee_connectivity' }];
  client.streams = [];
  client.openEventStream = async () => {
    const response = new PassThrough();
    const opened = { response, close: () => response.destroy() };
    client.streams.push(opened);
    return opened;
  };
  client.push = (resources) =>
    client.streams.at(-1).response.write(`id: 1:0\ndata: ${JSON.stringify([{ type: 'update', data: resources }])}\n\n`);
  return client;
}

// Let the stream connect, or a pushed message reach Gladys.
const flush = async () => {
  for (let step = 0; step < 10; step += 1) {
    await settle();
  }
};

/**
 * makeManager() with its light created, connected to Gladys with the event
 * stream of a square bridge open.
 * @param {object} t - Test context (its timers are mocked).
 * @returns {Promise<object>} Same as makeManager(), plus the on/off states published for the light.
 */
async function makePushManager(t) {
  const made = await makeManager();
  withPush(made.client);
  await createAll(made.manager, made.gladys);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  made.manager.startPolling();
  await flush();
  made.onOff = () =>
    made.gladys.fake.states
      .filter((state) => state.device_feature_external_id === `${SALON_ID}:on-off`)
      .map((state) => state.state);
  return made;
}

test('a change pushed by the bridge shows up at once, on the device the user created', async (t) => {
  // A dimmer, the Hue app or a Hue automation: until now it waited for the next
  // refresh, up to a minute.
  const { manager, client, onOff } = await makePushManager(t);
  assert.equal(client.streams.length, 1);
  client.push([{ id: 'rid-3', on: { on: true }, dimming: { brightness: 100 }, type: 'light' }]);
  await flush();
  assert.deepEqual(onOff(), [1]);
  const brightness = manager.gladys.fake.states.findLast(
    (state) => state.device_feature_external_id === `${SALON_ID}:brightness`,
  );
  assert.equal(brightness.state, 100);
  manager.stop();
});

test('pushed changes are merged, at most one publication per second', async (t) => {
  // A dimmer button held down sends a change every few hundred ms per light.
  const { manager, gladys, client } = await makePushManager(t);
  const brightness = () =>
    gladys.fake.states
      .filter((state) => state.device_feature_external_id === `${SALON_ID}:brightness`)
      .map((state) => state.state);
  client.light.state.bri = 254;
  for (const percent of [10, 20, 30]) {
    client.push([{ id: 'rid-3', dimming: { brightness: percent }, type: 'light' }]);
    await flush();
  }
  assert.deepEqual(brightness(), [10], 'the first change at once');
  t.mock.timers.tick(1000);
  await flush();
  assert.deepEqual(brightness(), [10, 30], 'the last one after a second, not each of them');
  manager.stop();
});

test('a light reported disconnected is shown off once a read confirms it, and back at once', async (t) => {
  const { manager, gladys, client, onOff } = await makePushManager(t);
  client.push([{ id: 'rid-3', on: { on: true }, type: 'light' }]);
  await flush();
  client.light.state = { ...client.light.state, on: true, reachable: false };

  client.push([{ id: 'zb-3', status: 'connectivity_issue', type: 'zigbee_connectivity' }]);
  t.mock.timers.tick(1000);
  await flush();
  assert.deepEqual(onOff(), [1], 'one report may be a mesh blip');
  await manager.pollLights();
  assert.deepEqual(onOff(), [1, 0]);
  assert.equal(gladys.fake.transports.at(-1).transport, 'unreachable');

  client.push([
    { id: 'zb-3', owner: { rid: 'dev-3', rtype: 'device' }, status: 'connected', type: 'zigbee_connectivity' },
  ]);
  t.mock.timers.tick(1000);
  await flush();
  assert.deepEqual(onOff(), [1, 0, 1]);
  assert.equal(gladys.fake.transports.at(-1).transport, 'local');
  manager.stop();
});

test('a refresh that read the lights before a pushed change does not undo it', async (t) => {
  const { manager, client, onOff } = await makePushManager(t);
  let answer;
  client.getLights = () =>
    new Promise((resolve) => {
      answer = () => resolve({ 3: structuredClone(client.light) }); // read while still off
    });
  const polled = manager.pollLights();
  await flush();
  client.push([{ id: 'rid-3', on: { on: true }, type: 'light' }]);
  await flush();
  answer();
  await polled;
  assert.deepEqual(onOff(), [1]);
  manager.stop();
});

test('the stream catches up on what changed while it was closed', async (t) => {
  const { manager, gladys, client, onOff } = await makePushManager(t);
  const reads = countReads(client);
  client.light.state.on = true;
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(reads.count, 1, 'one read of the bridge once the stream opened');
  assert.deepEqual(onOff(), [1]);

  client.light.state.on = false;
  client.streams[0].response.destroy(); // dropped
  await flush();
  t.mock.timers.tick(1000); // reconnected
  await flush();
  t.mock.timers.tick(1000); // read again
  await flush();
  assert.equal(client.streams.length, 2);
  assert.deepEqual(onOff(), [1, 0]);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  manager.stop();
});

test('a bridge without the v2 API is polled only, and asked again only once it moved', async (t) => {
  const { manager, gladys, store, client } = await makeManager();
  await createAll(manager, gladys);
  let asked = 0;
  client.isV2 = async () => {
    asked += 1;
    return false;
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  manager.startPolling();
  await flush();
  await manager.syncDevices();
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(asked, 1);
  assert.equal(manager.streams.size, 0);

  // Found at another address: what answered at the old one says nothing of it.
  store.list()[0].ip = '192.168.1.11';
  await manager.syncDevices();
  await flush();
  assert.equal(asked, 2);
  manager.stop();
});

test('a round bridge, which refuses HTTPS, is asked again later: a booting bridge refuses it too', async (t) => {
  const { manager, gladys, client } = await makeManager();
  await createAll(manager, gladys);
  let asked = 0;
  client.switchToHttps = async () => {
    asked += 1;
    throw Object.assign(new Error('connect ECONNREFUSED 192.168.1.10:443'), { code: 'ECONNREFUSED' });
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  manager.startPolling();
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(asked, 2);
  assert.equal(manager.streams.size, 1, 'still trying');
  manager.stop();
});

test('the stream of a forgotten bridge is closed, and every stream once disconnected from Gladys', async (t) => {
  const { manager, store, client } = await makePushManager(t);
  manager.stopPolling();
  assert.equal(client.streams[0].response.destroyed, true);

  manager.startPolling();
  await flush();
  assert.equal(client.streams.length, 2);
  await store.remove([store.list()[0]]);
  await manager.syncDevices();
  assert.equal(client.streams[1].response.destroyed, true);
  assert.equal(manager.streams.size, 0);
  manager.stop();
});

test('the push budget counts the states really sent, not the unchanged ones', async (t) => {
  // A dimming sends one state, not the four features of the light.
  const { manager, client } = await makePushManager(t);
  client.push([{ id: 'rid-3', on: { on: true }, type: 'light' }]);
  await flush();
  manager.pushedStates = [];
  t.mock.timers.tick(1000);
  await flush();
  client.push([{ id: 'rid-3', dimming: { brightness: 40 }, type: 'light' }]);
  await flush();
  assert.equal(manager.pushedStates.length, 1);
  manager.stop();
});

test('changes held back by the budget are dropped when the stream opens again, after newer values', async (t) => {
  const { manager, gladys, client } = await makePushManager(t);
  manager.pushedStates = Array.from({ length: 200 }, () => performance.now()); // budget spent
  client.push([{ id: 'rid-3', dimming: { brightness: 50 }, type: 'light' }]);
  await flush();
  client.streams[0].response.destroy(); // dropped; 70 % set in the Hue app meanwhile
  client.light.state = { ...client.light.state, on: true, bri: 178 };
  await flush();
  t.mock.timers.tick(1000); // reconnected
  await flush();
  manager.pushedStates = [];
  t.mock.timers.tick(1000); // catch-up read, and the budget is back
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  const brightness = gladys.fake.states
    .filter((state) => state.device_feature_external_id === `${SALON_ID}:brightness`)
    .map((state) => state.state);
  assert.equal(brightness.at(-1), 70);
  assert.ok(!brightness.includes(50), 'the held-back 50 % never overwrote it');
  manager.stop();
});

test('a pushed change after a connectivity blip does not show the light cut', async (t) => {
  // Only a second report of its connectivity, or a read, confirms the cut: a
  // dimming shows the light still talks to the bridge.
  const { manager, gladys, client, onOff } = await makePushManager(t);
  client.push([{ id: 'rid-3', on: { on: true }, type: 'light' }]);
  await flush();
  client.push([{ id: 'zb-3', status: 'connectivity_issue', type: 'zigbee_connectivity' }]);
  t.mock.timers.tick(1000);
  await flush();
  client.push([{ id: 'rid-3', dimming: { brightness: 40 }, type: 'light' }]);
  t.mock.timers.tick(1000);
  await flush();
  assert.deepEqual(onOff(), [1]);
  assert.notEqual(gladys.fake.transports.at(-1).transport, 'unreachable');
  manager.stop();
});

test('the pushed changes stay within their share of the Gladys budget, and a held-back change is not lost', async (t) => {
  const { manager, gladys, client } = await makePushManager(t);
  manager.pushedStates = Array.from({ length: 200 }, () => performance.now()); // budget spent
  const lightOn = () =>
    gladys.fake.states.some((state) => state.device_feature_external_id === `${SALON_ID}:on-off` && state.state === 1);
  client.push([{ id: 'rid-3', on: { on: true }, type: 'light' }]);
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(lightOn(), false, 'held back');

  manager.pushedStates = []; // a minute later
  t.mock.timers.tick(1000);
  await flush();
  const onOff = gladys.fake.states.findLast((state) => state.device_feature_external_id === `${SALON_ID}:on-off`);
  assert.equal(onOff.state, 1);
  manager.stop();
});

test('a command the bridge applied is not reported failed when Gladys refuses its echo', async (t) => {
  const { manager, gladys, client } = await makeManager();
  await createAll(manager, gladys);
  t.mock.method(gladys, 'publishChangedStates', async () => {
    throw new Error('HTTP 429 Too Many Requests');
  });
  await manager.setValue({ external_id: SALON_ID }, { external_id: `${SALON_ID}:on-off` }, 1);
  assert.equal(client.lastSetState.state.on, true);
});

test('a command dropped by a busy queue neither marks the bridge unreachable nor reopens its stream', async (t) => {
  const { manager, gladys, client } = await makePushManager(t);
  await manager.reportStatus(true);
  client.setLightState = async () => {
    throw Object.assign(new Error('Bridge 192.168.1.10 is busy: dropped after waiting 4100 ms'), {
      queueTimeout: true,
    });
  };
  await assert.rejects(() => manager.setValue({ external_id: SALON_ID }, { external_id: `${SALON_ID}:on-off` }, 1));
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(manager.unreachable.size, 0);
  assert.equal(client.streams[0].response.destroyed, false);
  manager.stop();
});

test('a command dropped by the queue of a silent bridge leaves its silence alone', async () => {
  // Unplugged: commands pile up behind requests that time out, and the ones
  // dropped must not make it look connected, nor restart its silence.
  const { manager, gladys, client } = await makeManager();
  await createAll(manager, gladys);
  client.down = true;
  await manager.pollLights();
  const since = manager.silentSince.get('b1');
  client.setLightState = async () => {
    throw Object.assign(new Error('Bridge 192.168.1.10 is busy: dropped after waiting 4000 ms'), {
      queueTimeout: true,
    });
  };
  await assert.rejects(() => manager.setValue({ external_id: SALON_ID }, { external_id: `${SALON_ID}:on-off` }, 1));
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.equal(manager.silentSince.get('b1'), since);
  manager.stop();
});

test('a bridge whose address now serves another certificate gets no stream, whatever step finds it', async (t) => {
  const { manager, gladys, client } = await makeManager();
  withPush(client);
  await createAll(manager, gladys);
  let asked = 0;
  client.isV2 = async () => {
    asked += 1;
    throw Object.assign(new Error('Refused the TLS certificate of 192.168.1.10'), { tlsRefused: true });
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  manager.startPolling();
  await flush();
  t.mock.timers.tick(120000);
  await flush();
  assert.equal(asked, 1);
  assert.equal(manager.streams.size, 0);
  manager.stop();
});

test('Forget probes the bridges out of their queue, where requests to a dead bridge are stuck', async () => {
  const { manager, client } = await makeManager();
  const overrides = [];
  manager.clientFor = (bridge, override = {}) => {
    overrides.push(override);
    return client;
  };
  await manager.forgetUnreachableBridges();
  const [probe] = overrides;
  assert.ok(probe.queue instanceof RequestQueue);
  assert.notEqual(probe.queue, manager.queueOf(manager.store.list()[0]));
});

test('a refresh that cannot reach the bridge opens its stream again', async (t) => {
  // A bridge powered off: TCP takes minutes to notice the stream is dead.
  const { manager, client } = await makePushManager(t);
  client.down = true;
  await manager.pollLights();
  assert.equal(client.streams[0].response.destroyed, true);
  client.down = false;
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(client.streams.length, 2);
  manager.stop();
});

test('a refresh slower than the interval never overlaps the next one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { manager, client, reads } = await makeTwoBridges();
  let answer;
  const getLights = client.getLights;
  client.getLights = function () {
    getLights.call(this);
    return new Promise((resolve) => {
      answer = resolve;
    });
  };
  manager.startPolling();

  t.mock.timers.tick(DEFAULT_CONFIG.poll_frequency);
  await settle();
  // A config change while it runs must not start a second loop either.
  manager.setConfig({ ...DEFAULT_CONFIG, poll_frequency: 10000 });
  t.mock.timers.tick(DEFAULT_CONFIG.poll_frequency * 3);
  await settle();
  assert.equal(reads.count, 1, 'still the first, hung, refresh');

  answer({ 3: client.light });
  await settle();
  t.mock.timers.tick(10000);
  await settle();
  assert.equal(reads.count, 2, 'the next one is armed once the first ended');
  manager.stop();
});

test('an unreachable bridge neither stops the other bridges nor the loop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { manager, gladys, client, otherReads } = await makeTwoBridges();
  client.down = true;
  manager.startPolling();

  t.mock.timers.tick(DEFAULT_CONFIG.poll_frequency);
  await settle();
  assert.equal(otherReads.count, 1);
  assert.ok(
    gladys.fake.states.some((s) => s.device_feature_external_id.startsWith('ext:test:light:b2-')),
    'the lights of the other bridge are published',
  );
  assert.equal(gladys.fake.connectionStatus.connected, false);

  // Only the refresh publishes states (the background resync of the bridge,
  // also due by then, reads it but publishes the device list).
  client.down = false;
  t.mock.timers.tick(DEFAULT_CONFIG.poll_frequency);
  await settle();
  assert.ok(
    gladys.fake.states.some((s) => s.device_feature_external_id === `${SALON_ID}:on-off`),
    'the loop goes on and picks the bridge up again',
  );
  manager.stop();
});

test('the refresh loop stops on disconnection, and a refresh in progress does not re-arm it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { manager, client, reads } = await makeTwoBridges();
  manager.startPolling();
  manager.stopPolling();
  assert.equal(manager.pollTimer, undefined, 'no timer left');
  t.mock.timers.tick(DEFAULT_CONFIG.poll_frequency * 2);
  await settle();
  assert.equal(reads.count, 0);

  // Disconnected while a refresh is waiting for the bridge.
  let answer;
  client.getLights = () =>
    new Promise((resolve) => {
      answer = resolve;
    });
  manager.startPolling();
  t.mock.timers.tick(DEFAULT_CONFIG.poll_frequency);
  await settle();
  manager.stopPolling();
  answer({ 3: client.light });
  await settle();
  assert.equal(manager.pollTimer, undefined, 'the refresh in progress did not re-arm');
});

test('stop() (shutdown) also stops the refresh loop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { manager, reads } = await makeTwoBridges();
  manager.startPolling();
  manager.stop();
  t.mock.timers.tick(DEFAULT_CONFIG.poll_frequency * 2);
  await settle();
  assert.equal(reads.count, 0);
  assert.equal(manager.pollTimer, undefined);
});

test('a command the bridge refuses does not mark the bridge unreachable', async () => {
  const { manager, gladys, client } = await makeManager();
  await manager.syncDevices();
  client.setLightState = async () => {
    const error = new Error('Bridge refused: device is off');
    error.hueErrorType = 201;
    throw error;
  };
  await assert.rejects(() => manager.setValue({ external_id: SALON_ID }, { external_id: `${SALON_ID}:on-off` }, 1));
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(manager.resyncTimer, undefined);
});

/**
 * Give a fake client one room with two scenes, both setting its light 3.
 * @param {object} client - Fake bridge client.
 * @returns {object} The same client, recording the recalled scenes.
 */
function withScenes(client) {
  client.recalled = [];
  client.getGroups = async () => ({ 1: { name: 'Salon', type: 'Room' } });
  client.getScenes = async () => ({
    s1: { name: 'Détente', type: 'GroupScene', group: '1', lights: ['3'] },
    s2: { name: 'Lecture', type: 'GroupScene', group: '1', lights: ['3'] },
  });
  client.recallScene = async (groupId, sceneId) => {
    client.recalled.push({ groupId, sceneId });
    Object.assign(client.light.state, { on: true, bri: 254 });
    return [{ success: true }];
  };
  return client;
}

test('activateScene recalls the named scene on its room', async () => {
  const { manager, client } = await makeManager();
  withScenes(client);
  await manager.activateScene({ scene: 'détente', room: 'Salon' });
  assert.deepEqual(client.recalled, [{ groupId: '1', sceneId: 's1' }]);
});

test('activateScene refreshes the lights of the scene right away', async () => {
  const { manager, gladys, client } = await makeManager();
  withScenes(client);
  await manager.syncDevices();
  let reads = 0;
  const getLights = client.getLights;
  client.getLights = async function () {
    reads += 1;
    return getLights.call(this);
  };
  await manager.activateScene({ scene: 'Détente' });
  await new Promise(setImmediate); // the refresh runs after the ack
  const onOff = gladys.fake.states.find((s) => s.device_feature_external_id === `${SALON_ID}:on-off`);
  assert.equal(onOff.state, 1);
  assert.equal(reads, 1, 'one read of the bridge, not one per light');
});

test('activateScene still succeeds when the refresh after it fails', async () => {
  const { manager, client } = await makeManager();
  withScenes(client);
  await manager.syncDevices();
  client.getLights = async () => {
    throw new Error('connect EHOSTUNREACH');
  };
  await manager.activateScene({ scene: 'Détente' });
  await new Promise(setImmediate);
  assert.equal(client.recalled.length, 1);
  manager.stop();
});

test('activateScene does not wait for the refresh before answering', async () => {
  const { manager, client } = await makeManager();
  withScenes(client);
  await manager.syncDevices();
  client.getLights = () => new Promise(() => {}); // a bridge busy with the transition
  await manager.activateScene({ scene: 'Détente' });
  assert.equal(client.recalled.length, 1);
});

test('activateScene reads every bridge at once', async () => {
  const { manager, client, store } = await makeManager();
  withScenes(client);
  await store.upsert({ id: 'b2', ip: '192.168.1.20', username: 'user-2' });
  const started = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const slow = withScenes(makeFakeClient());
  slow.getScenes = async () => {
    started.push('192.168.1.20');
    await gate;
    return {};
  };
  const getScenes = client.getScenes;
  client.getScenes = async () => {
    started.push('192.168.1.10');
    await gate;
    return getScenes();
  };
  manager.clientFor = (bridge) => (bridge.ip === '192.168.1.20' ? slow : client);

  const done = manager.activateScene({ scene: 'Lecture' });
  await new Promise(setImmediate);
  assert.deepEqual(started.sort(), ['192.168.1.10', '192.168.1.20']);
  release();
  await done;
  assert.deepEqual(client.recalled, [{ groupId: '1', sceneId: 's2' }]);
});

test('activateScene gives the real reason of a bridge that answered with an error', async () => {
  const { manager, client, store } = await makeManager();
  withScenes(client);
  await store.upsert({ id: 'b2', ip: '192.168.1.20', username: 'user-2' });
  const refusing = makeFakeClient();
  refusing.getGroups = async () => {
    const error = new Error('Bridge 192.168.1.20 refused /api/***/groups: unauthorized user');
    error.hueErrorType = 1;
    throw error;
  };
  refusing.getScenes = async () => ({});
  manager.clientFor = (bridge) => (bridge.ip === '192.168.1.20' ? refusing : client);

  await assert.rejects(
    () => manager.activateScene({ scene: 'Cinéma' }),
    (error) => /unauthorized user\)$/.test(error.message) && !/unreachable/.test(error.message),
  );
});

test('activateScene fails with the available scenes when the name is unknown', async () => {
  const { manager, client } = await makeManager();
  withScenes(client);
  await assert.rejects(() => manager.activateScene({ scene: 'Cinéma' }), /Available scenes: Détente, Lecture/);
  assert.equal(client.recalled.length, 0);
});

test('activateScene fails when no bridge is paired', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hue-mgr-'));
  const store = new BridgeStore(path.join(dir, 'bridges.json'));
  await store.load();
  const manager = new HueManager(makeGladys(), { ...DEFAULT_CONFIG }, store);
  await assert.rejects(() => manager.activateScene({ scene: 'Détente' }), /No Hue bridge paired yet/);
});

test('activateScene finds the scene on the bridge that answers, and names the one that does not', async () => {
  const { manager, client, store } = await makeManager();
  withScenes(client);
  await store.upsert({ id: 'b2', ip: '192.168.1.20', username: 'user-2' });
  const down = makeFakeClient();
  down.down = true;
  down.getGroups = down.getLights;
  down.getScenes = down.getLights;
  manager.clientFor = (bridge) => (bridge.ip === '192.168.1.20' ? down : client);

  await manager.activateScene({ scene: 'Lecture' });
  assert.deepEqual(client.recalled, [{ groupId: '1', sceneId: 's2' }]);
  await assert.rejects(
    () => manager.activateScene({ scene: 'Cinéma' }),
    /not found.*\(Hue bridge 192\.168\.1\.20 unreachable\)$/,
  );
  manager.stop();
});

test('activateScene fails the action when the bridge refuses the scene', async () => {
  const { manager, client } = await makeManager();
  withScenes(client);
  client.recallScene = async () => {
    const error = new Error('Bridge refused: resource not available');
    error.hueErrorType = 3;
    throw error;
  };
  await assert.rejects(() => manager.activateScene({ scene: 'Détente' }), /resource not available/);
});

test('a light cut at the wall gets the unreachable badge, and local once it is back', async () => {
  const { manager, gladys, client } = await makeManager();
  const deviceId = await createAll(manager, gladys);
  client.getLights = async () => ({ 3: structuredClone(client.light) }); // a fresh object per read

  await manager.pollLights();
  assert.deepEqual(gladys.fake.transports, [{ device_external_id: deviceId, transport: 'local' }]);
  await manager.pollLights();
  assert.equal(gladys.fake.transports.length, 1, 'an unchanged badge is not sent again');

  client.light.state = { ...client.light.state, on: true, reachable: false };
  await manager.pollLights();
  await manager.pollLights(); // two reads in a row
  assert.deepEqual(gladys.fake.transports.at(-1), { device_external_id: deviceId, transport: 'unreachable' });
  const onOff = gladys.fake.states.findLast((s) => s.device_feature_external_id === `${deviceId}:on-off`);
  assert.equal(onOff.state, 0, 'the bridge says on, but the bulb has no power');

  client.light.state = { ...client.light.state, reachable: true };
  await manager.pollLights();
  assert.deepEqual(gladys.fake.transports.at(-1), { device_external_id: deviceId, transport: 'local' });
});

test('the badge is sent again once forgotten (device event, reconnection)', async () => {
  const { manager, gladys } = await makeManager();
  const deviceId = await createAll(manager, gladys);
  await manager.pollLights();

  manager.forgetTransports(deviceId);
  await manager.pollLights();
  manager.forgetTransports();
  await manager.pollLights();
  assert.equal(gladys.fake.transports.length, 3);
});

test('no badge is sent for a light not created in Gladys', async () => {
  const { manager, gladys, store } = await makeManager();
  await manager.buildDiscoveredDevices();
  const [entry] = manager.registry.values();
  await manager.refreshLights(store.list()[0], manager.clientFor(), [entry.hueId]);
  assert.deepEqual(gladys.fake.transports, []);
});

test('a failed badge does not fail the refresh, and is retried', async () => {
  const { manager, gladys } = await makeManager();
  const deviceId = await createAll(manager, gladys);
  const publish = mock.method(gladys, 'publishTransports', async () => {
    throw new Error('HTTP 500');
  });
  await manager.pollLights();
  assert.ok(gladys.fake.states.some((s) => s.device_feature_external_id === `${deviceId}:on-off`));

  publish.mock.restore();
  await manager.pollLights();
  assert.deepEqual(gladys.fake.transports, [{ device_external_id: deviceId, transport: 'local' }]);
});

/**
 * A manager with two paired bridges, each with its own fake client.
 * @returns {Promise<object>} Manager, fake Gladys, store and clients by IP.
 */
async function makeTwoBridgeManager() {
  const { manager, gladys, store } = await makeManager();
  await store.upsert({ id: 'b2', ip: '192.168.1.20', username: 'user-2' });
  const clients = { '192.168.1.10': makeFakeClient(), '192.168.1.20': makeFakeClient() };
  manager.clientFor = (bridge) => clients[bridge.ip];
  return { manager, gladys, store, clients };
}

test('forgetUnreachableBridges drops the bridges that no longer answer, and only them', async () => {
  // The old bridge after a migration to a Bridge Pro: without this it stays
  // stored forever, reported unreachable and retried in the background.
  const { manager, gladys, store, clients } = await makeTwoBridgeManager();
  clients['192.168.1.20'].down = true;
  await manager.syncDevices();
  assert.equal(gladys.fake.connectionStatus.connected, false);

  silentForLong(manager);
  const { forgotten, kept } = await manager.forgetUnreachableBridges();
  assert.deepEqual(
    forgotten.map((bridge) => bridge.ip),
    ['192.168.1.20'],
  );
  assert.deepEqual(
    kept.map((bridge) => bridge.ip),
    ['192.168.1.10'],
  );
  assert.deepEqual(
    store.list().map((bridge) => bridge.ip),
    ['192.168.1.10'],
  );
  assert.equal(gladys.fake.connectionStatus.connected, true, 'no longer reported unreachable');
  assert.equal(manager.resyncTimer, undefined, 'the background resync stopped');
  assert.ok([...manager.registry.values()].every((entry) => entry.bridgeIp === '192.168.1.10'));

  const reopened = new BridgeStore(store.file);
  await reopened.load();
  assert.equal(reopened.list().length, 1, 'the removal survives a restart');
  manager.stop();
});

test('forgetUnreachableBridges keeps every bridge that answers', async () => {
  const { manager, store } = await makeTwoBridgeManager();
  const { forgotten } = await manager.forgetUnreachableBridges();
  assert.deepEqual(forgotten, []);
  assert.equal(store.list().length, 2);
});

test('forgetting the only bridge clears the Discovery tab', async () => {
  const { manager, gladys, client } = await makeManager();
  await manager.syncDevices();
  assert.equal(gladys.fake.discoveredDevices.length, 1);

  client.down = true;
  await manager.syncDevices();
  silentForLong(manager);
  await manager.forgetUnreachableBridges();
  assert.deepEqual(gladys.fake.discoveredDevices, []);
  assert.match(gladys.fake.connectionStatus.message.en, /No Hue bridge paired/);
  manager.stop();
});

/**
 * Make a fake client fail its reads with a given error.
 * @param {object} client - Fake bridge client.
 * @param {Partial<Error & { httpStatus: number, hueErrorType: number }>} fields - Error fields.
 */
function failReads(client, fields) {
  client.getLights = async () => {
    throw Object.assign(new Error(fields.message || 'failed'), fields);
  };
}

test('a busy bridge is never forgotten, a reset one is', async () => {
  // A bridge under load answers 503: forgetting it would cost the user a new
  // pairing. One that no longer knows our username (reset, migrated) is gone.
  const { manager, store, clients } = await makeTwoBridgeManager();
  failReads(clients['192.168.1.10'], { message: 'HTTP 503', httpStatus: 503 });
  failReads(clients['192.168.1.20'], { message: 'unauthorized user', hueErrorType: 1 });

  const { forgotten, busy } = await manager.forgetUnreachableBridges();
  assert.deepEqual(
    forgotten.map((bridge) => bridge.ip),
    ['192.168.1.20'],
  );
  assert.deepEqual(
    busy.map((bridge) => bridge.ip),
    ['192.168.1.10'],
  );
  assert.deepEqual(
    store.list().map((bridge) => bridge.ip),
    ['192.168.1.10'],
  );
  manager.stop();
});

test('a refresh still in flight when its bridge is forgotten does not bring it back', async () => {
  const { manager, gladys, clients } = await makeTwoBridgeManager();
  await createAll(manager, gladys);
  let failRead;
  clients['192.168.1.20'].getLights = () =>
    new Promise((resolve, reject) => {
      failRead = () => reject(new Error('connect EHOSTUNREACH'));
    });
  const poll = manager.pollLights();
  await settle();
  clients['192.168.1.20'].down = true;
  const dead = clients['192.168.1.20'];
  dead.getLights = async () => {
    throw new Error('connect EHOSTUNREACH');
  };
  manager.unreachable.add('b2'); // it was already failing
  manager.silentSince.set('b2', performance.now() - 10 * 60 * 1000);

  await manager.forgetUnreachableBridges();
  failRead();
  await poll;
  assert.equal(manager.unreachable.size, 0);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(manager.resyncTimer, undefined);
  manager.stop();
});

test('with no bridge left, nothing stays unreachable', async () => {
  const { manager, client, store } = await makeManager();
  client.down = true;
  await manager.syncDevices();
  assert.equal(manager.unreachable.size, 1);

  store.bridges.length = 0;
  await manager.syncDevices();
  assert.equal(manager.unreachable.size, 0);
  assert.equal(manager.resyncTimer, undefined);
  manager.stop();
});

test('Forget still reports what it did when the resync after it fails', async () => {
  const { manager, gladys, client } = await makeManager();
  client.down = true;
  await manager.syncDevices();
  mock.method(gladys, 'publishDiscoveredDevices', async () => {
    throw new Error('HTTP 500');
  });
  try {
    silentForLong(manager);
    const { forgotten } = await manager.forgetUnreachableBridges();
    assert.equal(forgotten.length, 1);
    assert.match(gladys.fake.connectionStatus.message.en, /No Hue bridge paired/, 'the status was still reported');
  } finally {
    mock.restoreAll();
    manager.stop();
  }
});

test('the lights of a forgotten bridge, and of a bridge that does not answer, get the unreachable badge', async () => {
  const { manager, gladys, clients } = await makeTwoBridgeManager();
  await createAll(manager, gladys);
  await manager.pollLights();
  const transportOf = (ip) =>
    gladys.fake.transports.findLast((entry) =>
      entry.device_external_id.includes(ip === '192.168.1.10' ? ':b1-' : ':b2-'),
    ).transport;
  assert.equal(transportOf('192.168.1.10'), 'local');

  clients['192.168.1.10'].down = true;
  await manager.pollLights();
  assert.equal(transportOf('192.168.1.10'), 'unreachable', 'its bridge does not answer');
  clients['192.168.1.10'].down = false;
  await manager.pollLights();
  assert.equal(transportOf('192.168.1.10'), 'local', 'back with its bridge');

  clients['192.168.1.20'].down = true;
  await manager.pollLights();
  manager.forgetTransports();
  silentForLong(manager);
  await manager.forgetUnreachableBridges();
  assert.equal(transportOf('192.168.1.20'), 'unreachable', 'nothing will refresh it again');
  manager.stop();
});

test('a badge forgotten while it is being sent is sent again', async () => {
  const { manager, gladys } = await makeManager();
  const deviceId = await createAll(manager, gladys);
  const publish = gladys.publishTransports.bind(gladys);
  mock.method(gladys, 'publishTransports', async (batch) => {
    manager.forgetTransports(deviceId); // the user updates the device meanwhile
    return publish(batch);
  });
  await manager.pollLights();
  mock.restoreAll();
  await manager.pollLights();
  assert.equal(gladys.fake.transports.length, 2);
});

test('a command to a light cut at the wall does not show it on', async () => {
  // The bridge accepts it, but the bulb has no power.
  const { manager, gladys, client } = await makeManager();
  const deviceId = await createAll(manager, gladys);
  client.light.state = { ...client.light.state, on: false, reachable: false };
  await manager.pollLights();
  const before = gladys.fake.states.length;

  await manager.setValue({ external_id: deviceId }, { external_id: `${deviceId}:on-off` }, 1);
  await manager.setValue({ external_id: deviceId }, { external_id: `${deviceId}:brightness` }, 50);
  const echoed = gladys.fake.states.slice(before);
  assert.ok(echoed.every((state) => state.device_feature_external_id !== `${deviceId}:on-off`));
  assert.ok(echoed.some((state) => state.device_feature_external_id === `${deviceId}:brightness`));
});

test('an address now answering 401 is forgotten: whatever answers is not the bridge', async () => {
  // DHCP gave the old bridge's address to a camera. A Hue bridge reports its
  // own errors as HTTP 200, so a 401/403/405 never comes from it.
  const { manager, store, client } = await makeManager();
  failReads(client, { message: 'HTTP 401', httpStatus: 401 });
  const { forgotten, busy } = await manager.forgetUnreachableBridges();
  assert.equal(forgotten.length, 1);
  assert.deepEqual(busy, []);
  assert.deepEqual(store.list(), []);
  manager.stop();
});

test('a bridge that misses one probe while it was working is kept', async () => {
  // It may be rebooting for a firmware update: forgetting it would cost a new pairing.
  const { manager, store, client } = await makeManager();
  await manager.syncDevices();
  client.down = true;
  const first = await manager.forgetUnreachableBridges();
  assert.deepEqual(first.forgotten, []);
  assert.equal(first.busy.length, 1);
  assert.equal(store.list().length, 1);

  await manager.syncDevices(); // still down on the next read
  silentForLong(manager);
  const second = await manager.forgetUnreachableBridges();
  assert.equal(second.forgotten.length, 1);
  manager.stop();
});

test('after a restart, the created lights of a bridge that does not answer get the unreachable badge', async () => {
  // The registry is empty: only gladys.devices knows these lights.
  const { manager, gladys, client } = await makeManager();
  const deviceId = 'ext:test:light:b1-00:17:88:01:aa';
  gladys.devices = [{ external_id: deviceId }, { external_id: 'ext:test:light:b10-00:17:88:01:aa' }];
  client.down = true;
  await manager.syncDevices();
  assert.deepEqual(gladys.fake.transports, [{ device_external_id: deviceId, transport: 'unreachable' }]);

  manager.forgetTransports();
  silentForLong(manager);
  await manager.forgetUnreachableBridges();
  assert.deepEqual(gladys.fake.transports.at(-1), { device_external_id: deviceId, transport: 'unreachable' });
  assert.equal(gladys.fake.transports.length, 2, 'not the lights of another bridge');
  manager.stop();
});

test('a failure to publish the states does not mark the lights of a bridge that answered unreachable', async () => {
  const { manager, gladys } = await makeManager();
  const deviceId = await createAll(manager, gladys);
  mock.method(gladys, 'publishChangedStates', async () => {
    throw Object.assign(new Error('Too Many Requests'), { status: 429 });
  });
  try {
    await manager.pollLights();
    assert.deepEqual(gladys.fake.transports, [{ device_external_id: deviceId, transport: 'local' }]);
  } finally {
    mock.restoreAll();
  }
});

test('calls in flight when a bridge is forgotten neither bring it back nor overwrite its badge', async () => {
  const { manager, gladys, store, client } = await makeManager();
  const deviceId = await createAll(manager, gladys);
  const [bridge] = store.list();
  let answer;
  client.getLights = () =>
    new Promise((resolve) => {
      answer = () => resolve({ 3: { ...client.light, state: { ...client.light.state, on: true } } });
    });
  const refresh = manager.pollLights();
  await settle();
  await store.remove([bridge]);
  answer();
  await refresh;
  assert.deepEqual(gladys.fake.states, [], 'no state for a forgotten bridge');
  assert.deepEqual(gladys.fake.transports, []);

  // The id learned, or the HTTPS switch finished, after the removal.
  client.getConfig = async () => ({ bridgeid: '001788FFFE1234AB', modelid: 'BSB002', apiversion: '1.63.0' });
  await manager.learnBridgeId(bridge, client);
  const upgraded = HueManager.prototype.clientFor.call(manager, bridge);
  await upgraded.onHttpsUpgrade({ scheme: 'https' });
  assert.deepEqual(store.list(), []);
  assert.ok(deviceId);
});

test('after Forget, the Discovery tab drops the forgotten lights, and keeps those of a busy bridge', async () => {
  const { manager, gladys, clients } = await makeTwoBridgeManager();
  await manager.syncDevices();
  assert.equal(gladys.fake.discoveredDevices.length, 2);

  failReads(clients['192.168.1.10'], { message: 'HTTP 503', httpStatus: 503 });
  clients['192.168.1.20'].down = true;
  await manager.syncDevices();
  silentForLong(manager);
  await manager.forgetUnreachableBridges();
  // 192.168.1.10 answers 503 but stays paired: its lights stay listed.
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((device) => device.external_id),
    ['ext:test:light:b1-00:17:88:01:aa'],
  );
  manager.stop();
});

test('forgetting a bridge leaves alone another stored bridge at the same address', async () => {
  // The DHCP reservation moved to the Bridge Pro; the old bridge's pinned
  // certificate no longer matches, so its reads fail without an answer.
  const { manager, gladys, store } = await makeManager();
  await store.upsert({ id: 'b2', ip: '192.168.1.10', username: 'user-2' });
  const good = makeFakeClient();
  const old = makeFakeClient();
  manager.clientFor = (bridge) => (bridge.id === 'b2' ? good : old);
  await createAll(manager, gladys);
  failReads(old, { message: 'Refused the TLS certificate of 192.168.1.10', tlsRefused: true });
  await manager.pollLights();
  const before = gladys.fake.transports.length;

  const first = await manager.forgetUnreachableBridges();
  assert.deepEqual(first.forgotten, [], 'it may only be rebooting');
  silentForLong(manager);
  const { forgotten } = await manager.forgetUnreachableBridges();
  assert.deepEqual(
    forgotten.map((bridge) => bridge.id),
    ['b1'],
  );
  assert.ok(manager.registry.has('ext:test:light:b2-00:17:88:01:aa'));
  assert.ok(gladys.fake.transports.slice(before).every((entry) => entry.transport === 'local'));
  manager.stop();
});

test('a light is shown cut at the wall only after two reads in a row', async () => {
  // Hue's `reachable` flaps for bulbs at the edge of the mesh.
  const { manager, gladys, client } = await makeManager();
  const deviceId = await createAll(manager, gladys);
  client.getLights = async () => ({ 3: structuredClone(client.light) });
  const onOff = () => gladys.fake.states.findLast((s) => s.device_feature_external_id === `${deviceId}:on-off`).state;
  client.light.state = { ...client.light.state, on: true, reachable: true };
  await manager.pollLights();
  assert.equal(onOff(), 1);

  client.light.state = { ...client.light.state, reachable: false };
  await manager.pollLights();
  assert.equal(onOff(), 1, 'a single blip');
  assert.equal(gladys.fake.transports.at(-1).transport, 'local');
  await manager.pollLights();
  assert.equal(onOff(), 0);
  assert.equal(gladys.fake.transports.at(-1).transport, 'unreachable');
});

test('a command to a light cut at the wall reads it again, in case its power came back', async (t) => {
  const { manager, gladys, client } = await makeManager();
  const deviceId = await createAll(manager, gladys);
  client.getLights = async () => ({ 3: structuredClone(client.light) });
  client.light.state = { ...client.light.state, on: false, reachable: false };
  await manager.pollLights();
  await manager.pollLights();

  t.mock.timers.enable({ apis: ['setTimeout'] });
  client.light.state = { ...client.light.state, reachable: true }; // switched back on
  await manager.setValue({ external_id: deviceId }, { external_id: `${deviceId}:on-off` }, 1);
  t.mock.timers.tick(1000);
  await settle();
  const onOff = gladys.fake.states.findLast((s) => s.device_feature_external_id === `${deviceId}:on-off`);
  assert.equal(onOff.state, 1);
  assert.equal(gladys.fake.transports.at(-1).transport, 'local');
});

test('commands to several lights cut at the wall share one read of their bridge', async (t) => {
  // A scene switching on six unpowered lamps used to send six full reads at
  // once, on top of its six commands.
  const { manager, gladys, client } = await makeManager();
  client.getLights = async () => ({
    3: structuredClone(client.light),
    4: { ...structuredClone(client.light), uniqueid: '00:17:88:01:bb' },
  });
  const [first, second] = [await createAll(manager, gladys), gladys.devices[1].external_id];
  client.light.state = { ...client.light.state, on: false, reachable: false };
  await manager.pollLights();
  await manager.pollLights();
  const reads = countReads(client);

  t.mock.timers.enable({ apis: ['setTimeout'] });
  await manager.setValue({ external_id: first }, { external_id: `${first}:on-off` }, 1);
  await manager.setValue({ external_id: second }, { external_id: `${second}:on-off` }, 1);
  assert.equal(reads.count, 0, 'not right away');
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(reads.count, 1);
});

test('a bridge that answered 503, then misses the probe, is not forgotten on the first click', async () => {
  // A 503 during a scan marks it unreachable, but it did answer: it may be
  // installing firmware, then rebooting.
  const { manager, store, client } = await makeManager();
  failReads(client, { message: 'HTTP 503', httpStatus: 503 });
  await manager.syncDevices();
  assert.equal(manager.unreachable.size, 1);

  client.getLights = async () => {
    throw new Error('connect ETIMEDOUT');
  };
  const { forgotten, busy } = await manager.forgetUnreachableBridges();
  assert.deepEqual(forgotten, []);
  assert.equal(busy.length, 1);
  assert.equal(store.list().length, 1);
  manager.stop();
});

test('a bridge nothing else reads is recorded by the probe, and forgotten on the next click', async () => {
  // No created light: neither the refresh loop nor the resync reads it.
  const { manager, gladys, store, clients } = await makeTwoBridgeManager();
  await manager.syncDevices();
  clients['192.168.1.20'].down = true;
  await manager.pollLights();

  const first = await manager.forgetUnreachableBridges();
  assert.deepEqual(first.forgotten, []);
  assert.equal(gladys.fake.connectionStatus.connected, false, 'now reported unreachable');
  silentForLong(manager);
  const second = await manager.forgetUnreachableBridges();
  assert.deepEqual(
    second.forgotten.map((bridge) => bridge.ip),
    ['192.168.1.20'],
  );
  assert.equal(store.list().length, 1);
  manager.stop();
});

test('the resync after Forget reuses the probe instead of reading the bridges again', async () => {
  // A silent bridge costs ~16 s per read: reading it twice exceeds the action's 30 s.
  const { manager, clients } = await makeTwoBridgeManager();
  clients['192.168.1.20'].down = true;
  await manager.syncDevices();
  const reads = { a: countReads(clients['192.168.1.10']), b: countReads(clients['192.168.1.20']) };

  silentForLong(manager);
  const { forgotten } = await manager.forgetUnreachableBridges();
  assert.equal(forgotten.length, 1);
  assert.deepEqual([reads.a.count, reads.b.count], [1, 1]);
  manager.stop();
});

test('a badge whose publication failed is sent again, even if Gladys applied it', async () => {
  // A request that timed out may still have been applied: the cache must not
  // go back to the previous value.
  const { manager, gladys, client } = await makeManager();
  const deviceId = await createAll(manager, gladys);
  await manager.pollLights();
  client.down = true;
  const publish = gladys.publishTransports.bind(gladys);
  mock.method(gladys, 'publishTransports', async (batch) => {
    await publish(batch);
    throw new Error('timeout');
  });
  await manager.pollLights();
  mock.restoreAll();
  assert.equal(gladys.fake.transports.at(-1).transport, 'unreachable');

  client.down = false;
  await manager.pollLights();
  assert.deepEqual(gladys.fake.transports.at(-1), { device_external_id: deviceId, transport: 'local' });
  manager.stop();
});

test('a failed badge of a forgotten bridge is sent again by the next poll', async () => {
  // Nothing refreshes the lights of a forgotten bridge any more.
  const { manager, gladys, client } = await makeManager();
  const deviceId = await createAll(manager, gladys);
  await manager.pollLights();
  failReads(client, { message: 'unauthorized user', hueErrorType: 1 });
  mock.method(gladys, 'publishTransports', async () => {
    throw new Error('HTTP 503');
  });
  await manager.forgetUnreachableBridges();
  mock.restoreAll();
  assert.equal(gladys.fake.transports.at(-1).transport, 'local');

  await manager.pollLights();
  assert.deepEqual(gladys.fake.transports.at(-1), { device_external_id: deviceId, transport: 'unreachable' });
  manager.stop();
});

test('an unexpected bridge body never makes a refresh reject', async () => {
  // Scene and command callers do not await it: a rejection would stop the process.
  const { manager, gladys, store, client } = await makeManager();
  const deviceId = await createAll(manager, gladys);
  client.getLights = async () => null;
  const [entry] = manager.registry.values();
  await manager.refreshLights(store.list()[0], client, [entry.hueId]);
  assert.ok(deviceId);
});

test('a bridge that has only just stopped answering is not forgotten, even after a failed poll', async () => {
  // A firmware update reboots it for 1 to 2 minutes.
  const { manager, gladys, store, client } = await makeManager();
  await createAll(manager, gladys);
  client.down = true;
  await manager.pollLights();
  const first = await manager.forgetUnreachableBridges();
  assert.deepEqual(first.forgotten, []);
  assert.equal(store.list().length, 1);

  silentForLong(manager);
  const second = await manager.forgetUnreachableBridges();
  assert.equal(second.forgotten.length, 1);
  manager.stop();
});

/**
 * A dead bridge b1 and a working one b2 stored at the same address (the DHCP
 * reservation moved to the new bridge), each with a light of Hue id 3.
 * @returns {Promise<object>} Manager, fake Gladys, store and both clients.
 */
async function makeSharedIpManager() {
  const { manager, gladys, store } = await makeManager();
  await store.upsert({ id: 'b2', ip: '192.168.1.10', username: 'user-2' });
  const clients = { b1: makeFakeClient(), b2: makeFakeClient() };
  clients.b2.light.state = { ...clients.b2.light.state, on: true };
  manager.clientFor = (bridge) => clients[bridge.id];
  await createAll(manager, gladys);
  clients.b1.down = true;
  return { manager, gladys, store, clients };
}

test('a working bridge sharing the address of a dead one is not forgotten for one missed probe', async () => {
  const { manager, clients } = await makeSharedIpManager();
  await manager.pollLights();
  silentForLong(manager); // only b1 is silent
  clients.b2.down = true; // one blip during the probe

  const { forgotten } = await manager.forgetUnreachableBridges();
  assert.deepEqual(
    forgotten.map((bridge) => bridge.id),
    ['b1'],
  );
  manager.stop();
});

test('the refresh of a bridge only covers its own lights, not those of another bridge at its address', async () => {
  const { manager, gladys } = await makeSharedIpManager();
  const deadLight = 'ext:test:light:b1-00:17:88:01:aa';
  for (let poll = 0; poll < 3; poll += 1) {
    await manager.pollLights();
  }
  const badges = gladys.fake.transports.filter((entry) => entry.device_external_id === deadLight);
  assert.deepEqual(
    badges.map((entry) => entry.transport),
    ['unreachable'],
  );
  assert.ok(
    gladys.fake.states.every((state) => state.device_feature_external_id !== `${deadLight}:on-off`),
    "b2's light state is never published onto b1's light",
  );
  manager.stop();
});

test('a probe that succeeds clears the unreachable status', async () => {
  const { manager, gladys, client } = await makeManager();
  client.down = true;
  await manager.syncDevices();
  client.down = false;

  const { forgotten, busy } = await manager.forgetUnreachableBridges();
  assert.deepEqual([forgotten, busy], [[], []]);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(manager.silentSince.size, 0);
  manager.stop();
});

test('the status does not flap between two stored bridges sharing an address', async () => {
  // A dead bridge and its replacement at the same DHCP reservation: the
  // replacement answering must not hide that the other one does not.
  const { manager, gladys } = await makeSharedIpManager();
  for (let poll = 0; poll < 3; poll += 1) {
    await manager.pollLights();
    assert.equal(gladys.fake.connectionStatus.connected, false);
  }
  assert.ok(manager.resyncTimer, 'the background resync keeps trying the dead one');
  manager.stop();
});

test('a Hue scene is recalled on the bridge that holds it, not on another one at its address', async () => {
  const { manager, clients } = await makeSharedIpManager();
  clients.b1.down = false;
  withScenes(clients.b2);
  clients.b1.getGroups = async () => ({});
  clients.b1.getScenes = async () => ({});
  clients.b1.recallScene = async () => assert.fail('recalled on the wrong bridge');

  await manager.activateScene({ scene: 'Détente' });
  assert.deepEqual(clients.b2.recalled, [{ groupId: '1', sceneId: 's1' }]);
  manager.stop();
});

test('a bridge whose switch to HTTPS failed is not forgotten on the first click', async () => {
  // Firmware 1.78+ answers 403 itself; a refused certificate on HTTPS then
  // leaves that 403 as the only answer.
  const { manager, gladys, store, client } = await makeManager();
  await createAll(manager, gladys);
  failReads(client, { message: 'HTTP 403; HTTPS failed too', httpStatus: 403, httpsSwitchFailed: true });
  await manager.pollLights();

  const first = await manager.forgetUnreachableBridges();
  assert.deepEqual([first.forgotten.length, first.busy.length], [0, 1]);
  assert.equal(store.list().length, 1);
  silentForLong(manager);
  const second = await manager.forgetUnreachableBridges();
  assert.equal(second.forgotten.length, 1);
  manager.stop();
});

test('a bridge that only just went silent is kept when the wall clock jumps', async (t) => {
  // A Raspberry Pi without RTC sets its clock by NTP after boot.
  const { manager, gladys, client } = await makeManager();
  await createAll(manager, gladys);
  client.down = true;
  await manager.pollLights();

  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 24 * 3600 * 1000 });
  const { forgotten } = await manager.forgetUnreachableBridges();
  assert.deepEqual(forgotten, []);
  manager.stop();
});

test('after a restart, Forget keeps the Discovery tab while a paired bridge has not answered yet', async (t) => {
  // Its lights are not known yet: publishing now would drop them from the tab.
  const { manager, gladys, store, clients } = await makeTwoBridgeManager();
  clients['192.168.1.10'].down = true;
  clients['192.168.1.20'].down = true;
  await store.upsert({ id: 'b3', ip: '192.168.1.30', username: 'user-3' });
  clients['192.168.1.30'] = makeFakeClient();
  failReads(clients['192.168.1.30'], { message: 'unauthorized user', hueErrorType: 1 });
  await manager.syncDevices();
  const publish = t.mock.method(gladys, 'publishDiscoveredDevices');

  const { forgotten } = await manager.forgetUnreachableBridges();
  assert.deepEqual(
    forgotten.map((bridge) => bridge.id),
    ['b3'],
  );
  assert.equal(publish.mock.callCount(), 0);
  manager.stop();
});

test('a light belongs to the bridge with the longest matching key', async () => {
  // Bridges paired by 1.0.x/1.1.0 are keyed by the address typed in.
  const { manager, store } = await makeManager();
  store.bridges = [
    { ip: 'hue', username: 'u1' },
    { ip: 'hue-2', username: 'u2' },
  ];
  assert.equal(manager.ownerOf('ext:test:light:hue-2-00:17:88:01:aa'), store.bridges[1]);
  assert.equal(manager.ownerOf('ext:test:light:hue-00:17:88:01:aa'), store.bridges[0]);
  assert.equal(manager.ownerOf('ext:test:light:other-00:17:88:01:aa'), undefined);
});

test('a badge call that rejects does not block the next ones', async () => {
  const { manager, gladys } = await makeManager();
  const deviceId = await createAll(manager, gladys);
  const send = manager.sendTransports;
  manager.sendTransports = async () => {
    manager.sendTransports = send;
    throw new Error('unexpected');
  };
  await assert.rejects(() => manager.queueTransports([]));
  await manager.pollLights();
  assert.deepEqual(gladys.fake.transports, [{ device_external_id: deviceId, transport: 'local' }]);
});

test('pairing waits for a running Forget, so the bridge it pairs again is kept', async () => {
  // The user clicks Forget, then pairs the same bridge at its new address
  // before the probe of the old one times out.
  const { manager, store, client } = await makeManager();
  client.down = true;
  await manager.syncDevices();
  silentForLong(manager);
  let answer;
  client.getLights = () =>
    new Promise((resolve, reject) => {
      answer = () => reject(new Error('connect EHOSTUNREACH'));
    });
  manager.identifiedBridges = async () => ({
    bridges: [{ ...IDENTIFIED_BRIDGE, id: 'b1', ip: '192.168.1.99' }],
    ignored: [],
  });
  mock.method(global, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => [{ success: { username: 'fresh-user' } }],
  }));
  try {
    const forget = manager.forgetUnreachableBridges();
    await settle();
    const pair = manager.pairBridges();
    await settle();
    assert.equal(store.list()[0].username, 'user-1', 'the pairing waits for Forget');

    answer();
    const { forgotten } = await forget;
    const { paired } = await pair;
    assert.equal(forgotten.length, 1, 'the old credentials are forgotten');
    assert.equal(paired.length, 1);
    assert.deepEqual(
      store.list().map((bridge) => [bridge.id, bridge.ip, bridge.username]),
      [['b1', '192.168.1.99', 'fresh-user']],
      'the fresh pairing survives',
    );
  } finally {
    mock.restoreAll();
    manager.stop();
  }
});

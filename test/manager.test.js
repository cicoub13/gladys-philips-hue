import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HueManager, nextResyncDelay } from '../src/manager.js';
import { BridgeStore } from '../src/hue/store.js';
import { FEATURE } from '../src/hue/mapping.js';
import { resetDiscoveryCache } from '../src/hue/discovery.js';
import { DEFAULT_CONFIG } from '../src/config.js';

// Fake GladysIntegration recording everything published.
function makeGladys() {
  const recorded = { states: [], discovered: null, connectionStatus: [] };
  return {
    recorded,
    // The devices the user created (the SDK keeps this list up to date).
    devices: [],
    externalIds(type, platformId) {
      const base = `ext:test:${type}:${platformId}`;
      return { device: base, feature: (key) => `${base}:${key}` };
    },
    async publishStates(states) {
      recorded.states.push(...states);
    },
    async publishDiscoveredDevices(devices) {
      recorded.discovered = devices;
    },
    async setConnectionStatus(connected, message) {
      recorded.connectionStatus.push({ connected, message });
    },
  };
}

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
  };
}

async function makeManager() {
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
  const brightness = gladys.recorded.states.find(
    (s) => s.device_feature_external_id === ids.feature(FEATURE.BRIGHTNESS),
  );
  assert.equal(brightness.state, 100);
});

test('setValue also publishes the on/off state a command implies', async () => {
  const { manager, gladys } = await makeManager();
  const deviceId = await firstDeviceId(manager);
  const ids = gladys.externalIds('light', manager.registry.get(deviceId).platformId);

  // The light starts off; setting a colour turns it on.
  await manager.setValue({ external_id: deviceId }, { external_id: ids.feature(FEATURE.COLOR) }, 0xff0000);
  const onOff = gladys.recorded.states.find((s) => s.device_feature_external_id === ids.feature(FEATURE.ON_OFF));
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
  const onOff = gladys.recorded.states.find((s) => s.device_feature_external_id === ids.feature(FEATURE.ON_OFF));
  assert.ok(onOff, 'on/off state published');
  assert.equal(onOff.state, 0);
});

test('a refresh does not republish states that did not change', async () => {
  const { manager, gladys } = await makeManager();
  await createAll(manager, gladys);

  await manager.pollLights();
  const afterFirstRefresh = gladys.recorded.states.length;
  assert.ok(afterFirstRefresh > 0);

  // Gladys caps an integration at 300 states per minute: an unchanged light
  // must cost nothing.
  await manager.pollLights();
  assert.equal(gladys.recorded.states.length, afterFirstRefresh);
});

test('a refresh publishes again once a value really changed (Hue app, wall switch...)', async () => {
  const { manager, gladys, client } = await makeManager();
  await createAll(manager, gladys);

  await manager.pollLights();
  const afterFirstRefresh = gladys.recorded.states.length;

  client.light.state.on = true;
  await manager.pollLights();
  assert.deepEqual(gladys.recorded.states.slice(afterFirstRefresh), [
    { device_feature_external_id: `${SALON_ID}:on-off`, state: 1 },
  ]);
});

test('a refresh neither reads nor publishes the lights not created in Gladys', async () => {
  // Gladys drops their states but counts them in its 300 states/minute limit.
  const { manager, gladys, client } = await makeManager();
  await manager.buildDiscoveredDevices();
  const reads = countReads(client);
  await manager.pollLights();
  assert.equal(reads.count, 0);
  assert.equal(gladys.recorded.states.length, 0);
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

  const onOff = gladys.recorded.states.filter((s) => s.device_feature_external_id === `${SALON_ID}:on-off`);
  assert.equal(onOff.at(-1).state, 1, 'the command echo stays the last word');
});

test('resolve throws a helpful error for an unknown device', async () => {
  const { manager } = await makeManager();
  await manager.buildDiscoveredDevices();
  assert.throws(() => manager.resolve({ external_id: 'ext:test:light:nope' }), /run a scan/);
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
  assert.equal(devices.length, 0);
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
  assert.equal(gladys.recorded.discovered.length, 1);

  client.down = true;
  gladys.recorded.discovered = 'untouched';
  await manager.syncDevices();
  assert.equal(gladys.recorded.discovered, 'untouched', 'no empty list published');
  assert.equal(gladys.recorded.connectionStatus.at(-1).connected, false);
  assert.match(gladys.recorded.connectionStatus.at(-1).message.fr, /injoignable/);
});

test('syncDevices reports the missing pairing when no bridge is stored', async () => {
  const { manager, gladys, store } = await makeManager();
  store.bridges.length = 0;
  const devices = await manager.syncDevices();
  assert.deepEqual(devices, []);
  assert.equal(gladys.recorded.connectionStatus.at(-1).connected, false);
  assert.match(gladys.recorded.connectionStatus.at(-1).message.en, /No Hue bridge paired/);
});

test('syncDevices reports a healthy connection once lights are published', async () => {
  const { manager, gladys } = await makeManager();
  await manager.syncDevices();
  assert.equal(gladys.recorded.connectionStatus.at(-1).connected, true);
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
  manager.gladys.scanNetwork = async () => [HUE_SSDP_RESPONDER];
  resetDiscoveryCache();

  const candidates = await manager.candidateBridges();
  assert.deepEqual(candidates.map((c) => c.ip).sort(), ['10.0.0.5', '192.168.1.42']);
});

test('candidateBridges does not duplicate a manual address already discovered', async () => {
  const { manager } = await makeManager();
  manager.config = { ...DEFAULT_CONFIG, bridge_ip: '192.168.1.42' };
  manager.gladys.scanNetwork = async () => [HUE_SSDP_RESPONDER];
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
  assert.equal(gladys.recorded.connectionStatus.at(-1).connected, true, 'the status recovered');
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
  assert.equal(gladys.recorded.discovered.length, 1, 'the lights are published');
  assert.equal(gladys.recorded.connectionStatus.at(-1).connected, true);
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
  assert.equal(gladys.recorded.connectionStatus.at(-1).connected, true);

  client.down = true;
  await manager.pollLights();
  assert.equal(gladys.recorded.connectionStatus.at(-1).connected, false);
  assert.match(gladys.recorded.connectionStatus.at(-1).message.en, /unreachable/);
  assert.ok(manager.resyncTimer, 'a resync is scheduled');

  client.down = false;
  await manager.pollLights();
  assert.equal(gladys.recorded.connectionStatus.at(-1).connected, true);
  assert.equal(manager.resyncTimer, undefined);
});

test('the status is only sent when it changes', async () => {
  const { manager, gladys } = await makeManager();
  await manager.syncDevices();
  await createAll(manager, gladys);
  const sent = gladys.recorded.connectionStatus.length;
  await manager.pollLights();
  await manager.pollLights();
  assert.equal(gladys.recorded.connectionStatus.length, sent);
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
  const onOff = gladys.recorded.states.filter((s) => s.device_feature_external_id.endsWith(':on-off'));
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
    gladys.recorded.states.some((s) => s.device_feature_external_id.startsWith('ext:test:light:b2-')),
    'the lights of the other bridge are published',
  );
  assert.equal(gladys.recorded.connectionStatus.at(-1).connected, false);

  // Only the refresh publishes states (the background resync of the bridge,
  // also due by then, reads it but publishes the device list).
  client.down = false;
  t.mock.timers.tick(DEFAULT_CONFIG.poll_frequency);
  await settle();
  assert.ok(
    gladys.recorded.states.some((s) => s.device_feature_external_id === `${SALON_ID}:on-off`),
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
  assert.equal(gladys.recorded.connectionStatus.at(-1).connected, true);
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
  const onOff = gladys.recorded.states.find((s) => s.device_feature_external_id === `${SALON_ID}:on-off`);
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

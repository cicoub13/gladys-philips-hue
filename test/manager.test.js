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
    async getLight() {
      if (this.down) {
        throw new Error('connect EHOSTUNREACH');
      }
      return light;
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

test('the published poll_frequency is one Gladys accepts', async () => {
  const { manager } = await makeManager();
  const { devices } = await manager.buildDiscoveredDevices();
  // Milliseconds, from the DEVICE_POLL_FREQUENCIES enum — 60 (seconds) would be
  // rejected by the database and the light would never be polled.
  assert.equal(devices[0].poll_frequency, 60000);
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

test('poll publishes the current light states', async () => {
  const { manager, gladys } = await makeManager();
  const deviceId = await firstDeviceId(manager);

  await manager.poll({ external_id: deviceId });
  const ids = gladys.externalIds('light', manager.registry.get(deviceId).platformId);
  const onOff = gladys.recorded.states.find((s) => s.device_feature_external_id === ids.feature(FEATURE.ON_OFF));
  assert.ok(onOff, 'on/off state published');
  assert.equal(onOff.state, 0);
});

test('poll does not republish states that did not change', async () => {
  const { manager, gladys } = await makeManager();
  const deviceId = await firstDeviceId(manager);

  await manager.poll({ external_id: deviceId });
  const afterFirstPoll = gladys.recorded.states.length;
  assert.ok(afterFirstPoll > 0);

  // Gladys caps an integration at 300 states per minute: an unchanged light
  // must cost nothing.
  await manager.poll({ external_id: deviceId });
  assert.equal(gladys.recorded.states.length, afterFirstPoll);
});

test('poll publishes again once a value really changed', async () => {
  const { manager, gladys, client } = await makeManager();
  const deviceId = await firstDeviceId(manager);

  await manager.poll({ external_id: deviceId });
  const afterFirstPoll = gladys.recorded.states.length;

  client.light.state.on = true;
  await manager.poll({ external_id: deviceId });
  assert.ok(gladys.recorded.states.length > afterFirstPoll);
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
  // and poll would then fail with a misleading "unknown light".
  client.down = true;
  const { devices, reachable, unreachable } = await manager.buildDiscoveredDevices();
  assert.equal(devices.length, 0);
  assert.equal(reachable, 0);
  assert.equal(unreachable, 1);
  assert.equal(manager.registry.size, 1);

  client.down = false;
  await assert.doesNotReject(() => manager.poll({ external_id: deviceId }));
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

test('candidateBridges merges the discovered bridges with the manual address', async () => {
  const { manager } = await makeManager();
  manager.config = { ...DEFAULT_CONFIG, bridge_ip: '10.0.0.5' };
  manager.gladys.scanNetwork = async () => [
    { LOCATION: 'http://192.168.1.42:80/description.xml', 'hue-bridgeid': 'ABC' },
  ];
  resetDiscoveryCache();

  const candidates = await manager.candidateBridges();
  assert.deepEqual(candidates.map((c) => c.ip).sort(), ['10.0.0.5', '192.168.1.42']);
});

test('candidateBridges does not duplicate a manual address already discovered', async () => {
  const { manager } = await makeManager();
  manager.config = { ...DEFAULT_CONFIG, bridge_ip: '192.168.1.42' };
  manager.gladys.scanNetwork = async () => [
    { LOCATION: 'http://192.168.1.42:80/description.xml', 'hue-bridgeid': 'ABC' },
  ];
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
  // stayed empty and every poll/command failed with "unknown light, run a scan"
  // until the user clicked something.
  const { manager, gladys, client } = await makeManager();
  client.down = true;
  await manager.syncDevices();
  assert.equal(manager.registry.size, 0);

  client.down = false;
  await manager.poll({ external_id: SALON_ID });
  assert.ok(gladys.recorded.states.length > 0, 'the light was polled');
  assert.equal(gladys.recorded.connectionStatus.at(-1).connected, true, 'the status recovered');
  manager.stop();
});

test('while its bridge is down, a light says so instead of "run a scan"', async () => {
  const { manager, client } = await makeManager();
  client.down = true;
  await manager.syncDevices();
  await assert.rejects(() => manager.poll({ external_id: SALON_ID }), /unreachable/);
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

test('the status follows the bridge: false when a poll cannot reach it, true when it answers again', async () => {
  // The status used to be computed at scan time only: a bridge dying an hour
  // later left "connected" on screen while every command failed.
  const { manager, gladys, client } = await makeManager();
  await manager.syncDevices();
  assert.equal(gladys.recorded.connectionStatus.at(-1).connected, true);

  client.down = true;
  await assert.rejects(() => manager.poll({ external_id: SALON_ID }));
  assert.equal(gladys.recorded.connectionStatus.at(-1).connected, false);
  assert.match(gladys.recorded.connectionStatus.at(-1).message.en, /unreachable/);
  assert.ok(manager.resyncTimer, 'a resync is scheduled');

  client.down = false;
  await manager.poll({ external_id: SALON_ID });
  assert.equal(gladys.recorded.connectionStatus.at(-1).connected, true);
  assert.equal(manager.resyncTimer, undefined);
});

test('the status is only sent when it changes', async () => {
  const { manager, gladys } = await makeManager();
  await manager.syncDevices();
  const sent = gladys.recorded.connectionStatus.length;
  await manager.poll({ external_id: SALON_ID });
  await manager.poll({ external_id: SALON_ID });
  assert.equal(gladys.recorded.connectionStatus.length, sent);
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

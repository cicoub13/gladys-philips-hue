import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HueManager } from '../src/manager.js';
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

test('pairBridges persists the credentials of a bridge whose button was pressed', async () => {
  const { manager, store } = await makeManager();
  store.bridges.length = 0;
  manager.candidateBridges = async () => [{ id: 'abc', ip: '192.168.1.42' }];
  mock.method(global, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => [{ success: { username: 'granted-key' } }],
  }));

  const result = await manager.pairBridges();
  assert.deepEqual(result, { paired: ['192.168.1.42'], pending: [], failed: [] });
  assert.equal(store.list()[0].username, 'granted-key', 'credentials survive a restart');
  mock.restoreAll();
});

test('pairBridges separates "button not pressed" from a real failure', async () => {
  const { manager } = await makeManager();
  manager.candidateBridges = async () => [
    { id: '', ip: '192.168.1.42' },
    { id: '', ip: '192.168.1.43' },
  ];
  mock.method(global, 'fetch', async (url) => {
    if (String(url).includes('192.168.1.42')) {
      return { ok: true, status: 200, json: async () => [{ error: { type: 101, description: 'link button' } }] };
    }
    throw new Error('EHOSTUNREACH');
  });

  const result = await manager.pairBridges();
  assert.deepEqual(result.pending, ['192.168.1.42'], 'the user just has to press the button');
  assert.deepEqual(result.failed, ['192.168.1.43'], 'this one is a network problem');
  mock.restoreAll();
});

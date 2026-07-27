import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HueManager } from '../src/manager.js';
import { BridgeStore } from '../src/hue/store.js';
import { FEATURE } from '../src/hue/mapping.js';

// Fake GladysIntegration recording published states.
function makeGladys() {
  const recorded = { states: [], discovered: [] };
  return {
    recorded,
    externalIds(type, platformId) {
      const base = `ext:test:${type}:${platformId}`;
      return { device: base, feature: (key) => `${base}:${key}` };
    },
    async publishState(external_id, value) {
      recorded.states.push({ external_id, value });
    },
    async publishStates(states) {
      recorded.states.push(...states);
    },
    async publishDiscoveredDevices(devices) {
      recorded.discovered = devices;
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
    async getLights() {
      return { 3: light };
    },
    async getLight() {
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
  store.bridges = [{ id: 'b1', ip: '192.168.1.10', username: 'user-1' }];

  const gladys = makeGladys();
  const manager = new HueManager(gladys, { bridge_ip: '', poll_frequency: 60 }, store);
  const client = makeFakeClient();
  manager.clientFor = () => client;
  return { manager, gladys, client };
}

test('buildDiscoveredDevices maps bridge lights to Gladys devices', async () => {
  const { manager } = await makeManager();
  const devices = await manager.buildDiscoveredDevices();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, 'Salon');
  assert.equal(devices[0].poll_frequency, 60);
  // The registry is populated for later dispatch.
  assert.equal(manager.registry.size, 1);
});

test('setValue sends the right Hue state and echoes it', async () => {
  const { manager, gladys, client } = await makeManager();
  await manager.buildDiscoveredDevices();
  const device = { external_id: [...manager.registry.keys()][0] };
  const platformId = manager.registry.get(device.external_id).platformId;
  const ids = gladys.externalIds('light', platformId);

  await manager.setValue(device, { external_id: ids.feature(FEATURE.BRIGHTNESS) }, 100);
  assert.deepEqual(client.lastSetState, { id: '3', state: { on: true, bri: 254 } });
  assert.deepEqual(gladys.recorded.states.at(-1), { external_id: ids.feature(FEATURE.BRIGHTNESS), value: 100 });
});

test('poll publishes the current light states', async () => {
  const { manager, gladys } = await makeManager();
  await manager.buildDiscoveredDevices();
  const device = { external_id: [...manager.registry.keys()][0] };

  gladys.recorded.states.length = 0;
  await manager.poll(device);
  const ids = gladys.externalIds('light', manager.registry.get(device.external_id).platformId);
  const onOff = gladys.recorded.states.find((s) => s.device_feature_external_id === ids.feature(FEATURE.ON_OFF));
  assert.ok(onOff, 'on/off state published');
  assert.equal(onOff.state, 0);
});

test('resolve throws for an unknown device', async () => {
  const { manager } = await makeManager();
  await manager.buildDiscoveredDevices();
  assert.throws(() => manager.resolve({ external_id: 'ext:test:light:nope' }), /Unknown device/);
});

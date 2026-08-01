import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { discoverBridgesAction, pairBridgeAction } from '../src/actions.js';
import { resetDiscoveryCache } from '../src/hue/discovery.js';
import { normalizeConfig } from '../src/config.js';

/**
 * Build a manager stub exposing only what the actions use.
 * @param {object} [options] - Stub options.
 * @param {object} [options.config] - Raw config to normalize.
 * @param {object} [options.pairResult] - Result of pairBridges.
 * @param {Array} [options.ssdp] - SSDP responders returned by the fake scan.
 * @returns {object} Manager stub.
 */
function makeManager({ config = {}, pairResult, ssdp = [], persistError } = {}) {
  return {
    config: normalizeConfig(config),
    synced: 0,
    store: { persistError },
    gladys: {
      async scanNetwork() {
        return ssdp;
      },
    },
    async pairBridges() {
      return pairResult;
    },
    async syncDevices() {
      this.synced += 1;
      return [];
    },
  };
}

const HUE_SSDP_RESPONSE = {
  LOCATION: 'http://192.168.1.42:80/description.xml',
  'hue-bridgeid': '001788FFFE123456',
};

/**
 * Assert a message is filled in both languages.
 * @param {{ en: string, fr: string }} message - Message to check.
 * @returns {void}
 */
function assertBilingual(message) {
  assert.ok(message.en && message.en.length > 10, 'english message');
  assert.ok(message.fr && message.fr.length > 10, 'french message');
}

beforeEach(() => resetDiscoveryCache());
afterEach(() => mock.restoreAll());

test('discoverBridges lists the bridges found and tells what to do next', async () => {
  const message = await discoverBridgesAction(makeManager({ ssdp: [HUE_SSDP_RESPONSE] }));
  assertBilingual(message);
  assert.match(message.en, /192\.168\.1\.42/);
  assert.match(message.en, /Pair bridge/);
});

test('discoverBridges explains what to try when nothing is found', async () => {
  mock.method(global, 'fetch', async () => ({ ok: true, status: 200, json: async () => [] }));
  const message = await discoverBridgesAction(makeManager());
  assertBilingual(message);
  assert.match(message.en, /No Hue bridge found/);
  assert.match(message.en, /manually/);
});

test('discoverBridges still reports the manual IP when auto-discovery finds nothing', async () => {
  mock.method(global, 'fetch', async () => ({ ok: true, status: 200, json: async () => [] }));
  const message = await discoverBridgesAction(makeManager({ config: { bridge_ip: '10.0.0.5' } }));
  assert.match(message.en, /10\.0\.0\.5/);
});

test('discoverBridges tells the user their address was rejected, instead of ignoring it', async () => {
  const message = await discoverBridgesAction(makeManager({ config: { bridge_ip: 'http://192.168.1.42' } }));
  assertBilingual(message);
  assert.match(message.en, /not a valid IP address/);
  assert.match(message.en, /192\.168\.1\.42/, 'the message quotes what was typed');
});

test('pairBridge confirms a successful pairing and refreshes the devices', async () => {
  const manager = makeManager({ pairResult: { paired: ['192.168.1.42'], pending: [], failed: [] } });
  const message = await pairBridgeAction(manager);
  assertBilingual(message);
  assert.match(message.en, /Paired successfully/);
  assert.equal(manager.synced, 1, 'the lights are published right away');
});

test('pairBridge warns when the credentials could not be saved', async () => {
  // Reporting a plain success would be a lie: the pairing is lost on restart.
  const manager = makeManager({
    pairResult: { paired: ['192.168.1.42'], pending: [], failed: [] },
    persistError: new Error("EACCES: permission denied, open '/data/bridges.json'"),
  });
  const message = await pairBridgeAction(manager);
  assertBilingual(message);
  assert.match(message.en, /could NOT be saved/);
  assert.match(message.en, /EACCES/, 'the technical cause is quoted for a bug report');
  assert.match(message.fr, /perdus au redémarrage/);
});

test('pairBridge asks for the link button when pairing is pending', async () => {
  const manager = makeManager({ pairResult: { paired: [], pending: ['192.168.1.42'], failed: [] } });
  const message = await pairBridgeAction(manager);
  assertBilingual(message);
  assert.match(message.en, /Link button not pressed/);
  assert.match(message.en, /30 seconds/);
  assert.equal(manager.synced, 0);
});

test('pairBridge reports an unreachable bridge', async () => {
  const message = await pairBridgeAction(
    makeManager({ pairResult: { paired: [], pending: [], failed: ['192.168.1.42'] } }),
  );
  assertBilingual(message);
  assert.match(message.en, /Could not reach any bridge/);
});

test('pairBridge tells the user to discover first when there is no candidate', async () => {
  const message = await pairBridgeAction(makeManager({ pairResult: { paired: [], pending: [], failed: [] } }));
  assertBilingual(message);
  assert.match(message.en, /No bridge to pair/);
});

test('pairBridge blames the rejected address when there is no candidate because of it', async () => {
  const message = await pairBridgeAction(
    makeManager({
      config: { bridge_ip: 'evil.com/api' },
      pairResult: { paired: [], pending: [], failed: [] },
    }),
  );
  assert.match(message.en, /not a valid IP address/);
});

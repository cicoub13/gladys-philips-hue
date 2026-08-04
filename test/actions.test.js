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
 * @param {object} [options.identified] - Result of identifiedBridges.
 * @param {Error} [options.persistError] - Store persistence failure.
 * @returns {object} Manager stub.
 */
function makeManager({ config = {}, pairResult, identified = { bridges: [], ignored: [] }, persistError } = {}) {
  return {
    config: normalizeConfig(config),
    synced: 0,
    store: { persistError },
    gladys: {},
    async identifiedBridges() {
      return identified;
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

// A bridge as `identifyBridge` returns it, once proven through /api/config.
const HUE_BRIDGE = {
  ip: '192.168.1.42',
  id: '001788fffe123456',
  name: 'Philips hue',
  model: 'BSB002',
  apiVersion: '1.63.0',
  scheme: 'http',
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
  const message = await discoverBridgesAction(makeManager({ identified: { bridges: [HUE_BRIDGE], ignored: [] } }));
  assertBilingual(message);
  assert.match(message.en, /192\.168\.1\.42/);
  assert.match(message.en, /Pair bridge/);
});

test('discoverBridges names the bridge and its model, not just an IP', async () => {
  // Users recognize "Philips hue (BSB002)", not a bare address.
  const message = await discoverBridgesAction(makeManager({ identified: { bridges: [HUE_BRIDGE], ignored: [] } }));
  assert.match(message.en, /Philips hue/);
  assert.match(message.en, /BSB002/);
});

test('discoverBridges explains what to try when nothing is found', async () => {
  const message = await discoverBridgesAction(makeManager());
  assertBilingual(message);
  assert.match(message.en, /No Hue bridge found/);
  assert.match(message.en, /manually/);
});

test('discoverBridges says other devices answered but none was a bridge', async () => {
  // The exact situation reported by users: mDNS surfaced 3 devices, none Hue.
  const message = await discoverBridgesAction(
    makeManager({ identified: { bridges: [], ignored: ['192.168.0.243', '192.168.0.235'] } }),
  );
  assertBilingual(message);
  assert.match(message.en, /No Hue bridge found/);
  assert.match(message.en, /2 other device\(s\)/);
  assert.match(message.fr, /aucun n'est un bridge Hue/);
});

test('discoverBridges mentions the devices it ignored alongside a real bridge', async () => {
  const message = await discoverBridgesAction(
    makeManager({ identified: { bridges: [HUE_BRIDGE], ignored: ['192.168.0.235'] } }),
  );
  assert.match(message.en, /1 other device\(s\) ignored/);
});

test('discoverBridges tells the user their address was rejected, instead of ignoring it', async () => {
  const message = await discoverBridgesAction(makeManager({ config: { bridge_ip: 'http://192.168.1.42' } }));
  assertBilingual(message);
  assert.match(message.en, /not a valid IP address/);
  assert.match(message.en, /192\.168\.1\.42/, 'the message quotes what was typed');
});

// An empty outcome of every kind, so each test only states what it exercises.
const NO_PAIRING = { paired: [], pending: [], unreachable: [], notABridge: [] };

test('pairBridge confirms a successful pairing and refreshes the devices', async () => {
  const manager = makeManager({ pairResult: { ...NO_PAIRING, paired: [HUE_BRIDGE] } });
  const message = await pairBridgeAction(manager);
  assertBilingual(message);
  assert.match(message.en, /Paired successfully/);
  assert.equal(manager.synced, 1, 'the lights are published right away');
});

test('pairBridge warns when the credentials could not be saved', async () => {
  // Reporting a plain success would be a lie: the pairing is lost on restart.
  const manager = makeManager({
    pairResult: { ...NO_PAIRING, paired: [HUE_BRIDGE] },
    persistError: new Error("EACCES: permission denied, open '/data/bridges.json'"),
  });
  const message = await pairBridgeAction(manager);
  assertBilingual(message);
  assert.match(message.en, /could NOT be saved/);
  assert.match(message.en, /EACCES/, 'the technical cause is quoted for a bug report');
  assert.match(message.fr, /perdus au redémarrage/);
});

test('pairBridge asks for the link button when pairing is pending', async () => {
  const manager = makeManager({ pairResult: { ...NO_PAIRING, pending: [HUE_BRIDGE] } });
  const message = await pairBridgeAction(manager);
  assertBilingual(message);
  assert.match(message.en, /link button was not pressed/);
  assert.match(message.en, /30 seconds/);
  assert.equal(manager.synced, 0);
});

test('pairBridge distinguishes an unreachable bridge from a missing button', async () => {
  const message = await pairBridgeAction(makeManager({ pairResult: { ...NO_PAIRING, unreachable: [HUE_BRIDGE] } }));
  assertBilingual(message);
  assert.match(message.en, /could not be paired/);
  assert.doesNotMatch(message.en, /link button/, 'pressing the button would not help here');
});

test('pairBridge says the network answered but nothing was a Hue bridge', async () => {
  // Regression guard for the reported bug: pairing used to try random mDNS
  // devices and report their raw HTTP errors.
  const message = await pairBridgeAction(
    makeManager({ pairResult: { ...NO_PAIRING, notABridge: ['192.168.0.243', '192.168.0.235'] } }),
  );
  assertBilingual(message);
  assert.match(message.en, /none is a Hue bridge/);
  assert.match(message.en, /2 device\(s\)/);
});

test('pairBridge tells the user to discover first when there is no candidate', async () => {
  const message = await pairBridgeAction(makeManager({ pairResult: { ...NO_PAIRING } }));
  assertBilingual(message);
  assert.match(message.en, /No bridge to pair/);
});

test('pairBridge blames the rejected address when there is no candidate because of it', async () => {
  const message = await pairBridgeAction(
    makeManager({
      config: { bridge_ip: 'evil.com/api' },
      pairResult: { ...NO_PAIRING },
    }),
  );
  assert.match(message.en, /not a valid IP address/);
});

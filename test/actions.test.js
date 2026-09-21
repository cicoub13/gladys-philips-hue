import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { discoverBridgesAction, pairBridgeAction, unpairBridgesAction } from '../src/actions.js';
import { resetDiscoveryCache } from '../src/hue/discovery.js';
import { normalizeConfig } from '../src/config.js';

/**
 * Build a manager stub exposing only what the actions use.
 * @param {object} [options] - Stub options.
 * @param {object} [options.config] - Raw config to normalize.
 * @param {object} [options.pairResult] - Result of pairBridges.
 * @param {object} [options.unpairResult] - Result of unpairBridges.
 * @param {object} [options.identified] - Result of identifiedBridges.
 * @param {Error} [options.persistError] - Store persistence failure.
 * @param {object} [options.syncResult] - Result of syncDevices.
 * @returns {object} Manager stub.
 */
function makeManager({
  config = {},
  pairResult,
  unpairResult,
  identified = { bridges: [], ignored: [] },
  persistError,
  syncResult = { devices: [], reachable: 1, unreachable: 0, insecure: 0 },
} = {}) {
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
    async unpairBridges() {
      return unpairResult;
    },
    async syncDevices(options) {
      this.synced += 1;
      this.syncOptions = options;
      return syncResult;
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
const NO_PAIRING = { paired: [], alreadyPaired: [], pending: [], unreachable: [], insecure: [], notABridge: [] };

test('pairBridge confirms a successful pairing and refreshes the devices', async () => {
  const manager = makeManager({ pairResult: { ...NO_PAIRING, paired: [HUE_BRIDGE] } });
  const message = await pairBridgeAction(manager);
  assertBilingual(message);
  assert.match(message.en, /Paired successfully/);
  assert.equal(manager.synced, 1, 'the lights are published right away');
});

test('pairBridge keeps an existing credential instead of creating another', async () => {
  const manager = makeManager({ pairResult: { ...NO_PAIRING, alreadyPaired: [HUE_BRIDGE] } });
  const message = await pairBridgeAction(manager);
  assertBilingual(message);
  assert.match(message.en, /Already paired/);
  assert.match(message.en, /refreshed/);
  assert.equal(manager.synced, 1);
});

test('pairBridge does not claim the lights were refreshed when the already-paired bridge is unreachable', async () => {
  // Regression guard: syncDevices() can fail (e.g. allow_insecure_http just
  // got disabled) even though the bridge key itself is still valid.
  const manager = makeManager({
    pairResult: { ...NO_PAIRING, alreadyPaired: [HUE_BRIDGE] },
    syncResult: { devices: [], reachable: 0, unreachable: 1, insecure: 0 },
  });
  const message = await pairBridgeAction(manager);
  assertBilingual(message);
  assert.match(message.en, /Already paired/);
  assert.doesNotMatch(message.en, /your lights were refreshed/);
  assert.match(message.en, /could not be reached/);
});

test('pairBridge mentions a second bridge still pending its link button', async () => {
  // Regression guard: an already-paired bridge used to hide any other bridge
  // found in the same pairing pass.
  const secondBridge = { ...HUE_BRIDGE, ip: '192.168.1.43' };
  const manager = makeManager({
    pairResult: { ...NO_PAIRING, alreadyPaired: [HUE_BRIDGE], pending: [secondBridge] },
  });
  const message = await pairBridgeAction(manager);
  assertBilingual(message);
  assert.match(message.en, /Already paired/);
  assert.match(message.en, /link button pressed/);
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

test('pairBridge explains how to opt in when a legacy HTTP bridge is blocked', async () => {
  const message = await pairBridgeAction(makeManager({ pairResult: { ...NO_PAIRING, insecure: [HUE_BRIDGE] } }));
  assertBilingual(message);
  assert.match(message.en, /blocked/);
  assert.match(message.en, /legacy HTTP fallback/);
  assert.match(message.fr, /HTTP non chiffré/);
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

const NO_UNPAIRING = { revoked: [], unreachable: [], insecure: [] };

test('unpairBridges confirms remote revocation and clears discovered devices', async () => {
  const manager = makeManager({ unpairResult: { ...NO_UNPAIRING, revoked: [HUE_BRIDGE] } });
  const message = await unpairBridgesAction(manager);

  assertBilingual(message);
  assert.match(message.en, /revoked bridge access/);
  assert.equal(manager.synced, 1);
  assert.deepEqual(manager.syncOptions, { clearWhenEmpty: true });
});

test('unpairBridges keeps credentials when the bridge is unreachable', async () => {
  const manager = makeManager({ unpairResult: { ...NO_UNPAIRING, unreachable: [HUE_BRIDGE] } });
  const message = await unpairBridgesAction(manager);

  assertBilingual(message);
  assert.match(message.en, /local key was kept/);
  assert.equal(manager.synced, 0);
});

test('unpairBridges explains how to revoke a legacy HTTP credential', async () => {
  const manager = makeManager({ unpairResult: { ...NO_UNPAIRING, insecure: [HUE_BRIDGE] } });
  const message = await unpairBridgesAction(manager);

  assertBilingual(message);
  assert.match(message.en, /legacy HTTP fallback/);
});

test('unpairBridges reports both an insecure and an unreachable bridge left behind', async () => {
  // Regression guard: the insecure-bridge branch used to return before ever
  // mentioning a second, genuinely offline bridge.
  const insecureBridge = HUE_BRIDGE;
  const offlineBridge = { ...HUE_BRIDGE, ip: '192.168.1.44' };
  const manager = makeManager({
    unpairResult: { ...NO_UNPAIRING, insecure: [insecureBridge], unreachable: [offlineBridge] },
  });
  const message = await unpairBridgesAction(manager);

  assertBilingual(message);
  assert.match(message.en, /legacy HTTP fallback/);
  assert.match(message.en, /could not be reached/);
});

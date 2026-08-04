import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { identifyBridge, identifyBridges, parseBridgeConfig } from '../src/hue/identify.js';

// What a real bridge answers on GET /api/config, unauthenticated.
const BRIDGE_CONFIG = {
  name: 'Philips hue',
  bridgeid: '001788FFFE123456',
  modelid: 'BSB002',
  apiversion: '1.63.0',
  swversion: '1963089030',
};

/**
 * Stub the global fetch with a per-URL responder.
 * @param {(url: string) => object} responder - Returns a fake Response, or throws.
 * @returns {object} The mock.
 */
function stubFetch(responder) {
  return mock.method(global, 'fetch', async (url) => responder(String(url)));
}

/**
 * Build a successful JSON response.
 * @param {any} body - Body to serve.
 * @returns {object} Fake Response.
 */
function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

afterEach(() => mock.restoreAll());

test('parseBridgeConfig accepts a real bridge description', () => {
  const identity = parseBridgeConfig('192.168.1.42', BRIDGE_CONFIG);
  assert.equal(identity.id, '001788fffe123456', 'the id is normalized for comparison');
  assert.equal(identity.model, 'BSB002');
  assert.equal(identity.name, 'Philips hue');
  assert.equal(identity.scheme, 'http');
});

test('parseBridgeConfig accepts a v1 round bridge', () => {
  // BSB001 is the first generation: it must stay supported.
  const identity = parseBridgeConfig('192.168.1.42', { ...BRIDGE_CONFIG, modelid: 'BSB001' });
  assert.equal(identity.model, 'BSB001');
});

test('parseBridgeConfig accepts an unknown future model', () => {
  // Being strict on modelid would reject the next bridge Signify ships.
  const identity = parseBridgeConfig('192.168.1.42', { ...BRIDGE_CONFIG, modelid: 'BSB999' });
  assert.equal(identity.model, 'BSB999');
});

test('parseBridgeConfig rejects anything without a bridge id', () => {
  assert.equal(parseBridgeConfig('1.2.3.4', { name: 'My NAS', modelid: 'DS220' }), undefined);
  assert.equal(parseBridgeConfig('1.2.3.4', {}), undefined);
  assert.equal(parseBridgeConfig('1.2.3.4', null), undefined);
  assert.equal(parseBridgeConfig('1.2.3.4', 'not json'), undefined);
  assert.equal(parseBridgeConfig('1.2.3.4', [BRIDGE_CONFIG]), undefined, 'an array is not a config');
});

test('identifyBridge proves a bridge over plain HTTP', async () => {
  stubFetch((url) => {
    assert.match(url, /^http:\/\/192\.168\.1\.42\/api\/config$/);
    return jsonResponse(BRIDGE_CONFIG);
  });

  const identity = await identifyBridge('192.168.1.42');
  assert.equal(identity.id, '001788fffe123456');
  assert.equal(identity.scheme, 'http');
});

test('identifyBridge rejects a device that answers but is not a bridge', async () => {
  // 192.168.0.235 in the bug report: an HTTP server, but not Hue.
  stubFetch(() => jsonResponse({ name: 'My NAS' }));
  assert.equal(await identifyBridge('192.168.0.235'), undefined);
});

test('identifyBridge rejects a 404, without trying to pair', async () => {
  stubFetch(() => ({ ok: false, status: 404, json: async () => ({}) }));
  assert.equal(await identifyBridge('192.168.0.235'), undefined);
});

test('identifyBridge rejects an address where nothing listens', async () => {
  // 192.168.0.243 in the bug report: `fetch failed`.
  stubFetch(() => {
    throw new Error('fetch failed');
  });
  assert.equal(await identifyBridge('192.168.0.243'), undefined);
});

test('identifyBridge does not try HTTPS when HTTP already answered', async () => {
  // A device that answers "I am not a bridge" is settled; probing it again over
  // TLS only slows the Discover button down.
  const fetchMock = stubFetch(() => jsonResponse({ name: 'My NAS' }));
  await identifyBridge('192.168.0.235');
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('identifyBridges sorts the proven bridges from the rest', async () => {
  stubFetch((url) => {
    if (url.includes('192.168.1.42')) {
      return jsonResponse(BRIDGE_CONFIG);
    }
    throw new Error('fetch failed');
  });

  const { bridges, ignored } = await identifyBridges([
    { ip: '192.168.0.243' },
    { ip: '192.168.1.42' },
    { ip: '192.168.0.235' },
  ]);

  assert.deepEqual(
    bridges.map((bridge) => bridge.ip),
    ['192.168.1.42'],
  );
  assert.deepEqual(ignored, ['192.168.0.243', '192.168.0.235']);
});

test('identifyBridges tolerates an empty or malformed candidate list', async () => {
  assert.deepEqual(await identifyBridges([]), { bridges: [], ignored: [] });
  assert.deepEqual(await identifyBridges(null), { bridges: [], ignored: [] });
  assert.deepEqual(await identifyBridges([null, { ip: '' }]), { bridges: [], ignored: [] });
});

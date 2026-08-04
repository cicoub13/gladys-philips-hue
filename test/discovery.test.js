import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { discoverBridges, parseSsdpResults, parseMdnsResults, resetDiscoveryCache } from '../src/hue/discovery.js';

// One SSDP responder, as the Gladys core relays it (raw headers).
const HUE_SSDP_RESPONSE = {
  LOCATION: 'http://192.168.1.42:80/description.xml',
  SERVER: 'Hue/1.0 UPnP/1.0 IpBridge/1.60.0',
  'hue-bridgeid': '001788FFFE123456',
};

/**
 * Build a fake SDK exposing scanNetwork.
 * @param {Record<string, any>} answers - Result (or Error) per scan type.
 * @returns {{ scanNetwork: Function, calls: string[] }} Fake SDK.
 */
function makeGladys(answers) {
  const calls = [];
  return {
    calls,
    async scanNetwork(type) {
      calls.push(type);
      const answer = answers[type];
      if (answer instanceof Error) {
        throw answer;
      }
      return answer || [];
    },
  };
}

beforeEach(() => resetDiscoveryCache());
afterEach(() => mock.restoreAll());

test('parseSsdpResults keeps Hue bridges and their IP', () => {
  assert.deepEqual(parseSsdpResults([HUE_SSDP_RESPONSE]), [{ id: '001788fffe123456', ip: '192.168.1.42' }]);
});

test('parseSsdpResults ignores the other UPnP devices of the network', () => {
  // A printer or a TV answers the same M-SEARCH: without the hue-bridgeid
  // header we would offer them as bridges to pair with.
  const printer = { LOCATION: 'http://192.168.1.5:631/desc.xml', SERVER: 'CUPS/2.3 UPnP/1.0' };
  assert.deepEqual(parseSsdpResults([printer, HUE_SSDP_RESPONSE]), [{ id: '001788fffe123456', ip: '192.168.1.42' }]);
});

test('parseSsdpResults survives malformed responders', () => {
  assert.deepEqual(parseSsdpResults([{ 'hue-bridgeid': 'abc', LOCATION: 'not a url' }]), []);
  assert.deepEqual(parseSsdpResults(undefined), []);
});

test('parseSsdpResults reads headers whatever their casing', () => {
  const lowercased = { location: 'http://192.168.1.42/description.xml', 'HUE-BRIDGEID': 'ABC' };
  assert.deepEqual(parseSsdpResults([lowercased]), [{ id: 'abc', ip: '192.168.1.42' }]);
});

test('parseMdnsResults picks the IPv4 address of the service', () => {
  const service = {
    name: 'Philips Hue - 123456',
    host: 'hue.local',
    addresses: ['fe80::1', '192.168.1.42'],
    port: 443,
    txt: { bridgeid: '001788FFFE123456' },
  };
  assert.deepEqual(parseMdnsResults([service]), [{ id: '001788fffe123456', ip: '192.168.1.42' }]);
});

test('parseMdnsResults drops a service without a usable address', () => {
  assert.deepEqual(parseMdnsResults([{ name: 'Philips Hue', addresses: ['fe80::1'], txt: {} }]), []);
  assert.deepEqual(parseMdnsResults(null), []);
});

test('parseMdnsResults rejects a responder that is not a Hue bridge', () => {
  // The reported bug: an mDNS browse also surfaces printers, NAS and speakers.
  // Having an IPv4 address is NOT evidence of being a Hue bridge — without this
  // filter they were all offered as bridges, and pairing tried each of them.
  const others = [
    { name: 'Brother HL-2030._ipp._tcp.local', addresses: ['192.168.0.243'], txt: {} },
    { name: 'Living Room Speaker', addresses: ['192.168.0.235'], txt: { model: 'S1' } },
  ];
  assert.deepEqual(parseMdnsResults(others), []);
});

test('parseMdnsResults keeps a bridge whose TXT record lacks the id', () => {
  // Some firmwares publish no bridgeid in TXT; the service name still says Hue,
  // and identification will confirm it anyway.
  assert.deepEqual(parseMdnsResults([{ name: 'Philips Hue - 123456._hue._tcp.local', addresses: ['192.168.1.42'] }]), [
    { id: '', ip: '192.168.1.42' },
  ]);
});

test('discoverBridges finds the bridge on the LAN, without touching the cloud', async () => {
  const fetchMock = mock.method(global, 'fetch', async () => {
    throw new Error('the cloud must not be called');
  });
  const gladys = makeGladys({ ssdp: [HUE_SSDP_RESPONSE] });

  assert.deepEqual(await discoverBridges(gladys), [{ id: '001788fffe123456', ip: '192.168.1.42' }]);
  assert.deepEqual(gladys.calls, ['ssdp']);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('discoverBridges falls back to mDNS when SSDP finds nothing', async () => {
  const gladys = makeGladys({
    ssdp: [],
    mdns: [{ addresses: ['192.168.1.42'], txt: { bridgeid: 'ABC' } }],
  });
  assert.deepEqual(await discoverBridges(gladys), [{ id: 'abc', ip: '192.168.1.42' }]);
  assert.deepEqual(gladys.calls, ['ssdp', 'mdns']);
});

test('discoverBridges falls back to the cloud endpoint as a last resort', async () => {
  mock.method(global, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => [{ id: 'CLOUD1', internalipaddress: '192.168.1.99' }],
  }));
  const gladys = makeGladys({ ssdp: [], mdns: [] });

  assert.deepEqual(await discoverBridges(gladys), [{ id: 'cloud1', ip: '192.168.1.99' }]);
  assert.deepEqual(gladys.calls, ['ssdp', 'mdns']);
});

test('a failing scan does not break discovery, it moves on', async () => {
  mock.method(global, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => [{ id: 'CLOUD1', internalipaddress: '192.168.1.99' }],
  }));
  const gladys = makeGladys({ ssdp: new Error('429 too many scans'), mdns: new Error('mdns unavailable') });

  assert.deepEqual(await discoverBridges(gladys), [{ id: 'cloud1', ip: '192.168.1.99' }]);
});

test('discoverBridges returns an empty list when everything fails', async () => {
  mock.method(global, 'fetch', async () => {
    throw new Error('offline');
  });
  assert.deepEqual(await discoverBridges(makeGladys({ ssdp: [], mdns: [] })), []);
});

test('discoverBridges works without an SDK instance', async () => {
  mock.method(global, 'fetch', async () => ({ ok: true, status: 200, json: async () => [] }));
  assert.deepEqual(await discoverBridges(undefined), []);
});

test('a second discovery within the rate-limit window reuses the first result', async () => {
  // The core allows one mediated scan every 10 s: clicking "Discover bridges"
  // then "Pair bridge" must not earn the user a 429.
  const gladys = makeGladys({ ssdp: [HUE_SSDP_RESPONSE] });
  await discoverBridges(gladys);
  await discoverBridges(gladys);
  assert.deepEqual(gladys.calls, ['ssdp'], 'the network was scanned only once');
});

test('an N-UPnP HTTP error is swallowed', async () => {
  mock.method(global, 'fetch', async () => ({ ok: false, status: 500, json: async () => ({}) }));
  assert.deepEqual(await discoverBridges(makeGladys({ ssdp: [], mdns: [] })), []);
});

test('an unexpected N-UPnP body shape is swallowed', async () => {
  mock.method(global, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ error: 'nope' }) }));
  assert.deepEqual(await discoverBridges(makeGladys({ ssdp: [], mdns: [] })), []);
});

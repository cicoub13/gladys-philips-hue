import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { discoverBridges, parseSsdpResults, parseMdnsResults, resetDiscoveryCache } from '../src/hue/discovery.js';

/**
 * One SSDP responder, as the Gladys core relays it: `headers` is the raw
 * response text (networkDiscovery.scanSsdp.js, `payload.toString('utf8')`).
 * @param {string[]} lines - Response lines after the status line.
 * @param {object} [extra] - Fields overriding the default responder.
 * @returns {{ source_ip: string, source_port: number, headers: string }} Responder.
 */
function ssdpResponder(lines, extra = {}) {
  return {
    source_ip: '192.168.1.42',
    source_port: 1900,
    headers: ['HTTP/1.1 200 OK', ...lines, '', ''].join('\r\n'),
    ...extra,
  };
}

// What a Hue bridge (BSB002) answers to the M-SEARCH.
const HUE_SSDP_RESPONSE = ssdpResponder([
  'HOST: 239.255.255.250:1900',
  'EXT:',
  'CACHE-CONTROL: max-age=100',
  'LOCATION: http://192.168.1.42:80/description.xml',
  'SERVER: Hue/1.0 UPnP/1.0 IpBridge/1.60.0',
  'hue-bridgeid: 001788FFFE23BFC2',
  'ST: urn:schemas-upnp-org:device:basic:1',
  'USN: uuid:2f402f80-da50-11e1-9b23-00178823bfc2::urn:schemas-upnp-org:device:basic:1',
]);

// A Hue bridge as the core relays it from the `_hue._tcp` mDNS browse.
const HUE_MDNS_SERVICE = {
  name: 'Philips Hue - 23BFC2._hue._tcp.local',
  host: '001788fffe23bfc2.local',
  addresses: ['fe80::217:88ff:fe23:bfc2', '192.168.1.42'],
  port: 443,
  txt: ['bridgeid=001788fffe23bfc2', 'modelid=BSB002'],
};

const HUE_BRIDGE = { id: '001788fffe23bfc2', ip: '192.168.1.42' };

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

test('parseSsdpResults finds a Hue bridge in the raw SSDP response', () => {
  assert.deepEqual(parseSsdpResults([HUE_SSDP_RESPONSE]), [HUE_BRIDGE]);
});

test('parseSsdpResults ignores the other UPnP devices of the network', () => {
  // A printer or a TV answers the same M-SEARCH: without the hue-bridgeid
  // header we would offer them as bridges to pair with.
  const printer = ssdpResponder(
    [
      'LOCATION: http://192.168.1.5:631/desc.xml',
      'SERVER: CUPS/2.3 UPnP/1.0',
      'ST: urn:schemas-upnp-org:device:basic:1',
    ],
    { source_ip: '192.168.1.5' },
  );
  assert.deepEqual(parseSsdpResults([printer, HUE_SSDP_RESPONSE]), [HUE_BRIDGE]);
});

test('parseSsdpResults reads headers whatever their casing and line endings', () => {
  const lowercased = {
    source_ip: '192.168.1.42',
    source_port: 1900,
    headers: 'HTTP/1.1 200 OK\nlocation: http://192.168.1.42/description.xml\nhue-bridgeid: 001788FFFE23BFC2\n\n',
  };
  const uppercased = ssdpResponder(['LOCATION: http://192.168.1.43/description.xml', 'HUE-BRIDGEID: 001788FFFE23BFC3']);
  assert.deepEqual(parseSsdpResults([lowercased, uppercased]), [
    HUE_BRIDGE,
    { id: '001788fffe23bfc3', ip: '192.168.1.43' },
  ]);
});

test('parseSsdpResults falls back to the source IP without a usable LOCATION', () => {
  const noLocation = ssdpResponder(['hue-bridgeid: 001788FFFE23BFC2'], { source_ip: '192.168.1.50' });
  const badLocation = ssdpResponder(['LOCATION: not a url', 'hue-bridgeid: 001788FFFE23BFC2'], {
    source_ip: '192.168.1.51',
  });
  assert.deepEqual(parseSsdpResults([noLocation, badLocation]), [
    { id: '001788fffe23bfc2', ip: '192.168.1.50' },
    { id: '001788fffe23bfc2', ip: '192.168.1.51' },
  ]);
});

test('parseSsdpResults survives malformed responders', () => {
  assert.deepEqual(
    parseSsdpResults([
      null,
      'garbage',
      { source_ip: '192.168.1.42' },
      { source_ip: '192.168.1.42', headers: { 'hue-bridgeid': '001788FFFE23BFC2' } },
      { source_ip: '192.168.1.42', headers: 'not an HTTP response at all' },
      { headers: 'HTTP/1.1 200 OK\r\nhue-bridgeid: 001788FFFE23BFC2\r\n\r\n' },
      ssdpResponder(['hue-bridgeid:', 'LOCATION: http://192.168.1.42/description.xml']),
    ]),
    [],
  );
  assert.deepEqual(parseSsdpResults(undefined), []);
});

test('parseMdnsResults reads the bridge id from the TXT record and picks the IPv4 address', () => {
  assert.deepEqual(parseMdnsResults([HUE_MDNS_SERVICE]), [HUE_BRIDGE]);
});

test('parseMdnsResults keeps a bridge whose name does not say Hue, thanks to its TXT bridgeid', () => {
  // The instance name is not a reliable signal: the TXT bridgeid is.
  const renamed = { ...HUE_MDNS_SERVICE, name: 'Salon._hue._tcp.local', txt: ['BridgeID=001788FFFE23BFC2'] };
  assert.deepEqual(parseMdnsResults([renamed]), [HUE_BRIDGE]);
});

test('parseMdnsResults drops a service without a usable address', () => {
  assert.deepEqual(parseMdnsResults([{ ...HUE_MDNS_SERVICE, addresses: ['fe80::1'] }]), []);
  assert.deepEqual(parseMdnsResults(null), []);
  assert.deepEqual(parseMdnsResults([null, 'garbage']), []);
});

test('parseMdnsResults rejects a responder that is not a Hue bridge', () => {
  // The reported bug: an mDNS browse also surfaces printers, NAS and speakers.
  // Having an IPv4 address is NOT evidence of being a Hue bridge — without this
  // filter they were all offered as bridges, and pairing tried each of them.
  const others = [
    {
      name: 'Brother HL-2030._ipp._tcp.local',
      host: 'brother.local',
      addresses: ['192.168.0.243'],
      port: 631,
      txt: [],
    },
    {
      name: 'Living Room Speaker',
      host: null,
      addresses: ['192.168.0.235'],
      port: null,
      txt: ['model=S1', 'bridgeid'],
    },
  ];
  assert.deepEqual(parseMdnsResults(others), []);
});

test('parseMdnsResults keeps a bridge whose TXT record lacks the id', () => {
  // Some firmwares publish no bridgeid in TXT; the service name still says Hue,
  // and identification will confirm it anyway.
  assert.deepEqual(parseMdnsResults([{ ...HUE_MDNS_SERVICE, txt: [] }]), [{ id: '', ip: '192.168.1.42' }]);
});

test('discoverBridges finds the bridge on the LAN, without touching the cloud', async () => {
  const fetchMock = mock.method(global, 'fetch', async () => {
    throw new Error('the cloud must not be called');
  });
  const gladys = makeGladys({ ssdp: [HUE_SSDP_RESPONSE] });

  assert.deepEqual(await discoverBridges(gladys), [HUE_BRIDGE]);
  assert.deepEqual(gladys.calls, ['ssdp']);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('discoverBridges falls back to mDNS when SSDP finds no Hue bridge', async () => {
  const fetchMock = mock.method(global, 'fetch', async () => {
    throw new Error('the cloud must not be called');
  });
  const printer = ssdpResponder(['LOCATION: http://192.168.1.5:631/desc.xml'], { source_ip: '192.168.1.5' });
  const gladys = makeGladys({ ssdp: [printer], mdns: [HUE_MDNS_SERVICE] });

  assert.deepEqual(await discoverBridges(gladys), [HUE_BRIDGE]);
  assert.equal(fetchMock.mock.callCount(), 0);
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

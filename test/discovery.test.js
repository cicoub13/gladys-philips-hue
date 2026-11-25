import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import {
  discoverBridges,
  mergeBridges,
  parseSsdpResults,
  parseMdnsResults,
  resetDiscoveryCache,
} from '../src/hue/discovery.js';

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
 * The scan types the fake Gladys was asked for, in order.
 * @param {object} gladys - Fake Gladys (createFakeGladys).
 * @returns {string[]} Scan types.
 */
const scanTypes = (gladys) => gladys.fake.scans.map((scan) => scan.type);

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
  const gladys = createFakeGladys({ scanResults: { ssdp: [HUE_SSDP_RESPONSE] } });

  assert.deepEqual(await discoverBridges(gladys), [HUE_BRIDGE]);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('discoverBridges runs mDNS first, then SSDP, and merges them by bridge id', async () => {
  // A BSB002 answers both, a Bridge Pro only mDNS: stopping at the first method
  // that found something used to miss the Pro.
  const pro = {
    ...HUE_MDNS_SERVICE,
    name: 'Hue Bridge Pro - 0A1B2C._hue._tcp.local',
    addresses: ['192.168.1.43'],
    txt: ['bridgeid=c42996fffe0a1b2c', 'modelid=BSB003'],
  };
  const gladys = createFakeGladys({ scanResults: { ssdp: [HUE_SSDP_RESPONSE], mdns: [HUE_MDNS_SERVICE, pro] } });

  assert.deepEqual(await discoverBridges(gladys), [HUE_BRIDGE, { id: 'c42996fffe0a1b2c', ip: '192.168.1.43' }]);
  assert.deepEqual(scanTypes(gladys), ['mdns', 'ssdp']);
});

test('discoverBridges falls back to the cloud endpoint as a last resort', async () => {
  mock.method(global, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => [{ id: 'CLOUD1', internalipaddress: '192.168.1.99' }],
  }));
  const gladys = createFakeGladys({ scanResults: { ssdp: [], mdns: [] } });

  assert.deepEqual(await discoverBridges(gladys), [{ id: 'cloud1', ip: '192.168.1.99' }]);
  assert.deepEqual(scanTypes(gladys), ['mdns', 'ssdp']);
});

test('a background discovery never asks the cloud', async () => {
  const fetchMock = mock.method(global, 'fetch', async () => {
    throw new Error('the cloud must not be called');
  });
  assert.deepEqual(await discoverBridges(createFakeGladys(), { cloud: false }), []);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('mergeBridges keeps one entry per bridge, the first found', () => {
  assert.deepEqual(
    mergeBridges([
      { id: 'a', ip: '192.168.1.42' },
      { id: 'a', ip: '192.168.1.99' },
      { id: '', ip: '192.168.1.42' }, // the same bridge, its mDNS record without TXT
      { id: '', ip: '192.168.1.50' },
      { id: '', ip: '192.168.1.50' },
    ]),
    [
      { id: 'a', ip: '192.168.1.42' },
      { id: '', ip: '192.168.1.50' },
    ],
  );
});

test('a failing scan does not break discovery, it moves on', async (t) => {
  mock.method(global, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => [{ id: 'CLOUD1', internalipaddress: '192.168.1.99' }],
  }));
  const gladys = createFakeGladys();
  const scanNetwork = t.mock.method(gladys, 'scanNetwork', async (type) => {
    throw new Error(type === 'mdns' ? 'mdns unavailable' : '409 a scan is already running');
  });

  assert.deepEqual(await discoverBridges(gladys), [{ id: 'cloud1', ip: '192.168.1.99' }]);
  assert.equal(scanNetwork.mock.callCount(), 2, 'both scans were tried');
});

test('discoverBridges returns an empty list when everything fails', async () => {
  mock.method(global, 'fetch', async () => {
    throw new Error('offline');
  });
  assert.deepEqual(await discoverBridges(createFakeGladys()), []);
});

test('discoverBridges works without an SDK instance', async () => {
  mock.method(global, 'fetch', async () => ({ ok: true, status: 200, json: async () => [] }));
  assert.deepEqual(await discoverBridges(undefined), []);
});

test('a second discovery within a few seconds reuses the first result', async () => {
  // Clicking "Discover bridges" then "Pair bridge" must not wait for two more scans.
  const gladys = createFakeGladys({ scanResults: { ssdp: [HUE_SSDP_RESPONSE] } });
  await discoverBridges(gladys);
  await discoverBridges(gladys);
  assert.deepEqual(scanTypes(gladys), ['mdns', 'ssdp'], 'the network was scanned only once');
});

test('an N-UPnP HTTP error is swallowed', async () => {
  mock.method(global, 'fetch', async () => ({ ok: false, status: 500, json: async () => ({}) }));
  assert.deepEqual(await discoverBridges(createFakeGladys()), []);
});

test('an unexpected N-UPnP body shape is swallowed', async () => {
  mock.method(global, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ error: 'nope' }) }));
  assert.deepEqual(await discoverBridges(createFakeGladys()), []);
});

test('a discovery started during another one waits for it and takes its result', async () => {
  // The core runs one scan per integration at a time: a click on "Discover
  // bridges" during a background search used to get two refusals and nothing.
  const gladys = createFakeGladys({ scanResults: { mdns: [HUE_MDNS_SERVICE] } });
  const [background, clicked] = await Promise.all([discoverBridges(gladys, { cloud: false }), discoverBridges(gladys)]);
  assert.deepEqual(background, [HUE_BRIDGE]);
  assert.deepEqual(clicked, [HUE_BRIDGE]);
  assert.deepEqual(scanTypes(gladys), ['mdns', 'ssdp']);
});

test('a failed scan is not reused: the next discovery scans again', async (t) => {
  mock.method(global, 'fetch', async () => ({ ok: true, status: 200, json: async () => [] }));
  const gladys = createFakeGladys({ scanResults: { mdns: [HUE_MDNS_SERVICE] } });
  const scanNetwork = gladys.scanNetwork.bind(gladys);
  let refused = true;
  t.mock.method(gladys, 'scanNetwork', async (type, options) => {
    if (refused) {
      throw new Error('409 a scan is already running');
    }
    return scanNetwork(type, options);
  });
  assert.deepEqual(await discoverBridges(gladys), []);
  refused = false;
  assert.deepEqual(await discoverBridges(gladys), [HUE_BRIDGE]);
});

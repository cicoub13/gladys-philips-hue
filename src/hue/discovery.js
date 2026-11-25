// -----------------------------------------------------------------------------
// Bridge discovery, local first.
//
//   1. mDNS  — the Gladys core runs in network=host and browses the `_hue._tcp`
//              service on our behalf (manifest `network_discovery`), which is
//              the only way to reach the LAN from our isolated container. The
//              method Signify recommends, and the only one the Bridge Pro
//              answers.
//   2. SSDP  — same mediated mechanism, an M-SEARCH: a Hue bridge answers with a
//              `hue-bridgeid` header. Deprecated by Signify, kept for the
//              bridges whose mDNS does not reach Gladys.
//   3. N-UPnP— Philips' https://discovery.meethue.com/ endpoint. It is a CLOUD
//              service: it needs Internet access and only returns bridges seen
//              from the same public IP. Only when the LAN found nothing: it still
//              rescues setups where multicast is filtered.
//
// mDNS and SSDP both run, one after the other (the core runs one scan per
// integration at a time), and their results are merged by bridge id: with a
// BSB002 and a Bridge Pro, SSDP alone only finds the BSB002. Every step is
// best-effort: a failure moves on and an empty result is a valid answer (the
// user can always type the IP manually).
//
// Docs: https://developers.meethue.com/develop/get-started-2/ (discovery)
// -----------------------------------------------------------------------------

import { createLogger, parseMdnsTxt } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'hue-discovery' });

const NUPNP_URL = 'https://discovery.meethue.com/';
// Two scans, then the cloud, then the identification of what they found must
// fit in the 20 s of the "Discover bridges" and "Pair bridge" actions. A bridge
// answers an mDNS query or an M-SEARCH within a second.
const DISCOVERY_TIMEOUT_MS = 5000;
const SCAN_TIMEOUT_SECONDS = 3;

// Both the "Discover bridges" button and the pairing flow discover, and so does
// the background search for a bridge that changed address: a fresh result of
// the LAN scans is reused for a short while, instead of scanning again.
const SCAN_CACHE_MS = 10000;

let scanCache = { at: -Infinity, bridges: [] };

/**
 * Parse the raw text of an SSDP response (`HTTP/1.1 200 OK` then `Name: value`
 * lines, CRLF or LF) into its headers. Header names are case-insensitive, so
 * they are lowercased; the first occurrence of a header wins.
 * @param {string} text - Raw SSDP response.
 * @returns {Map<string, string>} Lowercased header name → trimmed value.
 */
function parseSsdpHeaders(text) {
  const headers = new Map();
  for (const line of text.split('\n')) {
    // The status line has no colon; a value may contain some (LOCATION URL).
    const separator = line.indexOf(':');
    const name = separator > 0 ? line.slice(0, separator).trim().toLowerCase() : '';
    if (name && !headers.has(name)) {
      headers.set(name, line.slice(separator + 1).trim());
    }
  }
  return headers;
}

/**
 * Extract the host of a `LOCATION` URL (e.g. `http://192.168.1.42:80/description.xml`).
 * @param {string} location - The LOCATION header.
 * @returns {string} Hostname, or an empty string.
 */
function hostFromLocation(location) {
  try {
    return new URL(location).hostname;
  } catch {
    return '';
  }
}

/**
 * Keep only the Hue bridges of an SSDP scan result.
 *
 * The core relays each responder as `{ source_ip, source_port, headers }`,
 * where `headers` is the raw response text: parsing it is our job.
 * @param {Array<{ source_ip?: string, headers?: string }>} responders - Raw SSDP responders.
 * @returns {Array<{ id: string, ip: string }>} Hue bridges.
 */
export function parseSsdpResults(responders) {
  return (Array.isArray(responders) ? responders : [])
    .filter((responder) => responder && typeof responder.headers === 'string')
    .map((responder) => {
      const headers = parseSsdpHeaders(responder.headers);
      return {
        // Only a Hue bridge advertises `hue-bridgeid`; without it we would offer
        // every UPnP device on the network as a candidate. Lowercased like the
        // `bridgeid` of /api/config, which is the id the bridge is stored under.
        id: (headers.get('hue-bridgeid') || '').toLowerCase(),
        ip:
          hostFromLocation(headers.get('location') || '') ||
          (typeof responder.source_ip === 'string' ? responder.source_ip : ''),
      };
    })
    .filter((bridge) => bridge.id && bridge.ip);
}

/**
 * Keep only the Hue bridges of an mDNS scan result.
 *
 * An mDNS browse is noisy — printers, speakers and everything else that
 * announces itself can come back. Requiring evidence of Hue here (and not just
 * an IP) is what stops the rest of the network from being offered as bridges.
 * The SDK hands us `[{ name, host, addresses, port, txt }]`, `txt` being the
 * raw `key=value` entries of the TXT record.
 * @param {Array<{ name?: string, addresses?: string[], txt?: string[] }>} services - Browsed services.
 * @returns {Array<{ id: string, ip: string }>} Hue bridges.
 */
export function parseMdnsResults(services) {
  return (Array.isArray(services) ? services : [])
    .filter((service) => service && typeof service === 'object')
    .map((service) => {
      // A Hue bridge publishes its id in the TXT record (`bridgeid=…`);
      // parseMdnsTxt lowercases the keys. A bare `bridgeid` entry is `true`.
      const { bridgeid } = parseMdnsTxt(service.txt);
      return {
        id: typeof bridgeid === 'string' ? bridgeid.trim().toLowerCase() : '',
        // Fallback for firmwares that omit the TXT record: the service instance
        // name still carries `_hue._tcp` / "Philips Hue".
        hue: /hue/i.test(String(service.name || '')),
        // IPv4 first: the bridge v1 API is plain HTTP on an IPv4 address.
        ip: (service.addresses || []).find((address) => address.includes('.')) || '',
      };
    })
    .filter((bridge) => bridge.ip && (bridge.id || bridge.hue))
    .map(({ id, ip }) => ({ id, ip }));
}

/**
 * Run one mediated network scan, swallowing every failure.
 * @param {object} gladys - The GladysIntegration SDK instance.
 * @param {string} type - Scan type (`ssdp` or `mdns`).
 * @param {Function} parse - Parser turning the raw results into bridges.
 * @returns {Promise<Array<{ id: string, ip: string }>>} Discovered bridges.
 */
async function mediatedScan(gladys, type, parse) {
  if (!gladys || typeof gladys.scanNetwork !== 'function') {
    return [];
  }
  try {
    const results = await gladys.scanNetwork(type, { timeoutSeconds: SCAN_TIMEOUT_SECONDS });
    const bridges = parse(results);
    logger.info(`Discovered ${bridges.length} Hue bridge(s) via ${type.toUpperCase()}`);
    return bridges;
  } catch (error) {
    logger.warn(`${type.toUpperCase()} discovery failed: ${error.message}`);
    return [];
  }
}

/**
 * Discover Hue bridges through the Philips N-UPnP cloud endpoint.
 * @returns {Promise<Array<{ id: string, ip: string }>>} Discovered bridges.
 */
async function discoverViaNupnp() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const response = await fetch(NUPNP_URL, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`N-UPnP discovery returned HTTP ${response.status}`);
    }
    const body = await response.json();
    // Body shape: [{ id: "...", internalipaddress: "192.168.x.y", port: 443 }]
    const bridges = (Array.isArray(body) ? body : [])
      .filter((entry) => entry && entry.internalipaddress)
      .map((entry) => ({ id: String(entry.id || '').toLowerCase(), ip: String(entry.internalipaddress) }));
    logger.info(`Discovered ${bridges.length} Hue bridge(s) via N-UPnP`);
    return bridges;
  } catch (error) {
    logger.warn(`N-UPnP discovery failed: ${error.message}`);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Merge the bridges found by several methods, by bridge id: the first one found
 * wins. A bridge found without an id (an mDNS record without TXT) is dropped
 * when another result gives the id of its address.
 * @param {Array<{ id: string, ip: string }>} found - Bridges, in order of preference.
 * @returns {Array<{ id: string, ip: string }>} One entry per bridge.
 */
export function mergeBridges(found) {
  const byId = new Map();
  for (const bridge of found) {
    if (bridge.id && !byId.has(bridge.id)) {
      byId.set(bridge.id, bridge);
    }
  }
  const identifiedIps = new Set([...byId.values()].map((bridge) => bridge.ip));
  const byIp = new Map();
  for (const bridge of found) {
    if (!bridge.id && !identifiedIps.has(bridge.ip) && !byIp.has(bridge.ip)) {
      byIp.set(bridge.ip, bridge);
    }
  }
  return [...byId.values(), ...byIp.values()];
}

/**
 * Discover the Hue bridges reachable on the network: mDNS and SSDP merged, then
 * the Philips cloud endpoint as a last resort.
 * @param {object} [gladys] - SDK instance, required for the mediated LAN scans.
 * @param {{ cloud?: boolean }} [options] - `cloud: false` never asks the cloud (background searches).
 * @returns {Promise<Array<{ id: string, ip: string }>>} Discovered bridges.
 */
export async function discoverBridges(gladys, { cloud = true } = {}) {
  let bridges;
  if (performance.now() - scanCache.at < SCAN_CACHE_MS) {
    logger.debug('Reusing the bridges discovered a few seconds ago');
    bridges = scanCache.bridges;
  } else {
    const mdns = await mediatedScan(gladys, 'mdns', parseMdnsResults);
    const ssdp = await mediatedScan(gladys, 'ssdp', parseSsdpResults);
    bridges = mergeBridges([...mdns, ...ssdp]);
    scanCache = { at: performance.now(), bridges };
  }
  if (bridges.length === 0 && cloud) {
    return discoverViaNupnp();
  }
  return bridges;
}

/**
 * Forget the cached scan result (used by the tests).
 * @returns {void}
 */
export function resetDiscoveryCache() {
  scanCache = { at: -Infinity, bridges: [] };
}

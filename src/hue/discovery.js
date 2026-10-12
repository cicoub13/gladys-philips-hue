// -----------------------------------------------------------------------------
// Bridge discovery, local first.
//
// Three methods are tried in order, and the first one that finds something wins:
//
//   1. SSDP  — the Gladys core runs in network=host and performs the M-SEARCH on
//              our behalf (manifest `network_discovery`), which is the only way
//              to reach the LAN from our isolated container. A Hue bridge
//              answers with a `hue-bridgeid` header.
//   2. mDNS  — same mediated mechanism, browsing the `_hue._tcp` service.
//   3. N-UPnP— Philips' https://discovery.meethue.com/ endpoint. It is a CLOUD
//              service: it needs Internet access and only returns bridges seen
//              from the same public IP. Kept as a last resort because it still
//              rescues setups where multicast is filtered.
//
// Every step is best-effort: a failure moves on to the next one and an empty
// result is a valid answer (the user can always type the IP manually).
//
// Docs: https://developers.meethue.com/develop/get-started-2/ (discovery)
// -----------------------------------------------------------------------------

import { createLogger, parseMdnsTxt } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'hue-discovery' });

const NUPNP_URL = 'https://discovery.meethue.com/';
const DISCOVERY_TIMEOUT_MS = 8000;
const SCAN_TIMEOUT_SECONDS = 5;

// The core allows one mediated scan every 10 seconds per integration. Both the
// "Discover bridges" button and the pairing flow discover, and a user clicking
// them in a row would hit a 429 — so a fresh result is reused for a short while.
const SCAN_CACHE_MS = 10000;

let scanCache = { at: 0, bridges: [] };

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
 * Discover the Hue bridges reachable on the network: SSDP, then mDNS, then the
 * Philips cloud endpoint as a last resort.
 * @param {object} [gladys] - SDK instance, required for the mediated LAN scans.
 * @returns {Promise<Array<{ id: string, ip: string }>>} Discovered bridges.
 */
export async function discoverBridges(gladys) {
  if (Date.now() - scanCache.at < SCAN_CACHE_MS) {
    logger.debug('Reusing the bridges discovered a few seconds ago');
    return scanCache.bridges;
  }

  let bridges = await mediatedScan(gladys, 'ssdp', parseSsdpResults);
  if (bridges.length === 0) {
    bridges = await mediatedScan(gladys, 'mdns', parseMdnsResults);
  }
  if (bridges.length === 0) {
    bridges = await discoverViaNupnp();
  }

  scanCache = { at: Date.now(), bridges };
  return bridges;
}

/**
 * Forget the cached scan result (used by the tests).
 * @returns {void}
 */
export function resetDiscoveryCache() {
  scanCache = { at: 0, bridges: [] };
}

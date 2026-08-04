// -----------------------------------------------------------------------------
// Bridge identification.
//
// Discovery tells us "something answered on this IP" — it never proves the thing
// IS a Hue bridge. mDNS in particular is noisy: a browse can surface printers,
// speakers or any other responder on the LAN. Pairing blindly against those ends
// in `fetch failed` (nothing on port 80) or `HTTP 404` (some other web server).
//
// So every candidate is PROVEN here, with the unauthenticated `/api/config`
// endpoint that every bridge generation serves:
//
//   { "name": "Philips hue", "bridgeid": "001788FFFE1234AB", "modelid": "BSB002",
//     "apiversion": "1.63.0", "swversion": "1963089030" }
//
// `bridgeid` is the discriminator: no other device on a home network exposes it.
// The check stays deliberately lenient on `modelid` (BSB001 = v1 round,
// BSB002 = v2 square, and whatever Signify ships next) so a future model is not
// rejected for being unknown.
//
// Docs: https://developers.meethue.com/develop/hue-api/
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { HueBridgeClient } from './bridge.js';

const logger = createLogger({ name: 'hue-identify' });

// Short on purpose: this runs against every discovery candidate, over two
// schemes, and the whole "Discover"/"Pair" action must answer well within the
// 20 s budget the manifest declares. A device that is not a bridge must not
// hold the button hostage.
const IDENTIFY_TIMEOUT_MS = 3500;

/**
 * Turn an `/api/config` body into a bridge identity, or `undefined` when the
 * body does not look like a Hue bridge.
 * @param {string} ip - Address the body came from.
 * @param {any} body - Parsed JSON body.
 * @param {string} [scheme] - Scheme that worked (`http` or `https`).
 * @param {string} [certFingerprint] - Certificate pinned during the probe (HTTPS only).
 * @returns {{ ip: string, id: string, name: string, model: string, apiVersion: string, scheme: string, certFingerprint?: string } | undefined} Identity.
 */
export function parseBridgeConfig(ip, body, scheme = 'http', certFingerprint) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return undefined;
  }
  const id = String(body.bridgeid || '').toLowerCase();
  const model = String(body.modelid || '');
  const apiVersion = String(body.apiversion || '');
  // `bridgeid` alone is already conclusive; the second field only guards against
  // a device that would coincidentally expose an unrelated `bridgeid` key.
  if (!id || (!model && !apiVersion)) {
    return undefined;
  }
  return {
    ip,
    id,
    name: String(body.name || 'Philips hue'),
    model,
    apiVersion,
    scheme,
    ...(certFingerprint ? { certFingerprint } : {}),
  };
}

/**
 * Prove that an address hosts a Philips Hue bridge.
 *
 * Tries plain HTTP first (the v1 API every bridge still serves), then HTTPS:
 * Signify is progressively blocking HTTP, and recent firmwares answer only on
 * TLS. Never throws — an unidentified candidate is simply not a bridge.
 * @param {string} ip - Candidate address.
 * @returns {Promise<object | undefined>} Identity, or `undefined`.
 */
export async function identifyBridge(ip) {
  for (const scheme of ['http', 'https']) {
    const client = new HueBridgeClient(ip, undefined, { scheme, timeoutMs: IDENTIFY_TIMEOUT_MS });
    try {
      // No retry: a candidate that does not answer once is not worth a second
      // round, and there may be many of them.
      const body = await client.getConfig({ retries: 0 });
      const identity = parseBridgeConfig(ip, body, scheme, client.certFingerprint);
      if (identity) {
        logger.debug(`${ip} is a Hue bridge: ${identity.name} (${identity.model || 'unknown model'}) over ${scheme}`);
        return identity;
      }
      logger.debug(`Ignoring ${ip}: answered on ${scheme} but is not a Hue bridge`);
      // It answered and it is not a bridge: no point trying the other scheme.
      return undefined;
    } catch (error) {
      logger.debug(`Ignoring ${ip} over ${scheme}: ${error.message}`);
    }
  }
  return undefined;
}

/**
 * Identify a list of candidate addresses, in parallel, keeping only the ones
 * that really are Hue bridges.
 * @param {Array<{ ip: string }>} candidates - Discovery candidates.
 * @returns {Promise<{ bridges: Array<object>, ignored: string[] }>} Proven bridges and rejected addresses.
 */
export async function identifyBridges(candidates) {
  const usable = (candidates || []).filter((candidate) => candidate && candidate.ip);
  const results = await Promise.all(usable.map((candidate) => identifyBridge(candidate.ip)));

  const bridges = [];
  const ignored = [];
  results.forEach((identity, index) => {
    if (identity) {
      bridges.push(identity);
    } else {
      ignored.push(usable[index].ip);
    }
  });

  if (ignored.length > 0) {
    logger.info(`Ignored ${ignored.length} device(s) that are not Hue bridges: ${ignored.join(', ')}`);
  }
  return { bridges, ignored };
}

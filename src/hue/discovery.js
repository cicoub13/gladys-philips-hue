// -----------------------------------------------------------------------------
// Bridge discovery.
//
// Philips exposes an official "N-UPnP" discovery endpoint that returns the Hue
// bridges seen on the same public IP as the caller. It is the simplest and most
// reliable method from inside a container (no multicast/mDNS needed) and is what
// the official apps fall back to.
//
// Docs: https://developers.meethue.com/develop/get-started-2/ (discovery)
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'hue-discovery' });

const NUPNP_URL = 'https://discovery.meethue.com/';
const DISCOVERY_TIMEOUT_MS = 8000;

/**
 * Discover Hue bridges reachable from this network via the N-UPnP service.
 * @returns {Promise<Array<{ id: string, ip: string }>>} Discovered bridges.
 */
export async function discoverBridges() {
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
    logger.warn(`Bridge discovery failed: ${error.message}`);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

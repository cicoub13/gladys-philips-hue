// -----------------------------------------------------------------------------
// Philips Hue bridge REST client (local network, v1 API).
//
// We deliberately use the classic HTTP v1 API (`http://<ip>/api/...`):
//   - it is available on every Hue bridge,
//   - it avoids the self-signed-certificate problem of the HTTPS CLIP v2 API
//     (we must never disable TLS verification), and
//   - it is more than enough to control lights.
//
// Docs: https://developers.meethue.com/develop/hue-api/
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'hue-bridge' });

const REQUEST_TIMEOUT_MS = 8000;

// Hue error type returned while the physical link button has NOT been pressed.
export const HUE_LINK_BUTTON_NOT_PRESSED = 101;

/**
 * Thin client around one Philips Hue bridge.
 */
export class HueBridgeClient {
  /**
   * @param {string} ip - Bridge IP address on the local network.
   * @param {string} [username] - Bridge API username (a.k.a. application key).
   */
  constructor(ip, username) {
    this.ip = ip;
    this.username = username;
  }

  /**
   * Perform an HTTP request to the bridge with a timeout.
   * @param {string} path - Path appended to `http://<ip>`.
   * @param {object} [options] - Fetch options (method, body...).
   * @returns {Promise<any>} Parsed JSON response.
   */
  async request(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`http://${this.ip}${path}`, {
        ...options,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      });
      if (!response.ok) {
        throw new Error(`Bridge ${this.ip} returned HTTP ${response.status} on ${path}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Create a new API user on the bridge. The physical link button must have
   * been pressed within the last ~30 seconds.
   * @param {string} appName - Identifies this integration on the bridge.
   * @returns {Promise<string>} The created username (application key).
   * @throws {Error} With `.hueErrorType === 101` when the button was not pressed.
   */
  async createUser(appName = 'gladys#philips-hue') {
    const body = await this.request('/api', {
      method: 'POST',
      body: JSON.stringify({ devicetype: appName }),
    });
    const first = Array.isArray(body) ? body[0] : undefined;
    if (first && first.success && first.success.username) {
      this.username = first.success.username;
      logger.info(`Paired with bridge ${this.ip}`);
      return this.username;
    }
    const errorType = first && first.error ? first.error.type : undefined;
    const error = new Error(
      first && first.error ? first.error.description : `Unexpected pairing response from bridge ${this.ip}`,
    );
    error.hueErrorType = errorType;
    throw error;
  }

  /**
   * Fetch every light known by the bridge.
   * @returns {Promise<Record<string, object>>} Lights indexed by bridge id.
   */
  async getLights() {
    this.assertUsername();
    return this.request(`/api/${this.username}/lights`);
  }

  /**
   * Fetch a single light by its bridge id.
   * @param {string} id - Light id on the bridge.
   * @returns {Promise<object>} The light object.
   */
  async getLight(id) {
    this.assertUsername();
    return this.request(`/api/${this.username}/lights/${id}`);
  }

  /**
   * Update the state of a light (on/off, brightness, color...).
   * @param {string} id - Light id on the bridge.
   * @param {object} state - Hue state payload, e.g. `{ on: true, bri: 254 }`.
   * @returns {Promise<any>} The bridge response.
   */
  async setLightState(id, state) {
    this.assertUsername();
    return this.request(`/api/${this.username}/lights/${id}/state`, {
      method: 'PUT',
      body: JSON.stringify(state),
    });
  }

  /**
   * @private
   * @throws {Error} When no username has been set yet.
   */
  assertUsername() {
    if (!this.username) {
      throw new Error(`Bridge ${this.ip} is not paired yet (missing username)`);
    }
  }
}

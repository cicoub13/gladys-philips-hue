// -----------------------------------------------------------------------------
// Philips Hue bridge REST client (local network, v1 API).
//
// We deliberately use the classic HTTP v1 API (`http://<ip>/api/...`):
//   - it is available on every Hue bridge,
//   - it avoids the self-signed-certificate problem of the HTTPS CLIP v2 API
//     (we must never disable TLS verification), and
//   - it is more than enough to control lights.
//
// Two traps this client handles for its callers:
//   1. the v1 API answers HTTP 200 with a body `[{"error": {...}}]` for MOST
//      failures (revoked username, unknown light, refused value) — a raw
//      `response.ok` check would let those through as valid data;
//   2. the username is an access key to the whole bridge, so it must never
//      appear in an error message: those bubble up to the Gladys logs and UI.
//
// Docs: https://developers.meethue.com/develop/hue-api/
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'hue-bridge' });

const REQUEST_TIMEOUT_MS = 8000;

// A bridge under load answers 429/503; a Wi-Fi hiccup rejects the fetch outright.
// Both are worth one short retry — a lost command means a light that ignores the
// user. Hue business errors are NEVER retried: they would fail identically.
const DEFAULT_RETRIES = 1;
const RETRY_DELAY_MS = 400;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

// Hue error type returned while the physical link button has NOT been pressed.
export const HUE_LINK_BUTTON_NOT_PRESSED = 101;

/**
 * Sleep for a given duration.
 * @param {number} ms - Milliseconds to wait.
 * @returns {Promise<void>} Resolves after the delay.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract the Hue error object of a v1 response body, if any. The bridge always
 * answers with an array of per-command results, e.g.
 * `[{ "error": { "type": 1, "address": "/lights", "description": "unauthorized user" } }]`.
 * @param {any} body - Parsed JSON body.
 * @returns {{ type: number, description: string } | undefined} The first error found.
 */
export function findHueError(body) {
  const entries = Array.isArray(body) ? body : [body];
  const failed = entries.find((entry) => entry && entry.error);
  return failed ? failed.error : undefined;
}

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
   * Replace the username with a placeholder so it never reaches a log or the
   * Gladys UI: it is the access key to the bridge.
   * @param {string} path - Request path, possibly containing the username.
   * @returns {string} Path safe to display.
   */
  redact(path) {
    return this.username ? path.split(this.username).join('***') : path;
  }

  /**
   * Perform one HTTP request to the bridge, with a timeout.
   * @param {string} path - Path appended to `http://<ip>`.
   * @param {object} options - Fetch options (method, body...).
   * @returns {Promise<any>} Parsed JSON response.
   */
  async fetchOnce(path, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`http://${this.ip}${path}`, {
        ...options,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      });
      if (!response.ok) {
        const error = new Error(`Bridge ${this.ip} returned HTTP ${response.status} on ${this.redact(path)}`);
        error.httpStatus = response.status;
        throw error;
      }
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Perform an HTTP request to the bridge, retrying transient failures, and
   * surface the Hue errors hidden in HTTP 200 bodies as thrown errors.
   * @param {string} path - Path appended to `http://<ip>`.
   * @param {object} [options] - Fetch options, plus `retries` (default 1).
   * @returns {Promise<any>} Parsed JSON response, guaranteed error-free.
   * @throws {Error} With `.hueErrorType` set for a Hue business error.
   */
  async request(path, options = {}) {
    const { retries = DEFAULT_RETRIES, ...fetchOptions } = options;
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const body = await this.fetchOnce(path, fetchOptions);
        const hueError = findHueError(body);
        if (hueError) {
          // A business error: the bridge understood us and said no. Retrying
          // would fail the same way.
          const error = new Error(
            `Bridge ${this.ip} refused ${this.redact(path)}: ${hueError.description || 'unknown Hue error'}`,
          );
          error.hueErrorType = hueError.type;
          throw error;
        }
        return body;
      } catch (error) {
        const retryable = error.httpStatus === undefined || RETRYABLE_STATUS.has(error.httpStatus);
        if (error.hueErrorType !== undefined || !retryable || attempt === retries) {
          throw error;
        }
        lastError = error;
        logger.debug(`Retrying ${this.redact(path)} on bridge ${this.ip}: ${error.message}`);
        await sleep(RETRY_DELAY_MS);
      }
    }

    throw lastError;
  }

  /**
   * Create a new API user on the bridge. The physical link button must have
   * been pressed within the last ~30 seconds.
   * @param {string} appName - Identifies this integration on the bridge.
   * @returns {Promise<string>} The created username (application key).
   * @throws {Error} With `.hueErrorType === 101` when the button was not pressed.
   */
  async createUser(appName = 'gladys#philips-hue') {
    // No retry: creating a user is not idempotent, a blind second attempt could
    // leave an orphan username on the bridge (which allows ~63 of them).
    const body = await this.request('/api', {
      method: 'POST',
      body: JSON.stringify({ devicetype: appName }),
      retries: 0,
    });
    const first = Array.isArray(body) ? body[0] : undefined;
    if (first && first.success && first.success.username) {
      this.username = first.success.username;
      logger.info(`Paired with bridge ${this.ip}`);
      return this.username;
    }
    throw new Error(`Unexpected pairing response from bridge ${this.ip}`);
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
    // Retried on purpose: setting a state is idempotent (absolute values).
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

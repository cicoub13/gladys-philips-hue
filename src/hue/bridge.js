// -----------------------------------------------------------------------------
// Philips Hue bridge REST client (local network).
//
// Lights are read and commanded through the classic v1 API (`/api/...`):
//   - it is available on every Hue bridge generation (v1 round, v2 square), and
//   - it is more than enough to control lights.
// From the v2 API (`/clip/v2/...`, HTTPS only), the client only opens the event
// stream and reads what it takes to understand it (see `./v2.js`).
//
// New pairings use HTTPS whenever the bridge serves it, and plain HTTP otherwise
// (BSB001). A bridge paired over HTTP keeps using it until its firmware blocks
// it (1.78+): it is then switched to HTTPS on the fly, with the same username
// (see `upgradeToHttps`). The TLS side (private-CA certificate, trust-on-first-use
// pinning) lives in `./https.js`; this client only carries the `scheme` and the
// pinned fingerprint around.
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
import { openStream, requestJson } from './https.js';
import { RequestQueue } from './queue.js';

const logger = createLogger({ name: 'hue-bridge' });

const REQUEST_TIMEOUT_MS = 8000;

// A Wi-Fi hiccup rejects the fetch outright: worth one short retry, a lost
// command means a light that ignores the user. Not more: a bridge that does not
// answer costs a full timeout per attempt. Hue business errors are NEVER
// retried: they would fail identically.
const DEFAULT_RETRIES = 1;
const RETRY_DELAY_MS = 400;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

// A bridge under load answers 429/503 right away: retried a few times, each one
// later than the last. Every attempt queues again behind the other requests to
// the bridge (see ./queue.js), so a burst of commands spreads out instead of
// failing, within the 5 s Gladys gives a command.
const BUSY_RETRY_DELAYS_MS = [250, 500, 1000];

// How long a request may wait for its turn in the bridge's queue (see
// ./queue.js): a command, less than the 5 s Gladys waits for it.
const MAX_QUEUE_WAIT_MS = 20000;
const COMMAND_MAX_QUEUE_WAIT_MS = 4000;

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
 * Whether a plain HTTP failure means the bridge refuses HTTP and must be reached
 * over HTTPS: firmware 1.78+ answers `403 unauthorized user - HTTP access is
 * blocked`, and a bridge may also close port 80 altogether.
 * @param {Error & { httpStatus?: number, cause?: { code?: string } }} error - HTTP failure.
 * @returns {boolean} True when HTTPS is worth a try.
 */
export function isHttpBlocked(error) {
  return error.httpStatus === 403 || (error.cause && error.cause.code) === 'ECONNREFUSED';
}

/**
 * The error to raise when HTTP is blocked and HTTPS failed too. A transient
 * HTTPS failure (no answer, 429/5xx) is raised as such, so the request is
 * retried, and the bridge counted unreachable when nothing answered at all;
 * anything else (not the expected bridge, other status) keeps the
 * classification of the HTTP error, flagged `httpsSwitchFailed`.
 * @param {Error & { httpStatus?: number }} httpError - Why HTTP failed.
 * @param {Error & { httpStatus?: number, tlsRefused?: boolean, wrongBridge?: boolean }} httpsError - Why
 * HTTPS failed.
 * @returns {Error & { httpStatus?: number }} Error carrying both reasons.
 */
function upgradeFailure(httpError, httpsError) {
  const transient =
    !httpsError.tlsRefused &&
    !httpsError.wrongBridge &&
    (httpsError.httpStatus === undefined || RETRYABLE_STATUS.has(httpsError.httpStatus));
  const error = new Error(`${httpError.message}; HTTPS failed too: ${httpsError.message}`);
  const status = transient ? httpsError.httpStatus : httpError.httpStatus;
  if (status !== undefined) {
    error.httpStatus = status;
  }
  if (!transient) {
    // The bridge answered (its 403) but cannot be used: callers must not take
    // that answer as proof that it is gone.
    error.httpsSwitchFailed = true;
  }
  return error;
}

/**
 * Thin client around one Philips Hue bridge.
 */
export class HueBridgeClient {
  /**
   * @param {string} ip - Bridge IP address on the local network.
   * @param {string} [username] - Bridge API username (a.k.a. application key).
   * @param {{ scheme?: string, id?: string, certFingerprint?: string, timeoutMs?: number, queue?: RequestQueue,
   *   onHttpsUpgrade?: (transport: { scheme: string, certFingerprint?: string }) => Promise<void> }} [options] -
   * Transport details resolved at identification time (see `./identify.js`) and persisted by the store.
   * `onHttpsUpgrade` enables the switch to HTTPS of a bridge that blocks HTTP, and persists it. `queue` is
   * shared by every client of the same bridge (see `./queue.js`).
   */
  constructor(ip, username, options = {}) {
    this.ip = ip;
    this.username = username;
    // The scheme the bridge was paired on; plain HTTP for entries saved before
    // the scheme was stored.
    this.scheme = options.scheme === 'https' ? 'https' : 'http';
    this.id = options.id;
    // Pinned on the first HTTPS contact, then enforced (see `./https.js`).
    this.certFingerprint = options.certFingerprint;
    // Identification probes every discovery candidate and must stay snappy, so
    // it shortens this; normal traffic keeps the generous default.
    this.timeoutMs = options.timeoutMs || REQUEST_TIMEOUT_MS;
    this.onHttpsUpgrade = options.onHttpsUpgrade;
    this.queue = options.queue || new RequestQueue();
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
   * Perform one request to the bridge, with a timeout, switching a paired
   * bridge that blocks HTTP to HTTPS (see `upgradeToHttps`).
   *
   * Errors are re-thrown with the username stripped out of the path: they end up
   * in the Gladys logs and UI, and the username is the key to the whole bridge.
   * @param {string} path - Path appended to `<scheme>://<ip>`.
   * @param {object} options - Request options (method, body...).
   * @returns {Promise<any>} Parsed JSON response.
   */
  async fetchOnce(path, options) {
    if (this.scheme === 'http' && this.onHttpsUpgrade) {
      try {
        return await this.fetchWith(path, options);
      } catch (error) {
        if (!isHttpBlocked(error)) {
          throw error;
        }
        await this.upgradeToHttps(error);
      }
    }
    // Replayed over HTTPS after a switch, with the same username: the
    // application key is not tied to the transport, so no link-button press.
    return this.fetchWith(path, options);
  }

  /**
   * Switch this client to HTTPS, once: concurrent requests refused over HTTP
   * share the same switch. When it fails, the client stays on HTTP and the next
   * refused request tries again.
   * @param {Error} httpError - Why HTTP failed.
   * @returns {Promise<void>} Resolves once the client talks HTTPS.
   * @throws {Error} Both reasons, classified by `upgradeFailure`.
   */
  async upgradeToHttps(httpError) {
    if (!this.httpsUpgrade) {
      this.httpsUpgrade = this.probeHttps().catch((error) => {
        this.httpsUpgrade = undefined;
        throw error;
      });
    }
    try {
      await this.httpsUpgrade;
    } catch (error) {
      throw upgradeFailure(httpError, error);
    }
  }

  /**
   * Prove that the bridge answers on HTTPS, pin its certificate, then hand the
   * new transport to `onHttpsUpgrade` to be persisted.
   *
   * The proof is the unauthenticated `/api/config`: nothing secret is sent to a
   * peer not proven yet, and its certificate must carry the id the bridge
   * announces there (and the stored id, when the store has one).
   *
   * Trust-on-first-use limit: this is not a user-initiated pairing, and a 403 or
   * a refused port 80 is unauthenticated. A host impersonating the bridge on the
   * LAN (ARP spoofing) can trigger the switch and get its own certificate pinned,
   * as long as it names the bridge id, which is public (`/api/config`, mDNS).
   * The same host already reads the username over plain HTTP; once it is gone,
   * the real bridge fails the pin until it is paired again. Checking the chain
   * against Signify's root CA would close this (issue #48, §4.11).
   * @returns {Promise<void>} Resolves once switched.
   */
  async probeHttps() {
    const probe = new HueBridgeClient(this.ip, undefined, { scheme: 'https', id: this.id, timeoutMs: this.timeoutMs });
    const body = await probe.fetchWith('/api/config', {});
    const announced = String((body && body.bridgeid) || '').toLowerCase();
    const expected = this.id ? String(this.id).toLowerCase() : announced;
    if (!announced || announced !== expected) {
      // With a stored id, the TLS layer already required it as the certificate
      // CN: what differs here is the bridge answering at this address.
      const error = new Error(
        `Bridge ${this.ip} announces ${announced ? `bridge ${announced}` : 'no bridge id'} on HTTPS, expected ${expected || 'a bridge id'}`,
      );
      error.wrongBridge = true;
      throw error;
    }
    if (probe.certCommonName !== announced) {
      const error = new Error(
        `Bridge ${this.ip} answered on HTTPS with a certificate for "${probe.certCommonName}", not for bridge ${announced}`,
      );
      error.tlsRefused = true;
      throw error;
    }
    this.certFingerprint = probe.certFingerprint;
    this.scheme = 'https';
    logger.info(`Bridge ${this.ip} blocks plain HTTP, switched to HTTPS`);
    await this.onHttpsUpgrade({ scheme: 'https', certFingerprint: this.certFingerprint });
  }

  /**
   * One request over the current scheme.
   * @param {string} path - Request path.
   * @param {object} options - Request options.
   * @returns {Promise<any>} Parsed JSON response.
   */
  async fetchWith(path, options) {
    // HTTPS needs certificate inspection, which the global `fetch` cannot do:
    // that path goes through `node:https` (see ./https.js). Plain HTTP keeps
    // using `fetch` — no TLS to verify, and nothing to gain from switching.
    if (this.scheme === 'https') {
      try {
        const body = await requestJson(`https://${this.ip}${path}`, {
          ...options,
          timeoutMs: this.timeoutMs,
          pinnedFingerprint: this.certFingerprint,
          bridgeId: this.id,
        });
        // First contact: remember what we trusted so the caller can persist it,
        // and whom the certificate names, for the caller to check.
        if (body && body.fingerprint && !this.certFingerprint) {
          this.certFingerprint = body.fingerprint;
          this.certCommonName = body.commonName;
        }
        return body;
      } catch (error) {
        error.message = this.redact(error.message);
        throw error;
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
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
   * @param {object} [options] - Fetch options, plus `retries`: retries of a request that got no answer (default
   * 1). `0` also disables the retries of a busy answer (429/5xx). `maxWaitMs`: the latest the request may be
   * sent, from this call (20 s by default), all attempts and pauses included; beyond, it fails with
   * `queueTimeout` set, or with the last error when no retry fits.
   * @returns {Promise<any>} Parsed JSON response, guaranteed error-free.
   * @throws {Error} With `.hueErrorType` set for a Hue business error.
   */
  async request(path, options = {}) {
    const { retries = DEFAULT_RETRIES, maxWaitMs = MAX_QUEUE_WAIT_MS, ...fetchOptions } = options;
    // One deadline for every attempt: a retry must not reach the light after
    // Gladys gave up on the command.
    const sendBy = performance.now() + maxWaitMs;
    let silentRetries = 0;
    let busyRetries = 0;

    for (;;) {
      try {
        const body = await this.queue.run(() => this.fetchOnce(path, fetchOptions), {
          maxWaitMs: sendBy - performance.now(),
        });
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
        let delay;
        if (error.queueTimeout) {
          error.message = `Bridge ${this.ip} is busy: ${this.redact(path)} ${error.message}`;
          throw error;
        } else if (error.hueErrorType !== undefined) {
          throw error;
        } else if (error.httpStatus === undefined && silentRetries < retries) {
          silentRetries += 1;
          delay = RETRY_DELAY_MS;
        } else if (RETRYABLE_STATUS.has(error.httpStatus) && retries > 0 && busyRetries < BUSY_RETRY_DELAYS_MS.length) {
          delay = BUSY_RETRY_DELAYS_MS[busyRetries];
          busyRetries += 1;
        } else {
          throw error;
        }
        if (performance.now() + delay >= sendBy) {
          throw error; // no time left for another attempt
        }
        logger.debug(`Retrying ${this.redact(path)} on bridge ${this.ip}: ${error.message}`);
        await sleep(delay);
      }
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
   * Read the unauthenticated bridge description (`bridgeid`, `modelid`,
   * `apiversion`...). Also the endpoint used to prove a device IS a bridge.
   * @returns {Promise<object>} The bridge configuration.
   */
  async getConfig(options = {}) {
    return this.request('/api/config', options);
  }

  /**
   * Fetch every light known by the bridge.
   * @param {{ retries?: number }} [options] - Request options (see `request`).
   * @returns {Promise<Record<string, object>>} Lights indexed by bridge id.
   */
  async getLights(options = {}) {
    this.assertUsername();
    return this.request(`/api/${this.username}/lights`, options);
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
      maxWaitMs: COMMAND_MAX_QUEUE_WAIT_MS,
    });
  }

  /**
   * Fetch every group (rooms, zones...) known by the bridge.
   * @returns {Promise<Record<string, object>>} Groups indexed by bridge id.
   */
  async getGroups() {
    this.assertUsername();
    return this.request(`/api/${this.username}/groups`);
  }

  /**
   * Fetch every scene stored on the bridge (without their light states).
   * @returns {Promise<Record<string, object>>} Scenes indexed by bridge id.
   */
  async getScenes() {
    this.assertUsername();
    return this.request(`/api/${this.username}/scenes`);
  }

  /**
   * Recall a scene on a group. Group `0` is the special "all lights" group,
   * the one a scene not tied to a room is recalled on.
   * @param {string} groupId - Group id on the bridge.
   * @param {string} sceneId - Scene id on the bridge.
   * @returns {Promise<any>} The bridge response.
   */
  async recallScene(groupId, sceneId) {
    this.assertUsername();
    // Retried on purpose: recalling a scene twice lands in the same state.
    return this.request(`/api/${this.username}/groups/${groupId}/action`, {
      method: 'PUT',
      body: JSON.stringify({ scene: sceneId }),
    });
  }

  /**
   * Move a bridge paired over HTTP to HTTPS now, without waiting for its
   * firmware to block HTTP: the v2 API, and its event stream, only exist over
   * HTTPS. Same proof and persistence as the switch of a blocked bridge.
   * @returns {Promise<void>} Resolves once the client talks HTTPS.
   * @throws {Error} Why HTTPS failed: `code` `ECONNREFUSED` when the bridge has no HTTPS at all (round bridge),
   * `tlsRefused` or `wrongBridge` when what answers is not this bridge.
   */
  async switchToHttps() {
    if (this.scheme !== 'https') {
      await this.probeHttps();
    }
  }

  /**
   * Whether the bridge serves the v2 API: it refuses `/clip/v2/resource`
   * without a key (403), like aiohue's `is_v2_bridge` checks. The round bridge,
   * and square bridges older than firmware 1.48, answer 404. HTTPS only.
   * @returns {Promise<boolean>} True for a v2 bridge.
   * @throws {Error} When the bridge did not answer, or was busy (429/5xx): the next attempt will tell.
   */
  async isV2() {
    if (this.scheme !== 'https') {
      return false;
    }
    try {
      await this.queue.run(() => this.fetchWith('/clip/v2/resource', {}));
      return false;
    } catch (error) {
      if (error.httpStatus === undefined || RETRYABLE_STATUS.has(error.httpStatus)) {
        throw error;
      }
      return error.httpStatus === 403;
    }
  }

  /**
   * Read every v2 resource of a type (`light`, `zigbee_connectivity`…).
   * @param {string} type - Resource type.
   * @returns {Promise<Array<object>>} The resources.
   */
  async getResources(type) {
    this.assertUsername();
    const body = await this.queue.run(() =>
      this.fetchWith(`/clip/v2/resource/${type}`, { headers: { 'hue-application-key': this.username } }),
    );
    return Array.isArray(body && body.data) ? body.data : [];
  }

  /**
   * Open the v2 event stream. Not queued: it stays open.
   * @returns {Promise<{ response: import('node:http').IncomingMessage, close: () => void }>} The open stream.
   */
  openEventStream() {
    this.assertUsername();
    if (this.scheme !== 'https') {
      return Promise.reject(new Error(`Bridge ${this.ip} has no event stream over HTTP`));
    }
    return openStream(`https://${this.ip}/eventstream/clip/v2`, {
      headers: { Accept: 'text/event-stream', 'hue-application-key': this.username },
      timeoutMs: this.timeoutMs,
      pinnedFingerprint: this.certFingerprint,
      bridgeId: this.id,
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

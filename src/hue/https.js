// -----------------------------------------------------------------------------
// HTTP(S) transport for the Hue bridge.
//
// Why not the global `fetch`: a Hue bridge serves a certificate signed by
// Signify's own private CA (older units: plainly self-signed), with the bridge
// id as Common Name. No public root trusts it, so `fetch` rejects the handshake
// and gives us no hook to inspect the certificate. Node's built-in `node:https`
// does — and it costs no extra dependency.
//
// Trust model (TOFU, the same one Home Assistant uses for Hue):
//   1. first contact — the certificate is accepted, but ONLY after checking that
//      its Common Name matches the bridge id the bridge announces. Its SHA-256
//      fingerprint is then handed back to the caller, which pins it in /data;
//   2. later contacts — the pinned fingerprint must match, otherwise the request
//      is refused: something answers in place of the bridge we paired with.
//
// `rejectUnauthorized: false` is therefore never "no verification": it hands the
// verification to us, and we do it against the pin. HTTP stays the default —
// this path only matters for bridges/firmwares that refuse plain HTTP.
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { createHash } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 8000;

// Bodies are small JSON documents; this only guards against a rogue endpoint
// streaming megabytes at us.
const MAX_BODY_BYTES = 5 * 1024 * 1024;

/**
 * Normalize a certificate fingerprint for comparison.
 * @param {string} fingerprint - Raw fingerprint.
 * @returns {string} Uppercase fingerprint without separators.
 */
export function normalizeFingerprint(fingerprint) {
  return String(fingerprint || '')
    .replace(/[^a-fA-F0-9]/g, '')
    .toUpperCase();
}

/**
 * Compute the SHA-256 fingerprint of a DER-encoded certificate.
 * @param {Buffer} der - Raw certificate.
 * @returns {string} Uppercase hex fingerprint.
 */
export function fingerprintOf(der) {
  return createHash('sha256').update(der).digest('hex').toUpperCase();
}

/**
 * Decide whether a bridge certificate may be trusted.
 *
 * Either it matches the fingerprint we pinned when pairing, or — on first
 * contact — its Common Name is the bridge id, which is what Signify issues.
 * @param {{ subject?: { CN?: string }, raw?: Buffer }} certificate - Peer certificate.
 * @param {{ pinnedFingerprint?: string, bridgeId?: string }} options - Trust inputs.
 * @returns {{ trusted: boolean, fingerprint: string, reason?: string }} Verdict.
 */
export function checkCertificate(certificate, options = {}) {
  const fingerprint = certificate && certificate.raw ? fingerprintOf(certificate.raw) : '';
  const pinned = normalizeFingerprint(options.pinnedFingerprint);

  if (!fingerprint) {
    return { trusted: false, fingerprint, reason: 'the peer did not provide a certificate' };
  }

  if (pinned) {
    return fingerprint === pinned
      ? { trusted: true, fingerprint }
      : {
          trusted: false,
          fingerprint,
          reason: 'the bridge certificate changed since pairing (possible impersonation on the network)',
        };
  }

  const commonName = String((certificate && certificate.subject && certificate.subject.CN) || '').toLowerCase();
  const bridgeId = String(options.bridgeId || '').toLowerCase();
  if (bridgeId) {
    if (!commonName) {
      return { trusted: false, fingerprint, reason: `the certificate does not identify bridge ${bridgeId}` };
    }
    if (commonName !== bridgeId) {
      return {
        trusted: false,
        fingerprint,
        reason: `the certificate identifies "${commonName}" instead of bridge ${bridgeId}`,
      };
    }
  }
  // First contact: nothing to compare against yet, the caller pins what we return.
  return { trusted: true, fingerprint };
}

/**
 * HTTPS agent that completes its connection callback only AFTER the peer
 * certificate has been checked. Node does not assign the socket to the HTTP
 * request before that callback, so no path, header or body can reach a peer
 * whose certificate does not match the stored pin.
 */
class VerifiedHttpsAgent extends https.Agent {
  /**
   * @param {URL} target - Request target.
   * @param {{ pinnedFingerprint?: string, bridgeId?: string, timeoutMs: number }} verification - Trust inputs.
   */
  constructor(target, verification) {
    super({ keepAlive: false });
    this.hostname = target.hostname;
    this.port = Number(target.port) || 443;
    this.verification = verification;
    this.fingerprint = '';
    this.commonName = '';
  }

  /**
   * Establish and authenticate TLS before handing the socket to HTTPS.
   * @param {object} _options - Connection options supplied by https.Agent.
   * @param {(error: Error | null, socket?: import('node:tls').TLSSocket) => void} callback - Agent callback.
   * @returns {undefined} The socket is deliberately delivered asynchronously.
   */
  createConnection(_options, callback) {
    const socket = tls.connect({
      host: this.hostname,
      port: this.port,
      // RFC 6066 forbids IP literals in SNI. Hue certificates identify the
      // bridge id rather than its DHCP address anyway.
      ...(net.isIP(this.hostname) ? {} : { servername: this.hostname }),
      // Hue uses a private/self-signed PKI; checkCertificate is the trust root.
      rejectUnauthorized: false,
    });
    let settled = false;

    const finish = (error, verifiedSocket) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        socket.destroy();
      }
      callback(error || null, verifiedSocket);
    };

    const timer = setTimeout(() => {
      finish(new Error(`Bridge ${this.hostname} did not complete TLS within ${this.verification.timeoutMs} ms`));
    }, this.verification.timeoutMs);

    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate();
      const verdict = checkCertificate(certificate, this.verification);
      if (!verdict.trusted) {
        finish(new Error(`Refused the TLS certificate of ${this.hostname}: ${verdict.reason}`));
        return;
      }
      this.fingerprint = verdict.fingerprint;
      this.commonName = String((certificate.subject && certificate.subject.CN) || '');
      finish(undefined, socket);
    });
    socket.once('error', (error) => finish(error));
    return undefined;
  }
}

/**
 * Perform an HTTP or HTTPS request and parse the JSON answer.
 *
 * On HTTPS the peer certificate is validated by `checkCertificate` and its
 * fingerprint is exposed as `response.fingerprint` so the caller can pin it.
 * @param {string} url - Absolute URL (`http://…` or `https://…`).
 * @param {object} [options] - `method`, `body`, `headers`, `timeoutMs`, `pinnedFingerprint`, `bridgeId`.
 * @returns {Promise<any>} Parsed JSON body, carrying a non-enumerable `fingerprint` for HTTPS.
 */
export function requestJson(url, options = {}) {
  const { method = 'GET', body, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, pinnedFingerprint, bridgeId } = options;

  const target = new URL(url);
  const secure = target.protocol === 'https:';
  const transport = secure ? https : http;
  const agent = secure ? new VerifiedHttpsAgent(target, { pinnedFingerprint, bridgeId, timeoutMs }) : undefined;

  return new Promise((resolve, reject) => {
    const request = transport.request(
      target,
      {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        ...(secure ? { agent } : {}),
      },
      (response) => {
        const fingerprint = agent ? agent.fingerprint : '';

        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            response.destroy();
            request.destroy();
            reject(new Error(`Response from ${target.hostname} is too large`));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const status = response.statusCode;
          if (status < 200 || status >= 300) {
            const error = new Error(`Bridge ${target.hostname} returned HTTP ${status} on ${target.pathname}`);
            error.httpStatus = status;
            reject(error);
            return;
          }
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (fingerprint && parsed && typeof parsed === 'object') {
              // Non-enumerable: it must never leak into a JSON.stringify of the body.
              Object.defineProperty(parsed, 'fingerprint', { value: fingerprint, enumerable: false });
              Object.defineProperty(parsed, 'certificateCommonName', {
                value: agent.commonName,
                enumerable: false,
              });
            }
            resolve(parsed);
          } catch {
            reject(new Error(`Bridge ${target.hostname} returned a non-JSON body on ${target.pathname}`));
          }
        });
      },
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Bridge ${target.hostname} did not answer within ${timeoutMs} ms`));
    });
    request.on('error', reject);

    if (body !== undefined) {
      request.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    request.end();
  });
}

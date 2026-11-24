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
// verification to us, and we do it against the pin, right after the handshake and
// BEFORE the request is written: its path carries the username, the key to the
// whole bridge, which must never reach an impostor.
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
 * Without a known bridge id, the caller must compare `commonName` with the id
 * the bridge announces before pinning (see `./identify.js`).
 * @param {{ subject?: { CN?: string }, raw?: Buffer }} certificate - Peer certificate.
 * @param {{ pinnedFingerprint?: string, bridgeId?: string }} options - Trust inputs.
 * @returns {{ trusted: boolean, fingerprint: string, commonName: string, reason?: string }} Verdict.
 */
export function checkCertificate(certificate, options = {}) {
  const fingerprint = certificate && certificate.raw ? fingerprintOf(certificate.raw) : '';
  const commonName = String((certificate && certificate.subject && certificate.subject.CN) || '').toLowerCase();
  const pinned = normalizeFingerprint(options.pinnedFingerprint);

  if (pinned) {
    return fingerprint === pinned
      ? { trusted: true, fingerprint, commonName }
      : {
          trusted: false,
          fingerprint,
          commonName,
          reason: 'the bridge certificate changed since pairing (possible impersonation on the network)',
        };
  }

  const bridgeId = String(options.bridgeId || '').toLowerCase();
  if (bridgeId && commonName !== bridgeId) {
    return {
      trusted: false,
      fingerprint,
      commonName,
      reason: `the certificate identifies "${commonName}" instead of bridge ${bridgeId}`,
    };
  }
  // First contact: nothing to compare against yet, the caller pins what we return.
  return { trusted: true, fingerprint, commonName };
}

/**
 * Open a TLS connection and hand it to the request only once its certificate
 * passed `checkCertificate`: until then nothing is written on it.
 * @param {URL} target - Request URL.
 * @param {{ pinnedFingerprint?: string, bridgeId?: string }} trust - Trust inputs.
 * @param {(socket: tls.TLSSocket) => void} onSocket - Receives the socket as soon as it exists.
 * @param {(verdict: object) => void} onVerdict - Receives the verdict of a trusted certificate.
 * @returns {Function} `createConnection` for `https.request`.
 */
function verifiedConnection(target, trust, onSocket, onVerdict) {
  return (options, oncreate) => {
    const socket = tls.connect({
      host: target.hostname,
      port: Number(target.port) || 443,
      rejectUnauthorized: false,
      // SNI only carries host names: an IP address there is deprecated (DEP0123).
      ...(net.isIP(target.hostname) ? {} : { servername: target.hostname }),
    });
    onSocket(socket);
    const onError = (error) => oncreate(error);
    socket.once('error', onError);
    socket.once('secureConnect', () => {
      socket.removeListener('error', onError);
      const verdict = checkCertificate(socket.getPeerCertificate(), trust);
      if (!verdict.trusted) {
        const error = new Error(`Refused the TLS certificate of ${target.hostname}: ${verdict.reason}`);
        error.tlsRefused = true;
        socket.destroy();
        oncreate(error);
        return;
      }
      onVerdict(verdict);
      oncreate(null, socket);
    });
  };
}

/**
 * Perform an HTTP or HTTPS request and parse the JSON answer.
 *
 * On HTTPS the peer certificate is validated by `checkCertificate` before the
 * request is sent; its fingerprint and Common Name are exposed on the body so
 * the caller can pin it. A refused certificate fails with `error.tlsRefused`.
 * @param {string} url - Absolute URL (`http://…` or `https://…`).
 * @param {object} [options] - `method`, `body`, `headers`, `timeoutMs`, `pinnedFingerprint`, `bridgeId`.
 * @returns {Promise<any>} Parsed JSON body, carrying non-enumerable `fingerprint` and `commonName` for HTTPS.
 */
export function requestJson(url, options = {}) {
  const { method = 'GET', body, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, pinnedFingerprint, bridgeId } = options;

  const target = new URL(url);
  const secure = target.protocol === 'https:';
  const transport = secure ? https : http;

  return new Promise((resolvePromise, rejectPromise) => {
    // The TLS socket exists before the request gets it (after the certificate
    // check): the deadline must be able to close it during the handshake too.
    let socket;
    let verdict;
    // One overall deadline for the whole exchange. A socket timeout only
    // measures inactivity, so a bridge trickling bytes would never trip it.
    let deadline;
    const resolve = (value) => {
      clearTimeout(deadline);
      resolvePromise(value);
    };
    const reject = (error) => {
      clearTimeout(deadline);
      rejectPromise(error);
    };

    const request = transport.request(
      target,
      {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        // See the trust model above: we verify the certificate ourselves.
        ...(secure
          ? {
              // Without an agent nothing tells the request that HTTPS defaults to
              // 443: the Host header would read `<ip>:80`.
              defaultPort: 443,
              createConnection: verifiedConnection(
                target,
                { pinnedFingerprint, bridgeId },
                (created) => {
                  socket = created;
                },
                (trusted) => {
                  verdict = trusted;
                },
              ),
            }
          : {}),
      },
      (response) => {
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
            if (verdict && parsed && typeof parsed === 'object') {
              // Non-enumerable: they must never leak into a JSON.stringify of the body.
              Object.defineProperty(parsed, 'fingerprint', { value: verdict.fingerprint, enumerable: false });
              Object.defineProperty(parsed, 'commonName', { value: verdict.commonName, enumerable: false });
            }
            resolve(parsed);
          } catch {
            reject(new Error(`Bridge ${target.hostname} returned a non-JSON body on ${target.pathname}`));
          }
        });
        // A connection dropped mid-body emits neither 'end' nor 'error' on the
        // response: without this the promise would never settle.
        response.on('close', () => {
          if (!response.complete) {
            reject(new Error(`Bridge ${target.hostname} closed the connection before the end of its answer`));
          }
        });
      },
    );

    deadline = setTimeout(() => {
      const error = new Error(`Bridge ${target.hostname} did not answer within ${timeoutMs} ms`);
      reject(error);
      request.destroy(error);
      if (socket) {
        socket.destroy();
      }
    }, timeoutMs);
    request.on('error', reject);

    if (body !== undefined) {
      request.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    request.end();
  });
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { checkCertificate, fingerprintOf, normalizeFingerprint, requestJson } from '../src/hue/https.js';

const BRIDGE_ID = '001788fffe123456';

/**
 * Build a fake peer certificate.
 * @param {string} commonName - Certificate CN.
 * @param {string} raw - Bytes standing in for the DER body.
 * @returns {{ subject: { CN: string }, raw: Buffer }} Fake certificate.
 */
function certificate(commonName, raw = 'bridge-cert') {
  return { subject: { CN: commonName }, raw: Buffer.from(raw) };
}

test('normalizeFingerprint ignores separators and case', () => {
  assert.equal(normalizeFingerprint('aa:bb:cc'), 'AABBCC');
  assert.equal(normalizeFingerprint(undefined), '');
});

test('a bridge is trusted on first contact when the CN is its bridge id', () => {
  const verdict = checkCertificate(certificate(BRIDGE_ID.toUpperCase()), { bridgeId: BRIDGE_ID });
  assert.equal(verdict.trusted, true);
  assert.equal(verdict.fingerprint, fingerprintOf(Buffer.from('bridge-cert')), 'the pin to persist is returned');
});

test('a certificate issued for someone else is refused on first contact', () => {
  const verdict = checkCertificate(certificate('some-other-device'), { bridgeId: BRIDGE_ID });
  assert.equal(verdict.trusted, false);
  assert.match(verdict.reason, /identifies "some-other-device"/);
});

test('a pinned bridge is trusted only while its certificate does not change', () => {
  const pinned = fingerprintOf(Buffer.from('bridge-cert'));
  assert.equal(checkCertificate(certificate(BRIDGE_ID), { pinnedFingerprint: pinned }).trusted, true);

  const swapped = checkCertificate(certificate(BRIDGE_ID, 'someone-elses-cert'), { pinnedFingerprint: pinned });
  assert.equal(swapped.trusted, false, 'something answers in place of the bridge we paired with');
  assert.match(swapped.reason, /changed since pairing/);
});

test('the pin wins over the common name', () => {
  // Once pinned, a matching certificate is trusted even if Signify reissues it
  // with a different CN — and a mismatching one is refused whatever its CN.
  const pinned = fingerprintOf(Buffer.from('bridge-cert'));
  assert.equal(
    checkCertificate(certificate('anything'), { pinnedFingerprint: pinned, bridgeId: BRIDGE_ID }).trusted,
    true,
  );
});

test('first contact without a known bridge id still yields a pin', () => {
  const verdict = checkCertificate(certificate('whatever'), {});
  assert.equal(verdict.trusted, true);
  assert.ok(verdict.fingerprint.length > 0);
});

/**
 * Start a local HTTP server for the duration of one test.
 * @param {Function} handler - Request handler.
 * @returns {Promise<{ url: string, close: () => void }>} Server address and closer.
 */
async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/api/config`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

test('a connection cut in the middle of the answer fails the request instead of hanging it', async () => {
  // The bridge reboots or the Wi-Fi drops after the headers: the promise used to
  // never settle, and the poll, command or action waiting on it neither.
  const server = await serve((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
    response.write('{"name":');
    setTimeout(() => request.socket.destroy(), 20);
  });
  try {
    await assert.rejects(() => requestJson(server.url, { timeoutMs: 5000 }), /closed the connection/);
  } finally {
    server.close();
  }
});

test('a bridge trickling its answer is cut at the overall deadline', async () => {
  // The socket timeout only measures inactivity: a byte every 100 ms kept a
  // request alive forever. The deadline bounds the whole exchange.
  const server = await serve((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    const drip = setInterval(() => response.write(' '), 100);
    response.on('close', () => clearInterval(drip));
  });
  const started = Date.now();
  try {
    await assert.rejects(() => requestJson(server.url, { timeoutMs: 600 }), /did not answer within 600 ms/);
    assert.ok(Date.now() - started < 3000, 'the deadline fired on time');
  } finally {
    server.close();
  }
});

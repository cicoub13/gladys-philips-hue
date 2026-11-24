import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
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

test('a certificate without a common name is refused when a bridge id is expected', () => {
  const verdict = checkCertificate(certificate(''), { bridgeId: BRIDGE_ID });
  assert.equal(verdict.trusted, false);
});

test('first contact without a known bridge id still yields a pin, and the CN for the caller to check', () => {
  const verdict = checkCertificate(certificate('Whatever'), {});
  assert.equal(verdict.trusted, true);
  assert.ok(verdict.fingerprint.length > 0);
  assert.equal(verdict.commonName, 'whatever');
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

/**
 * Route `tls.connect` to a local plain HTTP server, presenting a fake
 * certificate: the real `https.request` runs on top, and what it writes reaches
 * the server.
 * @param {string} url - URL of the local server.
 * @param {string} commonName - CN of the fake certificate.
 */
function tlsTo(url, commonName) {
  const { port } = new URL(url);
  mock.method(tls, 'connect', () => {
    const socket = net.connect(Number(port), '127.0.0.1');
    socket.getPeerCertificate = () => certificate(commonName);
    socket.once('connect', () => socket.emit('secureConnect'));
    return socket;
  });
}

test('an HTTPS request names the bridge in its Host header, without the default port', async (t) => {
  // Without an agent, the request believed the default port was 80.
  t.after(() => mock.restoreAll());
  const hosts = [];
  const server = await serve((request, response) => {
    hosts.push(request.headers.host);
    response.end('{}');
  });
  tlsTo(server.url, BRIDGE_ID);
  try {
    const body = await requestJson('https://127.0.0.1/api/config', { bridgeId: BRIDGE_ID });
    assert.equal(body.commonName, BRIDGE_ID);
    assert.deepEqual(hosts, ['127.0.0.1']);
  } finally {
    server.close();
  }
});

test('nothing is written to a peer whose certificate is refused', async (t) => {
  // The request path carries the username: an impostor must not even read it.
  t.after(() => mock.restoreAll());
  const received = [];
  const server = await serve((request, response) => {
    received.push(request.url);
    response.end('{}');
  });
  tlsTo(server.url, 'impostor');
  try {
    const error = await requestJson('https://127.0.0.1/api/secret-username/lights', { bridgeId: BRIDGE_ID }).catch(
      (caught) => caught,
    );
    assert.equal(error.tlsRefused, true);
    assert.deepEqual(received, []);
  } finally {
    server.close();
  }
});

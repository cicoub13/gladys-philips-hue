import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

test('a missing certificate is always refused', () => {
  const verdict = checkCertificate({}, { bridgeId: BRIDGE_ID });
  assert.equal(verdict.trusted, false);
  assert.match(verdict.reason, /did not provide a certificate/);
});

test('a known bridge id requires a certificate common name', () => {
  const verdict = checkCertificate({ raw: Buffer.from('bridge-cert'), subject: {} }, { bridgeId: BRIDGE_ID });
  assert.equal(verdict.trusted, false);
  assert.match(verdict.reason, /does not identify bridge/);
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

test('a wrong certificate pin is rejected before an authenticated request is sent', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hue-tls-'));
  const keyFile = path.join(directory, 'key.pem');
  const certFile = path.join(directory, 'cert.pem');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-sha256',
      '-nodes',
      '-keyout',
      keyFile,
      '-out',
      certFile,
      '-days',
      '1',
      '-subj',
      `/CN=${BRIDGE_ID}`,
    ],
    { stdio: 'ignore' },
  );

  const requests = [];
  const server = https.createServer(
    { key: await fs.readFile(keyFile), cert: await fs.readFile(certFile) },
    (request, response) => {
      requests.push(request.url);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ bridgeid: BRIDGE_ID, modelid: 'BSB002' }));
    },
  );
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const config = await requestJson(`https://127.0.0.1:${port}/api/config`, { bridgeId: BRIDGE_ID });
  assert.equal(requests.length, 1);
  assert.ok(config.fingerprint, 'the verified certificate fingerprint is returned for persistence');

  requests.length = 0;
  await assert.rejects(
    () =>
      requestJson(`https://127.0.0.1:${port}/api/super-secret-username/lights`, {
        pinnedFingerprint: '00'.repeat(32),
      }),
    /certificate changed/,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests, [], 'the rejected peer never receives the credential-bearing HTTP path');
});

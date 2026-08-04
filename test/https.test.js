import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCertificate, fingerprintOf, normalizeFingerprint } from '../src/hue/https.js';

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

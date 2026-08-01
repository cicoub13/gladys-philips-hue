import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, isValidBridgeHost, DEFAULT_CONFIG, POLL_FREQUENCIES } from '../src/config.js';

test('normalizeConfig returns defaults when empty', () => {
  const config = normalizeConfig();
  assert.equal(config.bridge_ip, DEFAULT_CONFIG.bridge_ip);
  assert.equal(config.poll_frequency, DEFAULT_CONFIG.poll_frequency);
});

test('every default and option is a poll frequency Gladys accepts', () => {
  // Gladys stores poll_frequency in an ENUM column, in milliseconds: any other
  // value is rejected by the database and the device is never polled.
  assert.ok(POLL_FREQUENCIES.includes(DEFAULT_CONFIG.poll_frequency));
  POLL_FREQUENCIES.forEach((frequency) => {
    assert.ok(frequency >= 10000, `${frequency} ms is too aggressive for a Hue bridge`);
  });
});

test('normalizeConfig accepts the select values as strings and trims the IP', () => {
  const config = normalizeConfig({ bridge_ip: '  192.168.1.42  ', poll_frequency: '15000' });
  assert.equal(config.bridge_ip, '192.168.1.42');
  assert.equal(config.poll_frequency, 15000);
});

test('normalizeConfig falls back to the default on a frequency Gladys would reject', () => {
  // The value the pre-1.0.4 manifest used to send: seconds, not milliseconds.
  assert.equal(normalizeConfig({ poll_frequency: 60 }).poll_frequency, DEFAULT_CONFIG.poll_frequency);
  assert.equal(normalizeConfig({ poll_frequency: 'abc' }).poll_frequency, DEFAULT_CONFIG.poll_frequency);
  assert.equal(normalizeConfig({ poll_frequency: 3600 }).poll_frequency, DEFAULT_CONFIG.poll_frequency);
});

test('isValidBridgeHost accepts addresses and hostnames, rejects the rest', () => {
  assert.ok(isValidBridgeHost('192.168.1.42'));
  assert.ok(isValidBridgeHost('hue-bridge.local'));
  assert.ok(!isValidBridgeHost(''));
  assert.ok(!isValidBridgeHost('192.168.1.300'), 'octet above 255');
  assert.ok(!isValidBridgeHost('evil.com/api/x'), 'a path would target another endpoint');
  assert.ok(!isValidBridgeHost('http://192.168.1.42'), 'a scheme would break the URL built from it');
  assert.ok(!isValidBridgeHost('192.168.1.42:80/x'));
});

test('normalizeConfig drops an unusable bridge_ip but keeps it for the error message', () => {
  const config = normalizeConfig({ bridge_ip: 'evil.com/api/x' });
  assert.equal(config.bridge_ip, '');
  assert.equal(config.bridge_ip_rejected, 'evil.com/api/x');
});

test('normalizeConfig reports no rejection for a valid address', () => {
  assert.equal(normalizeConfig({ bridge_ip: '10.0.0.1' }).bridge_ip_rejected, '');
});

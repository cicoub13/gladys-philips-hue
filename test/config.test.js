import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, DEFAULT_CONFIG } from '../src/config.js';

test('normalizeConfig returns defaults when empty', () => {
  const config = normalizeConfig();
  assert.equal(config.bridge_ip, DEFAULT_CONFIG.bridge_ip);
  assert.equal(config.poll_frequency, DEFAULT_CONFIG.poll_frequency);
});

test('normalizeConfig coerces string numbers and trims the IP', () => {
  const config = normalizeConfig({ bridge_ip: '  192.168.1.42  ', poll_frequency: '120' });
  assert.equal(config.bridge_ip, '192.168.1.42');
  assert.equal(config.poll_frequency, 120);
});

test('normalizeConfig clamps poll_frequency to a sane minimum', () => {
  assert.equal(normalizeConfig({ poll_frequency: 1 }).poll_frequency, 5);
});

test('normalizeConfig falls back to default on invalid poll_frequency', () => {
  assert.equal(normalizeConfig({ poll_frequency: 'abc' }).poll_frequency, DEFAULT_CONFIG.poll_frequency);
});

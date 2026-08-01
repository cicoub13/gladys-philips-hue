import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FEATURE,
  getCapabilities,
  briToPercent,
  percentToBri,
  rgbToInt,
  intToRgb,
  rgbToXy,
  xyToRgb,
  lightToDevicePayload,
  hueStateToFeatureStates,
  featureValueToHueState,
} from '../src/hue/mapping.js';

// Minimal external-ids helper mimicking gladys.externalIds(type, platformId).
function makeIds(platformId = 'bridge-abc') {
  const base = `ext:test:light:${platformId}`;
  return { device: base, feature: (key) => `${base}:${key}` };
}

const extendedColorLight = {
  name: 'Bureau',
  type: 'Extended color light',
  uniqueid: '00:17:88:01:aa',
  state: { on: true, bri: 254, xy: [0.675, 0.322], ct: 300 },
  capabilities: { control: { ct: { min: 153, max: 500 } } },
};

test('getCapabilities detects light features from type', () => {
  assert.deepEqual(getCapabilities({ type: 'On/Off light' }), {
    brightness: false,
    color: false,
    temperature: false,
  });
  assert.deepEqual(getCapabilities({ type: 'Dimmable light' }), {
    brightness: true,
    color: false,
    temperature: false,
  });
  assert.deepEqual(getCapabilities({ type: 'Color temperature light' }), {
    brightness: true,
    color: false,
    temperature: true,
  });
  assert.deepEqual(getCapabilities({ type: 'Extended color light' }), {
    brightness: true,
    color: true,
    temperature: true,
  });
});

test('brightness conversion is reversible around the range', () => {
  assert.equal(briToPercent(254), 100);
  assert.equal(percentToBri(100), 254);
  assert.equal(percentToBri(0), 1); // Hue bri never goes below 1
  assert.equal(percentToBri(50), 127);
});

test('a dimly lit light is never reported as 0 %', () => {
  // 0 % means "off" to featureValueToHueState: reporting it for a light that is
  // actually on would make Gladys show it off, then switch it off for real.
  assert.equal(briToPercent(1), 1);
  assert.deepEqual(featureValueToHueState(FEATURE.BRIGHTNESS, briToPercent(1), extendedColorLight), {
    on: true,
    bri: 3,
  });
});

test('rgb integer packing round-trips', () => {
  assert.equal(rgbToInt({ r: 255, g: 0, b: 0 }), 0xff0000);
  assert.deepEqual(intToRgb(0x00ff00), { r: 0, g: 255, b: 0 });
});

test('rgb <-> xy keeps the dominant channel', () => {
  const [x, y] = rgbToXy(0xff0000); // pure red
  assert.ok(x > 0.6 && x < 0.75, `red x in gamut: ${x}`);
  assert.ok(y > 0.25 && y < 0.35, `red y in gamut: ${y}`);
  const rgb = intToRgb(xyToRgb([x, y], 254));
  assert.ok(rgb.r >= rgb.g && rgb.r >= rgb.b, 'red stays dominant after round-trip');
});

test('lightToDevicePayload builds the right features for a color light', () => {
  const ids = makeIds();
  const payload = lightToDevicePayload(ids, extendedColorLight);
  assert.equal(payload.external_id, ids.device);
  const keys = payload.features.map((f) => f.external_id);
  assert.deepEqual(keys, [
    ids.feature(FEATURE.ON_OFF),
    ids.feature(FEATURE.BRIGHTNESS),
    ids.feature(FEATURE.COLOR),
    ids.feature(FEATURE.TEMPERATURE),
  ]);
  const ct = payload.features.find((f) => f.external_id === ids.feature(FEATURE.TEMPERATURE));
  assert.equal(ct.min, 153);
  assert.equal(ct.max, 500);
});

test('lightToDevicePayload only exposes on/off for a plain switchable light', () => {
  const payload = lightToDevicePayload(makeIds(), { name: 'Prise', type: 'On/Off light', uniqueid: 'x' });
  assert.equal(payload.features.length, 1);
});

test('hueStateToFeatureStates reports every supported feature', () => {
  const ids = makeIds();
  const states = hueStateToFeatureStates(ids, extendedColorLight);
  const byId = Object.fromEntries(states.map((s) => [s.external_id, s.value]));
  assert.equal(byId[ids.feature(FEATURE.ON_OFF)], 1);
  assert.equal(byId[ids.feature(FEATURE.BRIGHTNESS)], 100);
  assert.equal(byId[ids.feature(FEATURE.TEMPERATURE)], 300);
  assert.equal(typeof byId[ids.feature(FEATURE.COLOR)], 'number');
});

test('featureValueToHueState builds correct Hue payloads', () => {
  assert.deepEqual(featureValueToHueState(FEATURE.ON_OFF, 1, extendedColorLight), { on: true });
  assert.deepEqual(featureValueToHueState(FEATURE.ON_OFF, 0, extendedColorLight), { on: false });
  assert.deepEqual(featureValueToHueState(FEATURE.BRIGHTNESS, 0, extendedColorLight), { on: false });
  assert.deepEqual(featureValueToHueState(FEATURE.BRIGHTNESS, 100, extendedColorLight), { on: true, bri: 254 });

  const temp = featureValueToHueState(FEATURE.TEMPERATURE, 9999, extendedColorLight);
  assert.equal(temp.ct, 500, 'ct is clamped to the light max');

  const color = featureValueToHueState(FEATURE.COLOR, 0xff0000, extendedColorLight);
  assert.equal(color.on, true);
  assert.ok(Array.isArray(color.xy) && color.xy.length === 2);
});

test('featureValueToHueState throws on unknown kind', () => {
  assert.throws(() => featureValueToHueState('nope', 1, extendedColorLight), /Unknown feature kind/);
});

test('on/off accepts the value however Gladys types it', () => {
  for (const on of [1, '1', true]) {
    assert.deepEqual(featureValueToHueState(FEATURE.ON_OFF, on, extendedColorLight), { on: true }, `value ${on}`);
  }
  for (const off of [0, '0', false]) {
    assert.deepEqual(featureValueToHueState(FEATURE.ON_OFF, off, extendedColorLight), { on: false }, `value ${off}`);
  }
});

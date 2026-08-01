// -----------------------------------------------------------------------------
// Mapping between a Philips Hue light and Gladys device features.
//
// Everything here is PURE (no I/O): it converts a Hue light object into a Gladys
// discovery payload, translates Hue state -> Gladys feature values (for polling)
// and Gladys feature values -> Hue state payloads (for commands).
//
// Conversions implemented:
//   - on/off      : Hue `on` boolean            <-> 0 / 1
//   - brightness  : Hue `bri` 1..254            <-> 0..100 %
//   - color       : Hue `xy` + `bri`            <-> single RGB integer
//   - temperature : Hue `ct` mireds (153..500)  <-> passthrough (mireds)
//
// The RGB <-> xy conversion uses the standard Philips "Wide RGB D65" gamma
// algorithm documented by the Hue developer community.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';

// Feature keys (suffix of the feature external_id). Kept short and stable.
export const FEATURE = {
  ON_OFF: 'on-off',
  BRIGHTNESS: 'brightness',
  COLOR: 'color',
  TEMPERATURE: 'temperature',
};

// Hue brightness range on the v1 API.
const HUE_BRI_MIN = 1;
const HUE_BRI_MAX = 254;

// Default color-temperature range (mireds) when the light does not advertise it.
const DEFAULT_CT_MIN = 153; // ~6500 K (cold)
const DEFAULT_CT_MAX = 500; // ~2000 K (warm)

/**
 * Clamp a number into [min, max].
 * @param {number} value - Value to clamp.
 * @param {number} min - Lower bound.
 * @param {number} max - Upper bound.
 * @returns {number} Clamped value.
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Determine which features a Hue light supports from its `type` string.
 * @param {object} light - Hue light object.
 * @returns {{ brightness: boolean, color: boolean, temperature: boolean }} Capabilities.
 */
export function getCapabilities(light) {
  const type = String(light.type || '').toLowerCase();
  return {
    brightness: type.includes('dimmable') || type.includes('color'),
    color: type.includes('color light') || type.includes('extended color'),
    temperature: type.includes('color temperature') || type.includes('extended color'),
  };
}

/**
 * Convert a Hue brightness (1..254) to a Gladys percentage (1..100).
 *
 * The result never reaches 0: `featureValueToHueState` reads 0 % as "turn the
 * light off", so reporting a dimly lit light as 0 % would make Gladys show it as
 * off and turn it off on the next round-trip.
 * @param {number} bri - Hue brightness.
 * @returns {number} Percentage.
 */
export function briToPercent(bri) {
  return Math.max(1, Math.round((clamp(bri, HUE_BRI_MIN, HUE_BRI_MAX) / HUE_BRI_MAX) * 100));
}

/**
 * Convert a Gladys percentage (0..100) to a Hue brightness (1..254).
 * @param {number} percent - Percentage.
 * @returns {number} Hue brightness.
 */
export function percentToBri(percent) {
  return clamp(Math.round((clamp(percent, 0, 100) / 100) * HUE_BRI_MAX), HUE_BRI_MIN, HUE_BRI_MAX);
}

/**
 * Pack an {r,g,b} triplet (0..255) into a single integer, as Gladys stores it.
 * @param {number} r - Red.
 * @param {number} g - Green.
 * @param {number} b - Blue.
 * @returns {number} RGB integer.
 */
export function rgbToInt({ r, g, b }) {
  return (clamp(Math.round(r), 0, 255) << 16) + (clamp(Math.round(g), 0, 255) << 8) + clamp(Math.round(b), 0, 255);
}

/**
 * Unpack a Gladys RGB integer into an {r,g,b} triplet (0..255).
 * @param {number} value - RGB integer.
 * @returns {{ r: number, g: number, b: number }} Triplet.
 */
export function intToRgb(value) {
  const int = Math.max(0, Math.round(value));
  return { r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff };
}

/**
 * Apply the reverse sRGB gamma to a 0..1 channel.
 * @param {number} channel - Linear channel value.
 * @returns {number} Gamma-corrected channel.
 */
function gamma(channel) {
  return channel > 0.04045 ? ((channel + 0.055) / 1.055) ** 2.4 : channel / 12.92;
}

/**
 * Apply the sRGB gamma to a 0..1 channel.
 * @param {number} channel - Gamma-corrected channel value.
 * @returns {number} Linear channel.
 */
function reverseGamma(channel) {
  return channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
}

/**
 * Convert an RGB integer to a Hue xy color coordinate.
 * @param {number} rgbInt - RGB integer.
 * @returns {[number, number]} The xy coordinate.
 */
export function rgbToXy(rgbInt) {
  const { r, g, b } = intToRgb(rgbInt);
  const red = gamma(r / 255);
  const green = gamma(g / 255);
  const blue = gamma(b / 255);

  const X = red * 0.4124 + green * 0.3576 + blue * 0.1805;
  const Y = red * 0.2126 + green * 0.7152 + blue * 0.0722;
  const Z = red * 0.0193 + green * 0.1192 + blue * 0.9505;

  const sum = X + Y + Z;
  if (sum === 0) {
    return [0, 0];
  }
  return [Number((X / sum).toFixed(4)), Number((Y / sum).toFixed(4))];
}

/**
 * Convert a Hue xy color coordinate (+ brightness) to an RGB integer.
 * @param {[number, number]} xy - The xy coordinate.
 * @param {number} [bri] - Hue brightness (1..254), used as the Y luminance.
 * @returns {number} RGB integer.
 */
export function xyToRgb([x, y], bri = HUE_BRI_MAX) {
  if (!y) {
    return 0;
  }
  const Y = clamp(bri, HUE_BRI_MIN, HUE_BRI_MAX) / HUE_BRI_MAX;
  const X = (Y / y) * x;
  const Z = (Y / y) * (1 - x - y);

  let red = X * 3.2406 - Y * 1.5372 - Z * 0.4986;
  let green = -X * 0.9689 + Y * 1.8758 + Z * 0.0415;
  let blue = X * 0.0557 - Y * 0.204 + Z * 1.057;

  red = reverseGamma(red);
  green = reverseGamma(green);
  blue = reverseGamma(blue);

  // Normalize so the brightest channel is at most 1 (keeps the hue, avoids clip).
  const max = Math.max(red, green, blue);
  if (max > 1) {
    red /= max;
    green /= max;
    blue /= max;
  }
  return rgbToInt({
    r: clamp(red, 0, 1) * 255,
    g: clamp(green, 0, 1) * 255,
    b: clamp(blue, 0, 1) * 255,
  });
}

/**
 * Read the color-temperature bounds (mireds) advertised by the light.
 * @param {object} light - Hue light object.
 * @returns {{ min: number, max: number }} Mireds bounds.
 */
function ctRange(light) {
  const ct = light.capabilities && light.capabilities.control && light.capabilities.control.ct;
  return {
    min: ct && Number.isFinite(ct.min) ? ct.min : DEFAULT_CT_MIN,
    max: ct && Number.isFinite(ct.max) ? ct.max : DEFAULT_CT_MAX,
  };
}

/**
 * Build the Gladys discovery payload (device + features) for a Hue light.
 * @param {{ feature: (key: string) => string, device: string }} ids - external ids helper for this device.
 * @param {object} light - Hue light object.
 * @returns {object} Gladys device discovery payload.
 */
export function lightToDevicePayload(ids, light) {
  const caps = getCapabilities(light);
  const features = [
    {
      name: 'On/Off',
      external_id: ids.feature(FEATURE.ON_OFF),
      category: DEVICE_FEATURE_CATEGORIES.LIGHT,
      type: DEVICE_FEATURE_TYPES.LIGHT.BINARY,
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: true,
      keep_history: true,
    },
  ];

  if (caps.brightness) {
    features.push({
      name: 'Brightness',
      external_id: ids.feature(FEATURE.BRIGHTNESS),
      category: DEVICE_FEATURE_CATEGORIES.LIGHT,
      type: DEVICE_FEATURE_TYPES.LIGHT.BRIGHTNESS,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      min: 0,
      max: 100,
      read_only: false,
      has_feedback: true,
      keep_history: true,
    });
  }

  if (caps.color) {
    features.push({
      name: 'Color',
      external_id: ids.feature(FEATURE.COLOR),
      category: DEVICE_FEATURE_CATEGORIES.LIGHT,
      type: DEVICE_FEATURE_TYPES.LIGHT.COLOR,
      min: 0,
      max: 16777215, // 0xFFFFFF
      read_only: false,
      has_feedback: true,
      keep_history: false,
    });
  }

  if (caps.temperature) {
    const range = ctRange(light);
    features.push({
      name: 'White temperature',
      external_id: ids.feature(FEATURE.TEMPERATURE),
      category: DEVICE_FEATURE_CATEGORIES.LIGHT,
      type: DEVICE_FEATURE_TYPES.LIGHT.TEMPERATURE,
      min: range.min,
      max: range.max,
      read_only: false,
      has_feedback: true,
      keep_history: false,
    });
  }

  return {
    name: light.name,
    external_id: ids.device,
    features,
  };
}

/**
 * Translate the current Hue light state into Gladys feature states.
 * @param {{ feature: (key: string) => string }} ids - external ids helper for this device.
 * @param {object} light - Hue light object.
 * @returns {Array<{ external_id: string, value: number }>} Feature states.
 */
export function hueStateToFeatureStates(ids, light) {
  const caps = getCapabilities(light);
  const state = light.state || {};
  const states = [{ external_id: ids.feature(FEATURE.ON_OFF), value: state.on ? 1 : 0 }];

  if (caps.brightness && typeof state.bri === 'number') {
    states.push({ external_id: ids.feature(FEATURE.BRIGHTNESS), value: briToPercent(state.bri) });
  }
  if (caps.color && Array.isArray(state.xy)) {
    states.push({ external_id: ids.feature(FEATURE.COLOR), value: xyToRgb(state.xy, state.bri) });
  }
  if (caps.temperature && typeof state.ct === 'number') {
    states.push({ external_id: ids.feature(FEATURE.TEMPERATURE), value: state.ct });
  }
  return states;
}

/**
 * Translate a Gladys command (feature kind + value) into a Hue state payload.
 * @param {string} kind - One of the FEATURE.* keys.
 * @param {number} value - Value coming from Gladys.
 * @param {object} light - Hue light object (for its ct bounds).
 * @returns {object} Hue state payload for `setLightState`.
 */
export function featureValueToHueState(kind, value, light) {
  switch (kind) {
    case FEATURE.ON_OFF:
      // Coerced: Gladys may hand over 1, "1" or true depending on the caller.
      return { on: Number(value) === 1 };
    case FEATURE.BRIGHTNESS: {
      // 0 % means "off" for the user; anything above turns the light on.
      if (value <= 0) {
        return { on: false };
      }
      return { on: true, bri: percentToBri(value) };
    }
    case FEATURE.COLOR:
      return { on: true, xy: rgbToXy(value) };
    case FEATURE.TEMPERATURE: {
      const range = ctRange(light);
      return { on: true, ct: clamp(Math.round(value), range.min, range.max) };
    }
    default:
      throw new Error(`Unknown feature kind: ${kind}`);
  }
}

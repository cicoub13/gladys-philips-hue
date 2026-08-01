// -----------------------------------------------------------------------------
// Integration configuration.
//
// The user fills it in Gladys from the `config_schema` of
// `gladys-assistant-integration.json`. The SDK fetches it (`gladys.getConfig()`)
// and notifies every change through `gladys.onConfigUpdated()`.
//
// This module only provides defaults and normalizes the received object so the
// rest of the code never has to deal with `undefined` or string-typed values
// (a `select` field always sends its value back as a string).
// -----------------------------------------------------------------------------

// Poll frequencies Gladys accepts, in MILLISECONDS: `t_device.poll_frequency` is
// an ENUM column (DEVICE_POLL_FREQUENCIES_LIST), so any other value is rejected
// by the database and the device is never polled.
//
// Gladys also allows 1 s and 2 s, deliberately NOT exposed here: a Hue bridge
// rate-limits around 10 requests/s and Gladys caps an integration at 300 states
// per minute, both of which a 1 s poll over a handful of lights blows through.
export const POLL_FREQUENCIES = [10000, 15000, 30000, 60000];

// Defaults MUST stay consistent with the `default` values of the manifest.
export const DEFAULT_CONFIG = {
  bridge_ip: '', // optional manual override when discovery fails
  bridge_ip_rejected: '', // set when the user typed an unusable address
  poll_frequency: 60000, // one refresh per minute
};

// A bridge IP is typed by hand: accept an IPv4 address or a plain hostname, so
// it can only ever be interpolated as a host in `http://<ip>/api/...`.
const IPV4_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$/;
const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

/**
 * Check that a user-typed bridge address is a bare IPv4 address or hostname.
 * @param {string} value - Trimmed user input.
 * @returns {boolean} True when the value is safe to use as a host.
 */
export function isValidBridgeHost(value) {
  if (!value) {
    return false;
  }
  if (IPV4_PATTERN.test(value)) {
    return value.split('.').every((octet) => Number(octet) <= 255);
  }
  return value.length <= 253 && HOSTNAME_PATTERN.test(value);
}

/**
 * Merge the user config with the defaults and coerce types (the form sends
 * `select` values as strings).
 * @param {Record<string, unknown>} raw - config returned by the SDK.
 * @returns {{ bridge_ip: string, bridge_ip_rejected: string, poll_frequency: number }} Normalized config.
 */
export function normalizeConfig(raw = {}) {
  const pollFrequency = Number(raw.poll_frequency);
  const bridgeIp = String(raw.bridge_ip ?? DEFAULT_CONFIG.bridge_ip).trim();
  const bridgeIpValid = isValidBridgeHost(bridgeIp);
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    // An unusable address is dropped rather than propagated: `candidateBridges`
    // would otherwise build requests against an arbitrary host. The rejected
    // input is kept aside so the actions can tell the user WHY it was ignored.
    bridge_ip: bridgeIpValid ? bridgeIp : DEFAULT_CONFIG.bridge_ip,
    bridge_ip_rejected: bridgeIpValid ? '' : bridgeIp,
    // Only the values Gladys accepts; anything else falls back to the default.
    poll_frequency: POLL_FREQUENCIES.includes(pollFrequency) ? pollFrequency : DEFAULT_CONFIG.poll_frequency,
  };
}

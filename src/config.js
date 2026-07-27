// -----------------------------------------------------------------------------
// Integration configuration.
//
// The user fills it in Gladys from the `config_schema` of
// `gladys-assistant-integration.json`. The SDK fetches it (`gladys.getConfig()`)
// and notifies every change through `gladys.onConfigUpdated()`.
//
// This module only provides defaults and normalizes the received object so the
// rest of the code never has to deal with `undefined` or string-typed numbers.
// -----------------------------------------------------------------------------

// Defaults MUST stay consistent with the `default` values of the manifest.
export const DEFAULT_CONFIG = {
  bridge_ip: '', // optional manual override when discovery fails
  poll_frequency: 60, // seconds between state refreshes
};

/**
 * Merge the user config with the defaults and coerce types (a form may send
 * numbers as strings).
 * @param {Record<string, unknown>} raw - config returned by the SDK.
 * @returns {{ bridge_ip: string, poll_frequency: number }} Normalized config.
 */
export function normalizeConfig(raw = {}) {
  const pollFrequency = Number(raw.poll_frequency ?? DEFAULT_CONFIG.poll_frequency);
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    bridge_ip: String(raw.bridge_ip ?? DEFAULT_CONFIG.bridge_ip).trim(),
    // Guard against NaN / out-of-range values coming from the form.
    poll_frequency: Number.isFinite(pollFrequency) ? Math.max(5, pollFrequency) : DEFAULT_CONFIG.poll_frequency,
  };
}

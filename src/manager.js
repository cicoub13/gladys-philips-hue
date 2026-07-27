// -----------------------------------------------------------------------------
// HueManager: orchestrates bridges, devices and commands.
//
// It ties together:
//   - the persistent bridge store (paired bridges + usernames),
//   - one HueBridgeClient per bridge,
//   - an in-memory registry mapping each Gladys device external_id to its
//     bridge + Hue light id (so onSetValue / onPoll can be dispatched),
//   - the pure mapping helpers (Hue <-> Gladys features).
//
// The index.js wiring only calls high-level methods here; no protocol detail
// leaks into the SDK glue.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { HueBridgeClient, HUE_LINK_BUTTON_NOT_PRESSED } from './hue/bridge.js';
import { discoverBridges } from './hue/discovery.js';
import { BridgeStore } from './hue/store.js';
import { FEATURE, featureValueToHueState, hueStateToFeatureStates, lightToDevicePayload } from './hue/mapping.js';

const logger = createLogger({ name: 'hue-manager' });

// Device "type" used to build external ids (`ext:<selector>:light:<platformId>`).
const DEVICE_TYPE = 'light';

// The name the integration registers under on the bridge.
const APP_NAME = 'gladys#philips-hue';

// Every FEATURE kind we may have to dispatch a command to.
const FEATURE_KINDS = [FEATURE.ON_OFF, FEATURE.BRIGHTNESS, FEATURE.COLOR, FEATURE.TEMPERATURE];

export class HueManager {
  /**
   * @param {object} gladys - The GladysIntegration SDK instance.
   * @param {{ bridge_ip: string, poll_frequency: number }} config - Normalized config.
   * @param {BridgeStore} [store] - Injectable bridge store (mainly for tests).
   */
  constructor(gladys, config, store = new BridgeStore()) {
    this.gladys = gladys;
    this.config = config;
    this.store = store;
    /** @type {Map<string, { platformId: string, hueId: string, bridgeIp: string, light: object }>} */
    this.registry = new Map();
  }

  /**
   * Load the persisted bridges. Call once at startup.
   * @returns {Promise<void>} Resolves once loaded.
   */
  async init() {
    await this.store.load();
    logger.info(`Loaded ${this.store.list().length} paired bridge(s)`);
  }

  /**
   * Update the current configuration (hot reload).
   * @param {{ bridge_ip: string, poll_frequency: number }} config - Normalized config.
   */
  setConfig(config) {
    this.config = config;
  }

  /**
   * Build a client for a stored bridge.
   * @param {{ ip: string, username: string }} bridge - Bridge credentials.
   * @returns {HueBridgeClient} Client.
   */
  clientFor(bridge) {
    return new HueBridgeClient(bridge.ip, bridge.username);
  }

  /**
   * Build the Gladys discovery payload for every light of every paired bridge,
   * and (re)populate the dispatch registry.
   * @returns {Promise<Array<object>>} Discovered devices.
   */
  async buildDiscoveredDevices() {
    this.registry.clear();
    const devices = [];

    for (const bridge of this.store.list()) {
      const client = this.clientFor(bridge);
      let lights;
      try {
        lights = await client.getLights();
      } catch (error) {
        logger.warn(`Could not read lights from bridge ${bridge.ip}: ${error.message}`);
        continue;
      }

      for (const [hueId, light] of Object.entries(lights)) {
        // uniqueid is the light's MAC-based id: unique and stable across reboots.
        const platformId = `${bridge.id || bridge.ip}-${light.uniqueid || hueId}`;
        const ids = this.gladys.externalIds(DEVICE_TYPE, platformId);
        const payload = lightToDevicePayload(ids, light);
        payload.poll_frequency = this.config.poll_frequency;
        devices.push(payload);
        this.registry.set(ids.device, { platformId, hueId, bridgeIp: bridge.ip, light });
      }
    }

    logger.info(`Discovered ${devices.length} light(s) across ${this.store.list().length} bridge(s)`);
    return devices;
  }

  /**
   * Resolve a Gladys device to its bridge client and registry entry.
   * @param {object} device - Gladys device (has `external_id`).
   * @returns {{ entry: object, bridge: object, client: HueBridgeClient }} Resolved handles.
   * @throws {Error} When the device is unknown or its bridge is gone.
   */
  resolve(device) {
    const entry = this.registry.get(device.external_id);
    if (!entry) {
      throw new Error(`Unknown device ${device.external_id} (run a scan first)`);
    }
    const bridge = this.store.list().find((b) => b.ip === entry.bridgeIp);
    if (!bridge) {
      throw new Error(`Bridge ${entry.bridgeIp} is no longer paired`);
    }
    return { entry, bridge, client: this.clientFor(bridge) };
  }

  /**
   * Execute a user command on a light feature.
   * @param {object} device - Gladys device.
   * @param {object} feature - Gladys device feature.
   * @param {number} value - Value to apply.
   * @returns {Promise<void>} Resolves once the state is published.
   */
  async setValue(device, feature, value) {
    const { entry, client } = this.resolve(device);
    const ids = this.gladys.externalIds(DEVICE_TYPE, entry.platformId);
    const kind = FEATURE_KINDS.find((k) => ids.feature(k) === feature.external_id);
    if (!kind) {
      throw new Error(`Unknown feature ${feature.external_id} on device ${device.external_id}`);
    }

    const hueState = featureValueToHueState(kind, value, entry.light);
    logger.info(`setValue ${feature.external_id} = ${value} -> ${JSON.stringify(hueState)}`);
    await client.setLightState(entry.hueId, hueState);
    // Echo the commanded value back so Gladys reflects it immediately.
    await this.gladys.publishState(feature.external_id, value);
  }

  /**
   * Poll a light and publish its current feature states.
   * @param {object} device - Gladys device.
   * @returns {Promise<void>} Resolves once states are published.
   */
  async poll(device) {
    const { entry, client } = this.resolve(device);
    const light = await client.getLight(entry.hueId);
    entry.light = light; // refresh cached capabilities/state
    const ids = this.gladys.externalIds(DEVICE_TYPE, entry.platformId);
    const states = hueStateToFeatureStates(ids, light).map((s) => ({
      device_feature_external_id: s.external_id,
      state: s.value,
    }));
    if (states.length > 0) {
      await this.gladys.publishStates(states);
    }
  }

  /**
   * Compute the candidate bridge IPs to pair with: discovered ones plus the
   * optional manual override from the config.
   * @returns {Promise<Array<{ id: string, ip: string }>>} Candidate bridges.
   */
  async candidateBridges() {
    const discovered = await discoverBridges();
    const byIp = new Map(discovered.map((b) => [b.ip, b]));
    if (this.config.bridge_ip) {
      byIp.set(this.config.bridge_ip, { id: '', ip: this.config.bridge_ip });
    }
    return [...byIp.values()];
  }

  /**
   * Try to pair every candidate bridge (the physical link button must have been
   * pressed). Successfully paired bridges are persisted.
   * @returns {Promise<{ paired: string[], pending: string[], failed: string[] }>} Result per IP.
   */
  async pairBridges() {
    const candidates = await this.candidateBridges();
    const result = { paired: [], pending: [], failed: [] };

    for (const bridge of candidates) {
      const client = new HueBridgeClient(bridge.ip);
      try {
        const username = await client.createUser(APP_NAME);
        await this.store.upsert({ id: bridge.id, ip: bridge.ip, username });
        result.paired.push(bridge.ip);
      } catch (error) {
        if (error.hueErrorType === HUE_LINK_BUTTON_NOT_PRESSED) {
          result.pending.push(bridge.ip);
        } else {
          logger.warn(`Pairing with ${bridge.ip} failed: ${error.message}`);
          result.failed.push(bridge.ip);
        }
      }
    }
    return result;
  }
}

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
import { identifyBridges } from './hue/identify.js';
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
    /**
     * @type {Map<string, {
     *   platformId: string, hueId: string, bridgeIp: string,
     *   light: object, lastValues: Map<string, number>
     * }>}
     */
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
    // Carry over what pairing learned: the scheme the bridge answers on and the
    // certificate we pinned, so HTTPS bridges keep working across restarts.
    return new HueBridgeClient(bridge.ip, bridge.username, {
      scheme: bridge.scheme,
      id: bridge.id,
      certFingerprint: bridge.certFingerprint,
    });
  }

  /**
   * Build the Gladys discovery payload for every light of every paired bridge,
   * and (re)populate the dispatch registry.
   *
   * A bridge we failed to read keeps its previous registry entries: losing them
   * would break every command and poll of its lights with a misleading "unknown
   * device" until the next successful scan.
   * @returns {Promise<{ devices: Array<object>, reachable: number, unreachable: number }>} Scan result.
   */
  async buildDiscoveredDevices() {
    const bridges = this.store.list();
    const nextRegistry = new Map();
    const devices = [];
    let unreachable = 0;

    for (const bridge of bridges) {
      const client = this.clientFor(bridge);
      let lights;
      try {
        lights = await client.getLights();
      } catch (error) {
        unreachable += 1;
        logger.warn(`Could not read lights from bridge ${bridge.ip}: ${error.message}`);
        // Carry over what we already knew about this bridge's lights.
        for (const [deviceId, entry] of this.registry) {
          if (entry.bridgeIp === bridge.ip) {
            nextRegistry.set(deviceId, entry);
          }
        }
        continue;
      }

      for (const [hueId, light] of Object.entries(lights)) {
        // uniqueid is the light's MAC-based id: unique and stable across reboots.
        const platformId = `${bridge.id || bridge.ip}-${light.uniqueid || hueId}`;
        const ids = this.gladys.externalIds(DEVICE_TYPE, platformId);
        const payload = lightToDevicePayload(ids, light);
        payload.poll_frequency = this.config.poll_frequency;
        devices.push(payload);
        nextRegistry.set(ids.device, {
          platformId,
          hueId,
          bridgeIp: bridge.ip,
          light,
          // Last value published per feature, to avoid re-publishing unchanged
          // states on every poll (Gladys caps at 300 states/minute).
          lastValues: new Map(),
        });
      }
    }

    this.registry = nextRegistry;
    const reachable = bridges.length - unreachable;
    logger.info(`Discovered ${devices.length} light(s) across ${reachable}/${bridges.length} reachable bridge(s)`);
    return { devices, reachable, unreachable };
  }

  /**
   * Refresh the device list in Gladys and report the integration status.
   *
   * Single entry point used at startup, on reconnection, after a config change
   * and right after a successful pairing.
   * @returns {Promise<Array<object>>} The devices published (empty if none).
   */
  async syncDevices() {
    if (this.store.list().length === 0) {
      await this.gladys.setConnectionStatus(false, {
        en: 'No Hue bridge paired yet. Use the "Discover bridges" and "Pair bridge" buttons above.',
        fr: 'Aucun bridge Hue appairé. Utilisez les boutons « Découvrir les bridges » et « Appairer le bridge » ci-dessus.',
      });
      return [];
    }

    const { devices, reachable, unreachable } = await this.buildDiscoveredDevices();

    if (reachable === 0) {
      // Publishing an empty list here would wipe the Discovery tab because of a
      // transient network glitch. Keep the previous list and say what is wrong.
      logger.warn('No bridge reachable, keeping the previously published devices');
      await this.gladys.setConnectionStatus(false, {
        en: 'Hue bridge unreachable. Check that it is powered on and on the same network as Gladys.',
        fr: "Bridge Hue injoignable. Vérifiez qu'il est allumé et sur le même réseau que Gladys.",
      });
      return [];
    }

    await this.gladys.publishDiscoveredDevices(devices);

    if (unreachable > 0) {
      await this.gladys.setConnectionStatus(false, {
        en: `${unreachable} Hue bridge(s) unreachable, their lights are unavailable.`,
        fr: `${unreachable} bridge(s) Hue injoignable(s), leurs lampes sont indisponibles.`,
      });
    } else {
      await this.gladys.setConnectionStatus(true);
    }
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
      throw new Error(`Unknown light ${device.external_id}: run a scan from the Discovery tab`);
    }
    const bridge = this.store.list().find((b) => b.ip === entry.bridgeIp);
    if (!bridge) {
      throw new Error(`Bridge ${entry.bridgeIp} is no longer paired, pair it again from the Configuration screen`);
    }
    return { entry, bridge, client: this.clientFor(bridge) };
  }

  /**
   * Publish feature states, skipping the ones that did not change since the
   * last publication for this device.
   * @param {object} entry - Registry entry of the device.
   * @param {Array<{ external_id: string, value: number }>} states - Candidate states.
   * @returns {Promise<void>} Resolves once published.
   */
  async publishChangedStates(entry, states) {
    const changed = states.filter((state) => entry.lastValues.get(state.external_id) !== state.value);
    if (changed.length === 0) {
      return;
    }
    await this.gladys.publishStates(
      changed.map((state) => ({ device_feature_external_id: state.external_id, state: state.value })),
    );
    changed.forEach((state) => entry.lastValues.set(state.external_id, state.value));
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
      throw new Error(`Unknown feature ${feature.external_id} on light ${device.external_id}`);
    }

    const hueState = featureValueToHueState(kind, value, entry.light);
    logger.info(`setValue ${feature.external_id} = ${value} -> ${JSON.stringify(hueState)}`);
    // Throws (and fails the command in Gladys) when the bridge refuses it.
    await client.setLightState(entry.hueId, hueState);

    // Echo the commanded value back so Gladys reflects it immediately, along
    // with the on/off state it implies: setting a colour, a temperature or a
    // non-zero brightness also switches the light ON.
    const echoed = [{ external_id: feature.external_id, value }];
    if (kind !== FEATURE.ON_OFF && typeof hueState.on === 'boolean') {
      echoed.push({ external_id: ids.feature(FEATURE.ON_OFF), value: hueState.on ? 1 : 0 });
    }
    await this.publishChangedStates(entry, echoed);
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
    await this.publishChangedStates(entry, hueStateToFeatureStates(ids, light));
  }

  /**
   * Compute the candidate bridge IPs to pair with: discovered ones plus the
   * optional manual override from the config.
   * @returns {Promise<Array<{ id: string, ip: string }>>} Candidate bridges.
   */
  async candidateBridges() {
    const discovered = await discoverBridges(this.gladys);
    const byIp = new Map(discovered.map((b) => [b.ip, b]));
    if (this.config.bridge_ip) {
      byIp.set(this.config.bridge_ip, { id: '', ip: this.config.bridge_ip });
    }
    return [...byIp.values()];
  }

  /**
   * The candidates that are PROVEN to be Hue bridges.
   *
   * Discovery only reports "something answered"; the manual IP is whatever the
   * user typed. Both are checked against `/api/config` before anything else
   * touches them — this is what stops the integration from listing, and trying
   * to pair with, the printer next door.
   * @returns {Promise<{ bridges: Array<object>, ignored: string[] }>} Proven bridges and rejected addresses.
   */
  async identifiedBridges() {
    return identifyBridges(await this.candidateBridges());
  }

  /**
   * Try to pair every identified bridge (the physical link button must have
   * been pressed). Successfully paired bridges are persisted.
   *
   * The outcome is split per cause so the UI can tell the user what to actually
   * do next, instead of a single "it failed".
   * @returns {Promise<{ paired: object[], pending: object[], unreachable: object[], notABridge: string[] }>} Result per bridge.
   */
  async pairBridges() {
    const { bridges, ignored } = await this.identifiedBridges();
    const result = { paired: [], pending: [], unreachable: [], notABridge: ignored };

    for (const bridge of bridges) {
      // Reuse what identification already learned: the scheme that answered and
      // the certificate pinned on the way.
      const client = new HueBridgeClient(bridge.ip, undefined, {
        scheme: bridge.scheme,
        id: bridge.id,
        certFingerprint: bridge.certFingerprint,
      });
      try {
        const username = await client.createUser(APP_NAME);
        await this.store.upsert({
          id: bridge.id,
          ip: bridge.ip,
          username,
          scheme: bridge.scheme,
          ...(client.certFingerprint ? { certFingerprint: client.certFingerprint } : {}),
        });
        result.paired.push(bridge);
      } catch (error) {
        if (error.hueErrorType === HUE_LINK_BUTTON_NOT_PRESSED) {
          result.pending.push(bridge);
        } else {
          logger.warn(`Pairing with ${bridge.ip} failed: ${error.message}`);
          result.unreachable.push(bridge);
        }
      }
    }
    return result;
  }
}

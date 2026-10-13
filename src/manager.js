// -----------------------------------------------------------------------------
// HueManager: orchestrates bridges, devices and commands.
//
// It ties together:
//   - the persistent bridge store (paired bridges + usernames),
//   - one HueBridgeClient per bridge,
//   - an in-memory registry mapping each Gladys device external_id to its
//     bridge + Hue light id (so onSetValue can be dispatched),
//   - the pure mapping helpers (Hue <-> Gladys features),
//   - its own refresh loop, publishing the light states every `poll_frequency`.
//
// The index.js wiring only calls high-level methods here; no protocol detail
// leaks into the SDK glue.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { HueBridgeClient, HUE_LINK_BUTTON_NOT_PRESSED } from './hue/bridge.js';
import { discoverBridges } from './hue/discovery.js';
import { identifyBridges, parseBridgeConfig } from './hue/identify.js';
import { BridgeStore } from './hue/store.js';
import { FEATURE, featureValueToHueState, hueStateToFeatureStates, lightToDevicePayload } from './hue/mapping.js';
import { findScene, listSceneCandidates } from './hue/scenes.js';

const logger = createLogger({ name: 'hue-manager' });

// Device "type" used to build external ids (`ext:<selector>:light:<platformId>`).
const DEVICE_TYPE = 'light';

// The name the integration registers under on the bridge.
const APP_NAME = 'gladys#philips-hue';

// Every FEATURE kind we may have to dispatch a command to.
const FEATURE_KINDS = [FEATURE.ON_OFF, FEATURE.BRIGHTNESS, FEATURE.COLOR, FEATURE.TEMPERATURE];

// Background resync of unreachable bridges: capped exponential backoff.
const RESYNC_BASE_MS = 5000;
const RESYNC_MAX_MS = 5 * 60 * 1000;

// A light missing from the registry triggers a full resync, at most this often
// (a device deleted on the bridge side would otherwise resync on every command).
const REFRESH_MIN_INTERVAL_MS = 30000;

const NO_BRIDGE_MESSAGE = {
  en: 'No Hue bridge paired yet. Use the "Discover bridges" and "Pair bridge" buttons above.',
  fr: 'Aucun bridge Hue appairé. Utilisez les boutons « Découvrir les bridges » et « Appairer le bridge » ci-dessus.',
};

const ALL_UNREACHABLE_MESSAGE = {
  en: 'Hue bridge unreachable. Check that it is powered on and on the same network as Gladys.',
  fr: "Bridge Hue injoignable. Vérifiez qu'il est allumé et sur le même réseau que Gladys.",
};

/**
 * Delay before the next resync attempt: doubles from 5 s up to 5 min, with
 * jitter over the upper half of the step.
 * @param {number} attempt - Number of attempts already made.
 * @param {number} [random] - Value in [0, 1], injectable for tests.
 * @returns {number} Delay in milliseconds.
 */
export function nextResyncDelay(attempt, random = Math.random()) {
  const step = Math.min(RESYNC_BASE_MS * 2 ** attempt, RESYNC_MAX_MS);
  return Math.round(step / 2 + (random * step) / 2);
}

/**
 * Whether an error means the bridge did not answer at all. A Hue business error
 * or an HTTP status proves it is up.
 * @param {Error & { hueErrorType?: number, httpStatus?: number }} error - Bridge error.
 * @returns {boolean} True for a network-level failure.
 */
function isUnreachable(error) {
  return error.hueErrorType === undefined && error.httpStatus === undefined;
}

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
     *   light: object, commandSeq: number
     * }>}
     */
    this.registry = new Map();
    /** @type {Set<string>} IPs of the paired bridges that did not answer last time. */
    this.unreachable = new Set();
    /** Last status sent to Gladys, to only send changes. */
    this.statusKey = undefined;
    this.resyncTimer = undefined;
    this.resyncAttempts = 0;
    this.refreshing = undefined;
    this.lastRefreshAt = 0;
    this.stopped = false;
    // The light state refresh loop (startPolling / stopPolling).
    this.polling = false;
    this.pollTimer = undefined;
    this.pollRun = undefined;
    // Bumped on every command a bridge accepted: a refresh that read the lights
    // before it must not publish their old state (see refreshLights).
    this.commandSeq = 0;
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
    const frequencyChanged = config.poll_frequency !== this.config.poll_frequency;
    this.config = config;
    if (frequencyChanged && this.polling) {
      this.armPoll();
    }
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
   * would break every command and refresh of its lights with a misleading "unknown
   * device" until the next successful scan.
   * @returns {Promise<{ devices: Array<object>, reachable: number, unreachable: number }>} Scan result.
   */
  async buildDiscoveredDevices() {
    const bridges = this.store.list();
    const nextRegistry = new Map();
    const devices = [];
    let unreachable = 0;
    // Forget bridges that are no longer paired, or whose address changed.
    for (const ip of this.unreachable) {
      if (!bridges.some((bridge) => bridge.ip === ip)) {
        this.unreachable.delete(ip);
      }
    }

    for (const bridge of bridges) {
      const client = this.clientFor(bridge);
      let lights;
      try {
        lights = await client.getLights();
        this.unreachable.delete(bridge.ip);
      } catch (error) {
        unreachable += 1;
        this.unreachable.add(bridge.ip);
        logger.warn(`Could not read lights from bridge ${bridge.ip}: ${error.message}`);
        // Carry over what we already knew about this bridge's lights.
        for (const [deviceId, entry] of this.registry) {
          if (entry.bridgeIp === bridge.ip) {
            nextRegistry.set(deviceId, entry);
          }
        }
        continue;
      }
      if (!bridge.id) {
        await this.learnBridgeId(bridge, client);
      }

      for (const [hueId, light] of Object.entries(lights)) {
        // uniqueid is the light's MAC-based id: unique and stable across reboots.
        // `platformKey` keeps the IP-based ids of bridges paired without an id.
        const platformId = `${bridge.platformKey || bridge.id || bridge.ip}-${light.uniqueid || hueId}`;
        const ids = this.gladys.externalIds(DEVICE_TYPE, platformId);
        devices.push(lightToDevicePayload(ids, light));
        nextRegistry.set(ids.device, {
          platformId,
          hueId,
          bridgeIp: bridge.ip,
          light,
          // commandSeq of the last command the bridge accepted for this light.
          commandSeq: 0,
        });
      }
    }

    this.registry = nextRegistry;
    const reachable = bridges.length - unreachable;
    logger.info(`Discovered ${devices.length} light(s) across ${reachable}/${bridges.length} reachable bridge(s)`);
    return { devices, reachable, unreachable };
  }

  /**
   * Record the id of a bridge paired by 1.0.x/1.1.0 through the manual IP field,
   * which saved none. The store freezes its current IP as `platformKey`, so its
   * lights keep their external_ids, and a later pairing at a new address is
   * recognized as the same bridge instead of a new one. Best-effort: retried on
   * the next scan when the bridge does not answer.
   * @param {{ id: string, ip: string }} bridge - Stored bridge without an id.
   * @param {HueBridgeClient} client - Client for that bridge.
   * @returns {Promise<void>} Resolves once done (or given up).
   */
  async learnBridgeId(bridge, client) {
    try {
      const identity = parseBridgeConfig(bridge.ip, await client.getConfig());
      if (identity) {
        await this.store.upsert({ id: identity.id, ip: bridge.ip });
        logger.info(`Bridge ${bridge.ip} identified as ${identity.id}`);
      }
    } catch (error) {
      logger.debug(`Could not read the id of bridge ${bridge.ip}: ${error.message}`);
    }
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
      await this.reportStatus(true);
      return [];
    }

    const { devices, reachable } = await this.buildDiscoveredDevices();
    // Nobody else would retry: without this, a bridge down at startup stayed
    // "unreachable" until the user clicked something.
    this.scheduleResync();

    if (reachable === 0) {
      // Publishing an empty list here would wipe the Discovery tab because of a
      // transient network glitch. Keep the previous list and say what is wrong.
      logger.warn('No bridge reachable, keeping the previously published devices');
      await this.reportStatus(true);
      return [];
    }

    await this.gladys.publishDiscoveredDevices(devices);
    await this.reportStatus(true);
    return devices;
  }

  /**
   * Send the integration status derived from the paired bridges and the ones
   * that did not answer. Only changes are sent, unless `force` is set.
   * @param {boolean} [force] - Send even when unchanged (full resync).
   * @returns {Promise<void>} Resolves once sent (or skipped).
   */
  async reportStatus(force = false) {
    const paired = this.store.list().length;
    const down = this.unreachable.size;
    let status;
    if (paired === 0) {
      status = [false, NO_BRIDGE_MESSAGE];
    } else if (down === 0) {
      status = [true];
    } else if (down >= paired) {
      status = [false, ALL_UNREACHABLE_MESSAGE];
    } else {
      status = [
        false,
        {
          en: `${down} Hue bridge(s) unreachable, their lights are unavailable.`,
          fr: `${down} bridge(s) Hue injoignable(s), leurs lampes sont indisponibles.`,
        },
      ];
    }
    const key = JSON.stringify(status);
    if (!force && key === this.statusKey) {
      return;
    }
    await this.gladys.setConnectionStatus(...status);
    this.statusKey = key;
  }

  /**
   * Record whether a bridge answered a refresh or command, and update the status
   * and the resync loop accordingly. Never throws: the caller's own outcome is
   * what Gladys must see.
   * @param {string} ip - Bridge address.
   * @param {boolean} reachable - Whether it answered.
   * @returns {Promise<void>} Resolves once reported.
   */
  async markBridge(ip, reachable) {
    if (reachable) {
      this.unreachable.delete(ip);
    } else {
      this.unreachable.add(ip);
    }
    this.scheduleResync();
    try {
      await this.reportStatus();
    } catch (error) {
      logger.warn(`Could not report the connection status: ${error.message}`);
    }
  }

  /**
   * Run one call to a bridge, recording whether it answered.
   * @param {string} ip - Bridge address.
   * @param {() => Promise<any>} operation - The call.
   * @returns {Promise<any>} The call's result.
   */
  async callBridge(ip, operation) {
    try {
      const result = await operation();
      await this.markBridge(ip, true);
      return result;
    } catch (error) {
      await this.markBridge(ip, !isUnreachable(error));
      throw error;
    }
  }

  /**
   * Arm the single background resync while a bridge is unreachable, disarm it
   * once they all answer. Idempotent: never two timers at once.
   */
  scheduleResync() {
    if (this.unreachable.size === 0) {
      clearTimeout(this.resyncTimer);
      this.resyncTimer = undefined;
      this.resyncAttempts = 0;
      return;
    }
    if (this.resyncTimer || this.stopped) {
      return;
    }
    const delay = nextResyncDelay(this.resyncAttempts);
    this.resyncAttempts += 1;
    logger.info(`Retrying the unreachable Hue bridge(s) in ${Math.round(delay / 1000)} s`);
    this.resyncTimer = setTimeout(() => this.resync(), delay);
    // The Gladys WebSocket keeps the process alive; this timer must not.
    this.resyncTimer.unref();
  }

  /**
   * One background resync attempt (republishes devices and status).
   * @returns {Promise<void>} Resolves once done.
   */
  async resync() {
    clearTimeout(this.resyncTimer);
    this.resyncTimer = undefined;
    try {
      await this.syncDevices();
    } catch (error) {
      logger.warn(`Background resync failed: ${error.message}`);
      this.scheduleResync();
    }
  }

  /**
   * Stop the background work (shutdown).
   */
  stop() {
    this.stopped = true;
    clearTimeout(this.resyncTimer);
    this.resyncTimer = undefined;
    this.stopPolling();
  }

  /**
   * Refresh the light states every `poll_frequency`, on our own timer: Gladys
   * only polls a device created with `should_poll`, which the lights never had,
   * and never updates it on a device already created. Call once connected.
   */
  startPolling() {
    this.polling = true;
    this.armPoll();
  }

  /**
   * Stop the refresh loop (disconnection, shutdown). A refresh in progress ends
   * normally but does not arm the next one.
   */
  stopPolling() {
    this.polling = false;
    clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  /**
   * (Re)arm the next refresh, `poll_frequency` from now. While a refresh runs,
   * that run arms the next one when it ends: never two at once.
   */
  armPoll() {
    clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    if (!this.polling || this.stopped || this.pollRun) {
      return;
    }
    this.pollTimer = setTimeout(() => this.runPoll(), this.config.poll_frequency);
    // The Gladys WebSocket keeps the process alive; this timer must not.
    this.pollTimer.unref();
  }

  /**
   * One tick of the refresh loop, then arm the next one.
   * @returns {Promise<void>} Resolves once done; never rejects (it runs from a timer).
   */
  async runPoll() {
    this.pollTimer = undefined;
    this.pollRun = this.pollLights().catch((error) => logger.warn(`Light refresh failed: ${error.message}`));
    await this.pollRun;
    this.pollRun = undefined;
    this.armPoll();
  }

  /**
   * Publish the state of every light created in Gladys, from ONE read per
   * bridge (it rate-limits around 10 requests/s), all bridges at once so a hung
   * one does not delay the others. Lights not created are skipped: Gladys drops
   * their states but still counts them in its 300 states/minute limit.
   * @returns {Promise<void>} Resolves once done.
   */
  async pollLights() {
    const created = new Set(this.gladys.devices.map((device) => device.external_id));
    await Promise.all(
      this.store.list().map((bridge) => {
        const hueIds = [];
        for (const [deviceId, entry] of this.registry) {
          if (entry.bridgeIp === bridge.ip && created.has(deviceId)) {
            hueIds.push(entry.hueId);
          }
        }
        return this.refreshLights(bridge.ip, this.clientFor(bridge), hueIds);
      }),
    );
  }

  /**
   * A light missing from the registry (bridge down when it was last read, or
   * the process just started) triggers a resync before giving up on it, so it
   * works as soon as its bridge answers again. Concurrent calls share it.
   * @param {object} device - Gladys device (has `external_id`).
   * @returns {Promise<void>} Resolves once the registry is as fresh as it gets.
   */
  async ensureRegistered(device) {
    if (this.registry.has(device.external_id) || this.store.list().length === 0) {
      return;
    }
    if (!this.refreshing) {
      if (Date.now() - this.lastRefreshAt < REFRESH_MIN_INTERVAL_MS) {
        return;
      }
      this.lastRefreshAt = Date.now();
      this.refreshing = this.syncDevices()
        .catch((error) => logger.warn(`Resync for ${device.external_id} failed: ${error.message}`))
        .finally(() => {
          this.refreshing = undefined;
        });
    }
    await this.refreshing;
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
      if (this.unreachable.size > 0) {
        throw new Error(
          `Hue bridge unreachable: light ${device.external_id} will be available again as soon as the bridge answers`,
        );
      }
      throw new Error(`Unknown light ${device.external_id}: run a scan from the Discovery tab`);
    }
    const bridge = this.store.list().find((b) => b.ip === entry.bridgeIp);
    if (!bridge) {
      throw new Error(`Bridge ${entry.bridgeIp} is no longer paired, pair it again from the Configuration screen`);
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
    await this.ensureRegistered(device);
    const { entry, client } = this.resolve(device);
    const ids = this.gladys.externalIds(DEVICE_TYPE, entry.platformId);
    const kind = FEATURE_KINDS.find((k) => ids.feature(k) === feature.external_id);
    if (!kind) {
      throw new Error(`Unknown feature ${feature.external_id} on light ${device.external_id}`);
    }

    const hueState = featureValueToHueState(kind, value, entry.light);
    logger.info(`setValue ${feature.external_id} = ${value} -> ${JSON.stringify(hueState)}`);
    // Throws (and fails the command in Gladys) when the bridge refuses it.
    await this.callBridge(entry.bridgeIp, () => client.setLightState(entry.hueId, hueState));
    this.commandSeq += 1;
    entry.commandSeq = this.commandSeq;

    // Echo the commanded value back so Gladys reflects it immediately, along
    // with the on/off state it implies: setting a colour, a temperature or a
    // non-zero brightness also switches the light ON. Only what changed is sent
    // (Gladys caps an integration at 300 states/minute): the SDK remembers what
    // Gladys accepted, and forgets a light the user creates, updates or deletes.
    const echoed = [{ device_feature_external_id: feature.external_id, state: value }];
    if (kind !== FEATURE.ON_OFF && typeof hueState.on === 'boolean') {
      echoed.push({ device_feature_external_id: ids.feature(FEATURE.ON_OFF), state: hueState.on ? 1 : 0 });
    }
    await this.gladys.publishChangedStates(echoed);
  }

  /**
   * Recall a Hue scene by name (the `activate_scene` scene action), then
   * refresh the lights it set so Gladys shows them without waiting for the
   * next refresh.
   * @param {{ scene?: string, room?: string }} fields - Resolved fields of the scene action.
   * @returns {Promise<void>} Resolves once the bridge accepted the scene.
   * @throws {Error} When no scene, or more than one, matches, or the bridge refuses.
   */
  async activateScene({ scene, room } = {}) {
    const bridges = this.store.list();
    if (bridges.length === 0) {
      throw new Error('No Hue bridge paired yet: pair one from the Configuration screen');
    }

    // In parallel: a hung bridge must not eat the action's timeout before the
    // others are even asked.
    const results = await Promise.allSettled(
      bridges.map((bridge) => {
        const client = this.clientFor(bridge);
        return this.callBridge(bridge.ip, () => Promise.all([client.getGroups(), client.getScenes()]));
      }),
    );
    const candidates = [];
    const failures = [];
    results.forEach((result, index) => {
      const { ip } = bridges[index];
      if (result.status === 'fulfilled') {
        const [groups, scenes] = result.value;
        candidates.push(...listSceneCandidates(ip, groups, scenes));
        return;
      }
      const { reason } = result;
      logger.warn(`Could not read the scenes of bridge ${ip}: ${reason.message}`);
      failures.push(isUnreachable(reason) ? `Hue bridge ${ip} unreachable` : reason.message);
    });

    let match;
    try {
      match = findScene(candidates, scene, room);
    } catch (error) {
      // The scene may well be on the bridge that did not answer.
      if (failures.length > 0) {
        error.message += ` (${failures.join('; ')})`;
      }
      throw error;
    }

    const client = this.clientFor(bridges.find((b) => b.ip === match.bridgeIp));
    logger.info(`Recalling Hue scene "${match.sceneName}" (${match.roomName || 'all lights'}) on ${match.bridgeIp}`);
    await this.callBridge(match.bridgeIp, () => client.recallScene(match.groupId, match.sceneId));
    // Like a command: a refresh already reading these lights must not undo it.
    this.commandSeq += 1;
    for (const entry of this.registry.values()) {
      if (entry.bridgeIp === match.bridgeIp && match.lights.includes(entry.hueId)) {
        entry.commandSeq = this.commandSeq;
      }
    }
    // Not awaited: the scene is on, a slow refresh must not delay the ack past
    // the action's timeout and turn it into a failure.
    this.refreshLights(match.bridgeIp, client, match.lights);
  }

  /**
   * Publish the new state of the known lights among the given ones, from ONE
   * read of the bridge (not one per light, which would burst its rate limit).
   * Best-effort, never rejects: the scene it follows already succeeded, and the
   * refresh loop retries on its next tick.
   *
   * A light commanded while the read was in flight is skipped: the bridge may
   * have answered with its state from before the command, which would flip
   * Gladys back after the command's echo. The next refresh catches up.
   * @param {string} bridgeIp - Bridge the lights belong to.
   * @param {HueBridgeClient} client - Client of that bridge.
   * @param {string[]} hueIds - Hue ids of the lights.
   * @returns {Promise<void>} Resolves once the states are published.
   */
  async refreshLights(bridgeIp, client, hueIds) {
    const entries = [...this.registry.values()].filter(
      (entry) => entry.bridgeIp === bridgeIp && hueIds.includes(entry.hueId),
    );
    if (entries.length === 0) {
      return;
    }
    const readSeq = this.commandSeq;
    try {
      const lights = await this.callBridge(bridgeIp, () => client.getLights());
      for (const entry of entries) {
        const light = lights[entry.hueId];
        if (light && entry.commandSeq <= readSeq) {
          entry.light = light; // refresh cached capabilities/state
          const ids = this.gladys.externalIds(DEVICE_TYPE, entry.platformId);
          const states = hueStateToFeatureStates(ids, light);
          await this.gladys.publishChangedStates(
            states.map((state) => ({ device_feature_external_id: state.external_id, state: state.value })),
          );
        }
      }
    } catch (error) {
      logger.warn(`Could not refresh the lights of bridge ${bridgeIp}: ${error.message}`);
    }
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

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

import { createLogger, DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { HueBridgeClient, HUE_LINK_BUTTON_NOT_PRESSED } from './hue/bridge.js';
import { discoverBridges } from './hue/discovery.js';
import { identifyBridges, parseBridgeConfig } from './hue/identify.js';
import { normalizeFingerprint } from './hue/https.js';
import { BridgeStore } from './hue/store.js';
import { RequestQueue } from './hue/queue.js';
import { FEATURE, featureValueToHueState, hueStateToFeatureStates, lightToDevicePayload } from './hue/mapping.js';
import { findScene, listSceneCandidates } from './hue/scenes.js';
import { EventStream } from './hue/eventstream.js';
import { indexResources, lightPatches } from './hue/v2.js';

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

// Gladys takes at most this many transports per publishTransports call.
const MAX_TRANSPORTS_PER_REQUEST = 100;

// A bridge that does not answer may be rebooting (a firmware update takes 1 to
// 2 minutes): Forget only drops it once it has been silent for this long.
const SILENT_FORGET_MS = 5 * 60 * 1000;

// Hue error type of a username the bridge no longer knows (bridge reset).
const HUE_UNAUTHORIZED_USER = 1;

// A command to a light cut at the wall reads it again this long after, in one read
// shared with the other commands sent meanwhile (a scene switching on several).
const REFRESH_COALESCE_MS = 1000;

// The changes the event stream pushes are published at most once per this
// interval per bridge, merged: a dimmer button held down sends a change every
// few hundred ms per light, and Gladys takes 300 states per minute.
const EVENT_THROTTLE_MS = 1000;

// A bridge that fails is looked for at another address at most this often: the
// LAN scans take 6 s, and the core runs one at a time for the integration.
const MOVE_SEARCH_INTERVAL_MS = 60 * 1000;

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
  // A bridge that blocks HTTP and fails the switch to HTTPS (refused certificate,
  // another bridge) answers its 403 itself: it cannot be used all the same, and
  // must get the same grace as silence before Forget drops it.
  return error.httpsSwitchFailed === true || (error.hueErrorType === undefined && error.httpStatus === undefined);
}

/**
 * Whether a failed read that got an answer proves the stored bridge is gone for
 * good: it no longer knows our username (reset, migrated), or something else
 * serves its address. A Hue bridge reports its own errors as HTTP 200, so any
 * HTTP error but 429/5xx (busy, rebooting) does not come from it.
 * @param {Error & { hueErrorType?: number, httpStatus?: number }} error - Bridge error.
 * @returns {boolean} True when the bridge may be forgotten.
 */
function isGone(error) {
  const status = error.httpStatus;
  if (error.httpsSwitchFailed) {
    return false; // its 403 says HTTP is blocked, not that it is gone (see isUnreachable)
  }
  return error.hueErrorType === HUE_UNAUTHORIZED_USER || (status !== undefined && status !== 429 && status < 500);
}

/**
 * The bridge part of its lights' platformIds. `platformKey` keeps the IP-based
 * ids of bridges paired without an id.
 * @param {{ id?: string, ip: string, platformKey?: string }} bridge - Stored bridge.
 * @returns {string} Key.
 */
function platformKeyOf(bridge) {
  return bridge.platformKey || bridge.id || bridge.ip;
}

/**
 * Whether a stored bridge's username may be sent to a bridge identification
 * just found: over HTTPS, its certificate must be the one pinned. The bridge id
 * it announces is public, and anything on the network can claim it.
 * @param {{ certFingerprint?: string }} stored - Stored bridge.
 * @param {{ scheme: string, certFingerprint?: string }} found - Identified bridge.
 * @returns {boolean} True when the username may be sent.
 */
function keepsPin(stored, found) {
  if (!stored.certFingerprint) {
    return true; // paired over HTTP: the username already went in clear
  }
  return (
    found.scheme === 'https' &&
    normalizeFingerprint(found.certFingerprint) === normalizeFingerprint(stored.certFingerprint)
  );
}

/**
 * What to store for an identified bridge and a username.
 * @param {{ id: string, ip: string, scheme: string, certFingerprint?: string }} found - Identified bridge.
 * @param {string} username - Its username.
 * @returns {object} Store entry.
 */
function credentialsOf(found, username) {
  return {
    id: found.id,
    ip: found.ip,
    username,
    scheme: found.scheme,
    ...(found.certFingerprint ? { certFingerprint: found.certFingerprint } : {}),
  };
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
    /**
     * @type {Set<string>} The paired bridges whose last call failed, by `platformKeyOf`: not by
     * address, two stored bridges may share one (a dead bridge and its replacement).
     */
    this.unreachable = new Set();
    /**
     * @type {Map<string, number>} Since when each bridge (by `platformKeyOf`) has been getting
     * no answer at all, on the monotonic clock (`performance.now()`): an NTP step after boot must not
     * make a bridge look silent for hours. A 429/5xx answer marks a bridge unreachable, not silent.
     */
    this.silentSince = new Map();
    /** Last status sent to Gladys, to only send changes. */
    this.statusKey = undefined;
    this.resyncTimer = undefined;
    this.resyncAttempts = 0;
    this.refreshing = undefined;
    this.lastRefreshAt = -Infinity;
    this.lastMoveSearchAt = -Infinity;
    this.stopped = false;
    // The light state refresh loop (startPolling / stopPolling).
    this.polling = false;
    this.pollTimer = undefined;
    this.pollRun = undefined;
    // Bumped on every command a bridge accepted: a refresh that read the lights
    // before it must not publish their old state (see refreshLights).
    this.commandSeq = 0;
    /** @type {Map<string, string>} Last transport published per device external_id. */
    this.transports = new Map();
    // Transports are published one call at a time (see queueTransports).
    this.transportQueue = Promise.resolve();
    /** @type {Map<string, string>} Transports whose publication failed, sent again with the next ones. */
    this.pendingTransports = new Map();
    // Tail of the lock shared by Forget and pairing (see `exclusive`).
    this.bridgeLock = Promise.resolve();
    /** @type {WeakMap<object, RequestQueue>} The request queue of each stored bridge (see `queueOf`). */
    this.queues = new WeakMap();
    /** @type {Map<object, Set<string>>} Hue ids of the lights to read again soon, by bridge (see `refreshSoon`). */
    this.pendingRefreshes = new Map();
    /** @type {Map<object, { stream: EventStream, ip: string }>} The v2 event stream of each stored bridge. */
    this.streams = new Map();
    /**
     * @type {WeakMap<object, string>} Bridges found without the v2 API (old firmware), or with something else
     * than the bridge answering on HTTPS, with the address where it was found: polled only, until they move.
     */
    this.withoutPush = new WeakMap();
    /** @type {Map<object, Map<string, object>>} Pushed changes waiting to be published, by bridge. */
    this.pendingPatches = new Map();
    /** @type {Map<object, NodeJS.Timeout>} Throttle of the pushed changes, by bridge (see `queuePatches`). */
    this.patchTimers = new Map();
    // Pushed changes are published one batch at a time, in order.
    this.patchQueue = Promise.resolve();
  }

  /**
   * Run a task that changes the stored bridges once the previous one is done.
   * Forget and pairing share it: a bridge is never paired again while Forget is
   * deciding whether to drop it.
   * @param {() => Promise<any>} task - The task.
   * @returns {Promise<any>} The task's result.
   */
  exclusive(task) {
    const run = this.bridgeLock.then(task);
    this.bridgeLock = run.catch(() => {});
    return run;
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
   * The request queue of a stored bridge, shared by all its clients, so that
   * commands, refreshes and scenes sent at once do not overload it.
   * @param {object} bridge - Stored bridge.
   * @returns {RequestQueue} Its queue.
   */
  queueOf(bridge) {
    if (!this.queues.has(bridge)) {
      this.queues.set(bridge, new RequestQueue());
    }
    return this.queues.get(bridge);
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
      queue: this.queueOf(bridge),
      // A bridge paired over HTTP whose firmware now blocks it: remember that it
      // answers on HTTPS, and the certificate pinned on the way. Unless it was
      // forgotten while this call was in flight: it must not come back.
      onHttpsUpgrade: (transport) =>
        this.store.list().includes(bridge) ? this.store.upsert({ ...bridge, ...transport }) : undefined,
    });
  }

  /**
   * External ids of the lights of a bridge created in Gladys. Found by prefix,
   * not in the registry, which only knows the lights read since the start.
   * @param {{ id?: string, ip: string, platformKey?: string }} bridge - Stored bridge.
   * @returns {string[]} Device external_ids.
   */
  createdLightsOf(bridge) {
    const candidates = [...this.store.list(), bridge];
    return this.gladys.devices
      .map((device) => device.external_id)
      .filter((id) => this.ownerOf(id, candidates) === bridge);
  }

  /**
   * The bridge a light belongs to, from its external_id. The longest matching
   * prefix wins: legacy bridges are keyed by the address typed in, so `hue` and
   * `hue-2` can both be stored.
   * @param {string} externalId - Device external_id.
   * @param {Array<object>} [bridges] - Candidate bridges (the stored ones by default).
   * @returns {object | undefined} The bridge, if any.
   */
  ownerOf(externalId, bridges = this.store.list()) {
    let owner;
    let longest = -1;
    for (const bridge of bridges) {
      const prefix = this.gladys.externalIds(DEVICE_TYPE, `${platformKeyOf(bridge)}-`).device;
      if (externalId.startsWith(prefix) && prefix.length > longest) {
        owner = bridge;
        longest = prefix.length;
      }
    }
    return owner;
  }

  /**
   * Record whether a bridge's last read got an answer (see `silentSince`).
   * @param {object} bridge - Stored bridge.
   * @param {boolean} answered - Whether it answered, even with an error.
   */
  recordSilence(bridge, answered) {
    const key = platformKeyOf(bridge);
    if (answered) {
      this.silentSince.delete(key);
    } else if (!this.silentSince.has(key)) {
      this.silentSince.set(key, performance.now());
    }
  }

  /**
   * Give the `unreachable` badge to the created lights of a bridge that does not
   * answer, or was forgotten.
   * @param {{ id?: string, ip: string, platformKey?: string }} bridge - Stored bridge.
   * @returns {Promise<void>} Resolves once published; never rejects.
   */
  markLightsUnreachable(bridge) {
    return this.queueTransports(
      this.createdLightsOf(bridge).map((externalId) => ({
        external_id: externalId,
        transport: DEVICE_TRANSPORTS.UNREACHABLE,
      })),
    );
  }

  /**
   * Build the Gladys discovery payload for every light of every paired bridge,
   * and (re)populate the dispatch registry.
   *
   * A bridge we failed to read keeps its previous registry entries: losing them
   * would break every command and refresh of its lights with a misleading "unknown
   * device" until the next successful scan.
   * @param {Map<object, Promise<object>>} [reads] - Reads of `getLights()` already made, by stored bridge.
   * @returns {Promise<{ devices: Array<object>, reachable: number, unreachable: number, unknown: number }>} Scan
   * result. `unknown` counts the bridges that did not answer and whose lights are not known either (none read
   * since the start).
   */
  async buildDiscoveredDevices(reads = new Map()) {
    const bridges = this.store.list();
    const nextRegistry = new Map();
    const devices = [];
    let unreachable = 0;
    let unknown = 0;

    for (const bridge of bridges) {
      const client = this.clientFor(bridge);
      let lights;
      try {
        lights = await (reads.get(bridge) || client.getLights());
        this.unreachable.delete(platformKeyOf(bridge));
        this.recordSilence(bridge, true);
      } catch (error) {
        unreachable += 1;
        this.unreachable.add(platformKeyOf(bridge));
        logger.warn(`Could not read lights from bridge ${bridge.ip}: ${error.message}`);
        this.recordSilence(bridge, !isUnreachable(error));
        if (isUnreachable(error)) {
          await this.markLightsUnreachable(bridge);
        }
        // Carry over what we already knew about this bridge's lights, and keep
        // them in the Discovery tab.
        let known = 0;
        for (const [deviceId, entry] of this.registry) {
          if (this.ownerOf(deviceId) === bridge) {
            nextRegistry.set(deviceId, entry);
            devices.push(lightToDevicePayload(this.gladys.externalIds(DEVICE_TYPE, entry.platformId), entry.light));
            known += 1;
          }
        }
        if (known === 0) {
          unknown += 1;
        }
        continue;
      }
      if (!bridge.id) {
        await this.learnBridgeId(bridge, client);
      }

      for (const [hueId, light] of Object.entries(lights)) {
        // uniqueid is the light's MAC-based id: unique and stable across reboots.
        const platformId = `${platformKeyOf(bridge)}-${light.uniqueid || hueId}`;
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

    // Against the store as it is NOW: a bridge forgotten while this scan was
    // reading must not come back.
    const storedKeys = new Set(this.store.list().map(platformKeyOf));
    for (const key of this.unreachable) {
      if (!storedKeys.has(key)) {
        this.unreachable.delete(key);
      }
    }
    for (const key of this.silentSince.keys()) {
      if (!storedKeys.has(key)) {
        this.silentSince.delete(key);
      }
    }
    this.registry = new Map([...nextRegistry].filter(([deviceId]) => this.ownerOf(deviceId)));
    const kept = devices.filter((device) => this.registry.has(device.external_id));
    const reachable = bridges.length - unreachable;
    logger.info(`Discovered ${kept.length} light(s) across ${reachable}/${bridges.length} reachable bridge(s)`);
    return { devices: kept, reachable, unreachable, unknown };
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
      // Forgotten meanwhile: storing it again would bring it back without a username.
      if (identity && this.store.list().includes(bridge)) {
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
   * @param {{ force?: boolean }} [options] - `force` publishes the lights read even
   * when no bridge answered (after a Forget, the previous list holds the lights of
   * the forgotten bridges). `reads` reuses reads already made (see `buildDiscoveredDevices`).
   * @returns {Promise<Array<object>>} The devices published (empty if none).
   */
  async syncDevices({ force = false, reads } = {}) {
    // The stored bridges may have changed (paired, forgotten, moved).
    this.syncStreams();
    if (this.store.list().length === 0) {
      // Nothing left to be unreachable, nor to retry.
      this.unreachable.clear();
      this.silentSince.clear();
      this.scheduleResync();
      if (force) {
        await this.gladys.publishDiscoveredDevices([]);
      }
      await this.reportStatus(true);
      return [];
    }

    const { devices, reachable, unknown } = await this.buildDiscoveredDevices(reads);
    // Nobody else would retry: without this, a bridge down at startup stayed
    // "unreachable" until the user clicked something.
    this.scheduleResync();

    if (reachable === 0 && !force) {
      // Publishing an empty list here would wipe the Discovery tab because of a
      // transient network glitch. Keep the previous list and say what is wrong.
      logger.warn('No bridge reachable, keeping the previously published devices');
      await this.reportStatus(true);
      return [];
    }
    if (force && unknown > 0) {
      // After a Forget: a bridge still paired that has not answered since the
      // start would lose its lights from the Discovery tab. The forgotten lights
      // stay there instead, until the resync reaches that bridge.
      logger.warn('A paired bridge has not answered since the start, keeping the previously published devices');
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
   * @param {object} bridge - Stored bridge.
   * @param {boolean} reachable - Whether it works.
   * @param {boolean} [answered] - Whether it answered at all, even to refuse (see `silentSince`).
   * @returns {Promise<void>} Resolves once reported.
   */
  async markBridge(bridge, reachable, answered = reachable) {
    if (!this.store.list().includes(bridge)) {
      // Forgotten while this call was in flight: nothing to record.
      return;
    }
    if (reachable) {
      this.unreachable.delete(platformKeyOf(bridge));
    } else {
      this.unreachable.add(platformKeyOf(bridge));
    }
    this.recordSilence(bridge, answered);
    this.scheduleResync();
    const pushed = this.streams.get(bridge);
    if (!reachable && pushed) {
      // Its event stream may be dead too, without knowing it yet.
      pushed.stream.reconnect();
    }
    try {
      await this.reportStatus();
    } catch (error) {
      logger.warn(`Could not report the connection status: ${error.message}`);
    }
  }

  /**
   * Run one call to a bridge, recording whether it answered. An answer proving
   * the bridge gone (reset, or something else at its address) makes it
   * unreachable too, like a scan does: a moved or replaced bridge is only looked
   * for among those. A refused command (a light switched off, say) does not.
   * @param {object} bridge - Stored bridge.
   * @param {() => Promise<any>} operation - The call.
   * @returns {Promise<any>} The call's result.
   */
  async callBridge(bridge, operation) {
    try {
      const result = await operation();
      await this.markBridge(bridge, true);
      return result;
    } catch (error) {
      await this.markBridge(bridge, !isUnreachable(error) && !isGone(error), !isUnreachable(error));
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
      await this.searchMovedBridges();
      await this.syncDevices();
    } catch (error) {
      logger.warn(`Background resync failed: ${error.message}`);
      this.scheduleResync();
    }
  }

  /**
   * Look for the paired bridges that fail at their address, in case they only
   * changed it (a new DHCP lease): LAN discovery only, never the cloud, and at
   * most once a minute.
   * @returns {Promise<void>} Resolves once done; never rejects.
   */
  async searchMovedBridges() {
    if (!this.store.list().some((bridge) => bridge.id && this.unreachable.has(platformKeyOf(bridge)))) {
      return;
    }
    if (performance.now() - this.lastMoveSearchAt < MOVE_SEARCH_INTERVAL_MS) {
      return;
    }
    this.lastMoveSearchAt = performance.now();
    try {
      const { bridges } = await identifyBridges(await discoverBridges(this.gladys, { cloud: false }));
      await this.exclusive(() => this.followMovedBridges(bridges));
    } catch (error) {
      logger.warn(`Could not look for the bridges that changed address: ${error.message}`);
    }
  }

  /**
   * Follow the paired bridges that changed address: a bridge that fails at its
   * stored address, and that identification just found elsewhere under its id,
   * gets the new address and keeps its username, so it needs no new pairing.
   * Run under the bridge lock.
   * @param {Array<object>} identified - Bridges proven by identification.
   * @returns {Promise<object[]>} Stored bridges whose address was updated.
   */
  async followMovedBridges(identified) {
    const moved = [];
    for (const found of identified) {
      const bridge = this.store.list().find((stored) => stored.id && stored.id === found.id);
      if (!bridge || bridge.ip === found.ip || !this.unreachable.has(platformKeyOf(bridge))) {
        continue;
      }
      if (!keepsPin(bridge, found)) {
        logger.warn(`Bridge ${bridge.id} found at ${found.ip} with another certificate than the one pinned, ignored`);
        continue;
      }
      logger.info(`Bridge ${bridge.id} moved from ${bridge.ip} to ${found.ip}`);
      await this.store.upsert(credentialsOf(found, bridge.username));
      moved.push(bridge);
    }
    return moved;
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
    this.syncStreams();
  }

  /**
   * Stop the refresh loop and the event streams (disconnection, shutdown). A
   * refresh in progress ends normally but does not arm the next one.
   */
  stopPolling() {
    this.polling = false;
    clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.syncStreams();
  }

  /**
   * Keep one v2 event stream open per stored bridge while connected to Gladys:
   * close the ones of the bridges forgotten or moved, open the missing ones.
   * The refresh loop keeps running beside them, as a safety net (an event lost
   * while a stream reconnects) and for the bridges without v2.
   */
  syncStreams() {
    const active = this.polling && !this.stopped;
    for (const [bridge, { stream, ip }] of this.streams) {
      if (!active || !this.store.list().includes(bridge) || bridge.ip !== ip) {
        stream.stop();
        this.streams.delete(bridge);
      }
    }
    if (!active) {
      return;
    }
    for (const bridge of this.store.list()) {
      if (!this.streams.has(bridge) && this.withoutPush.get(bridge) !== bridge.ip && bridge.username) {
        this.startStream(bridge);
      }
    }
  }

  /**
   * Open the event stream of a bridge, and keep it open.
   * @param {object} bridge - Stored bridge.
   */
  startStream(bridge) {
    let index;
    const stream = new EventStream({
      name: `bridge ${bridge.ip}`,
      open: async () => {
        const opened = await this.openEventStream(bridge);
        index = opened.index;
        return opened;
      },
      onEvents: (events) => this.queuePatches(bridge, lightPatches(events, index)),
      // Catch up with what changed while it was closed.
      onOpen: () => this.refreshSoon(bridge, this.createdHueIdsOf(bridge)),
      onGiveUp: () => {
        this.withoutPush.set(bridge, bridge.ip);
        if (this.streams.get(bridge) && this.streams.get(bridge).stream === stream) {
          this.streams.delete(bridge);
        }
      },
    });
    this.streams.set(bridge, { stream, ip: bridge.ip });
    stream.start();
  }

  /**
   * Connect to the event stream of a bridge. A bridge paired over HTTP is moved
   * to HTTPS first: v2 only exists there.
   * @param {object} bridge - Stored bridge.
   * @returns {Promise<{ response: object, close: () => void, index: object }>} The open stream, and the index
   * of the resources its events name.
   * @throws {Error} With `permanent` set when the bridge has no event stream (old firmware), or something else
   * answers on HTTPS. A round bridge, which has no HTTPS at all, refuses the connection: that is retried, at most
   * once a minute, since a booting bridge refuses it too.
   */
  async openEventStream(bridge) {
    const client = this.clientFor(bridge);
    try {
      await client.switchToHttps();
    } catch (error) {
      error.permanent = Boolean(error.tlsRefused || error.wrongBridge);
      throw error;
    }
    if (!(await client.isV2())) {
      const error = new Error('no v2 API');
      error.permanent = true;
      throw error;
    }
    const lights = await client.getResources('light');
    const connectivities = await client.getResources('zigbee_connectivity');
    const opened = await client.openEventStream();
    return { ...opened, index: indexResources(lights, connectivities) };
  }

  /**
   * Hue ids of the lights of a bridge created in Gladys, among the known ones.
   * @param {object} bridge - Stored bridge.
   * @returns {string[]} Hue ids.
   */
  createdHueIdsOf(bridge) {
    const created = new Set(this.gladys.devices.map((device) => device.external_id));
    const hueIds = [];
    for (const [deviceId, entry] of this.registry) {
      if (created.has(deviceId) && this.ownerOf(deviceId) === bridge) {
        hueIds.push(entry.hueId);
      }
    }
    return hueIds;
  }

  /**
   * Publish the changes pushed by a bridge: at once for the first one, then
   * merged, at most once per `EVENT_THROTTLE_MS`.
   * @param {object} bridge - Stored bridge.
   * @param {Map<string, object>} patches - Partial v1 state by Hue id.
   */
  queuePatches(bridge, patches) {
    if (patches.size === 0) {
      return;
    }
    const pending = this.pendingPatches.get(bridge) || new Map();
    for (const [hueId, patch] of patches) {
      pending.set(hueId, { ...pending.get(hueId), ...patch });
    }
    this.pendingPatches.set(bridge, pending);
    if (!this.patchTimers.has(bridge)) {
      this.flushPatches(bridge);
    }
  }

  /**
   * Publish the pushed changes waiting for a bridge, and hold the next ones for
   * `EVENT_THROTTLE_MS`.
   * @param {object} bridge - Stored bridge.
   */
  flushPatches(bridge) {
    const pending = this.pendingPatches.get(bridge);
    this.pendingPatches.delete(bridge);
    if (!pending) {
      this.patchTimers.delete(bridge);
      return;
    }
    const timer = setTimeout(() => this.flushPatches(bridge), EVENT_THROTTLE_MS);
    timer.unref();
    this.patchTimers.set(bridge, timer);
    this.patchQueue = this.patchQueue
      .then(() => this.applyPatches(bridge, pending))
      .catch((error) => logger.warn(`Could not publish the changes pushed by bridge ${bridge.ip}: ${error.message}`));
  }

  /**
   * Apply changes pushed by a bridge to the lights it holds, and publish those
   * created in Gladys. Like a command, they make a refresh that read the lights
   * before skip them. A light reported cut at the wall is shown so after the
   * same confirmation as a read (see `debounceUnreachable`).
   * @param {object} bridge - Stored bridge.
   * @param {Map<string, object>} patches - Partial v1 state by Hue id.
   * @returns {Promise<void>} Resolves once published.
   */
  async applyPatches(bridge, patches) {
    if (!this.store.list().includes(bridge)) {
      return;
    }
    const created = new Set(this.gladys.devices.map((device) => device.external_id));
    this.commandSeq += 1;
    const entries = [];
    const shown = {};
    for (const [deviceId, entry] of this.registry) {
      const patch = patches.get(entry.hueId);
      if (!patch || this.ownerOf(deviceId) !== bridge) {
        continue;
      }
      entry.commandSeq = this.commandSeq;
      const light = this.debounceUnreachable(entry, { ...entry.light, state: { ...entry.light.state, ...patch } });
      if (created.has(deviceId)) {
        entries.push(entry);
        shown[entry.hueId] = light;
      }
    }
    try {
      for (const entry of entries) {
        await this.gladys.publishChangedStates(this.statesOf(entry, shown[entry.hueId]));
      }
    } catch (error) {
      logger.warn(`Could not publish the states of the lights of bridge ${bridge.ip}: ${error.message}`);
    }
    await this.publishLightTransports(entries, shown);
  }

  /**
   * The Gladys states of a light as it must be shown.
   * @param {object} entry - Registry entry of the light.
   * @param {object} light - Light to show.
   * @returns {Array<{ device_feature_external_id: string, state: number }>} States for publishChangedStates.
   */
  statesOf(entry, light) {
    const ids = this.gladys.externalIds(DEVICE_TYPE, entry.platformId);
    return hueStateToFeatureStates(ids, light).map((state) => ({
      device_feature_external_id: state.external_id,
      state: state.value,
    }));
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
    await Promise.all(
      this.store
        .list()
        .map((bridge) => this.refreshLights(bridge, this.clientFor(bridge), this.createdHueIdsOf(bridge))),
    );
    // Retry the transports that failed, even for lights no refresh covers any
    // more (those of a forgotten bridge).
    await this.queueTransports([]);
  }

  /**
   * Whether a device belongs to one of the stored bridges.
   * @param {object} device - Gladys device (has `external_id`).
   * @returns {boolean} False when its bridge was forgotten (or never paired).
   */
  hasStoredBridge(device) {
    return Boolean(this.ownerOf(device.external_id));
  }

  /**
   * A light missing from the registry (bridge down when it was last read, or
   * the process just started) triggers a resync before giving up on it, so it
   * works as soon as its bridge answers again. Concurrent calls share it.
   * @param {object} device - Gladys device (has `external_id`).
   * @returns {Promise<void>} Resolves once the registry is as fresh as it gets.
   */
  async ensureRegistered(device) {
    if (this.registry.has(device.external_id) || !this.hasStoredBridge(device)) {
      return;
    }
    if (!this.refreshing) {
      if (performance.now() - this.lastRefreshAt < REFRESH_MIN_INTERVAL_MS) {
        return;
      }
      this.lastRefreshAt = performance.now();
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
      if (!this.hasStoredBridge(device)) {
        throw new Error(
          `The Hue bridge of light ${device.external_id} is no longer paired: pair it again from the Configuration screen, or delete this device`,
        );
      }
      if (this.unreachable.size > 0) {
        throw new Error(
          `Hue bridge unreachable: light ${device.external_id} will be available again as soon as the bridge answers`,
        );
      }
      throw new Error(`Unknown light ${device.external_id}: run a scan from the Discovery tab`);
    }
    const bridge = this.ownerOf(device.external_id);
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
    const { entry, bridge, client } = this.resolve(device);
    const ids = this.gladys.externalIds(DEVICE_TYPE, entry.platformId);
    const kind = FEATURE_KINDS.find((k) => ids.feature(k) === feature.external_id);
    if (!kind) {
      throw new Error(`Unknown feature ${feature.external_id} on light ${device.external_id}`);
    }

    const hueState = featureValueToHueState(kind, value, entry.light);
    logger.info(`setValue ${feature.external_id} = ${value} -> ${JSON.stringify(hueState)}`);
    // Throws (and fails the command in Gladys) when the bridge refuses it.
    await this.callBridge(bridge, () => client.setLightState(entry.hueId, hueState));
    this.commandSeq += 1;
    entry.commandSeq = this.commandSeq;

    // Echo the commanded value back so Gladys reflects it immediately, along
    // with the on/off state it implies: setting a colour, a temperature or a
    // non-zero brightness also switches the light ON. Only what changed is sent
    // (Gladys caps an integration at 300 states/minute): the SDK remembers what
    // Gladys accepted, and forgets a light the user creates, updates or deletes.
    // A light cut at the wall accepts commands but stays dark: its on/off is not
    // echoed. Its power may have come back since the last refresh, so it is read
    // again shortly after (see `refreshSoon`).
    const unpowered = Boolean(entry.light.state) && entry.light.state.reachable === false;
    const echoed = [];
    if (kind !== FEATURE.ON_OFF || !unpowered) {
      echoed.push({ device_feature_external_id: feature.external_id, state: value });
    }
    if (kind !== FEATURE.ON_OFF && typeof hueState.on === 'boolean' && !unpowered) {
      echoed.push({ device_feature_external_id: ids.feature(FEATURE.ON_OFF), state: hueState.on ? 1 : 0 });
    }
    if (echoed.length > 0) {
      await this.gladys.publishChangedStates(echoed);
    }
    if (unpowered) {
      this.refreshSoon(bridge, [entry.hueId]);
    }
  }

  /**
   * Read some lights of a bridge again shortly, in ONE read shared with every
   * other call made meanwhile: a scene switching on six lights cut at the wall
   * would otherwise send six full reads at once, on top of its commands.
   * @param {object} bridge - Stored bridge.
   * @param {string[]} hueIds - Hue ids of the lights.
   */
  refreshSoon(bridge, hueIds) {
    if (hueIds.length === 0) {
      return;
    }
    let pending = this.pendingRefreshes.get(bridge);
    if (!pending) {
      pending = new Set();
      this.pendingRefreshes.set(bridge, pending);
      const timer = setTimeout(() => {
        this.pendingRefreshes.delete(bridge);
        this.refreshLights(bridge, this.clientFor(bridge), [...pending]);
      }, REFRESH_COALESCE_MS);
      timer.unref();
    }
    hueIds.forEach((hueId) => pending.add(hueId));
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
        return this.callBridge(bridge, () => Promise.all([client.getGroups(), client.getScenes()]));
      }),
    );
    const candidates = [];
    const failures = [];
    results.forEach((result, index) => {
      const bridge = bridges[index];
      const { ip } = bridge;
      if (result.status === 'fulfilled') {
        const [groups, scenes] = result.value;
        // The bridge itself, not its address: two stored bridges may share one.
        candidates.push(...listSceneCandidates(ip, groups, scenes).map((candidate) => ({ ...candidate, bridge })));
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

    const { bridge } = match;
    const client = this.clientFor(bridge);
    logger.info(`Recalling Hue scene "${match.sceneName}" (${match.roomName || 'all lights'}) on ${match.bridgeIp}`);
    await this.callBridge(bridge, () => client.recallScene(match.groupId, match.sceneId));
    // Like a command: a refresh already reading these lights must not undo it.
    this.commandSeq += 1;
    for (const [deviceId, entry] of this.registry) {
      if (match.lights.includes(entry.hueId) && this.ownerOf(deviceId) === bridge) {
        entry.commandSeq = this.commandSeq;
      }
    }
    // Not awaited: the scene is on, a slow refresh must not delay the ack past
    // the action's timeout and turn it into a failure.
    this.refreshLights(bridge, client, match.lights);
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
   * @param {{ ip: string }} bridge - Stored bridge the lights belong to.
   * @param {HueBridgeClient} client - Client of that bridge.
   * @param {string[]} hueIds - Hue ids of the lights.
   * @returns {Promise<void>} Resolves once the states are published.
   */
  async refreshLights(bridge, client, hueIds) {
    // By owner, not by address: two stored bridges may share one.
    const entries = [...this.registry]
      .filter(([deviceId, entry]) => hueIds.includes(entry.hueId) && this.ownerOf(deviceId) === bridge)
      .map(([, entry]) => entry);
    if (entries.length === 0) {
      return;
    }
    const readSeq = this.commandSeq;
    let lights;
    try {
      lights = await this.callBridge(bridge, () => client.getLights());
    } catch (error) {
      logger.warn(`Could not refresh the lights of bridge ${bridge.ip}: ${error.message}`);
      if (isUnreachable(error)) {
        // The bridge does not answer: none of its lights can be reached.
        await this.markLightsUnreachable(bridge);
      }
      return;
    }
    if (!this.store.list().includes(bridge)) {
      return; // forgotten during the read: its lights keep the badge Forget gave them
    }

    const shown = {};
    // Apart from the bridge read: a failure on the Gladys side (429, validation)
    // says nothing about the bridge. Inside a try all the same, so that an
    // unexpected body never rejects (scene and command callers do not await).
    try {
      for (const entry of entries) {
        const light = lights[entry.hueId];
        if (light && entry.commandSeq <= readSeq) {
          shown[entry.hueId] = this.debounceUnreachable(entry, light);
          await this.gladys.publishChangedStates(this.statesOf(entry, shown[entry.hueId]));
        }
      }
    } catch (error) {
      logger.warn(`Could not publish the states of the lights of bridge ${bridge.ip}: ${error.message}`);
    }
    await this.publishLightTransports(entries, shown);
  }

  /**
   * Cache a light just read, and return it as it must be shown. Hue's
   * `reachable` flaps for bulbs at the edge of the mesh: a light is only shown
   * cut at the wall once two reads in a row say so, so that a blip neither logs
   * an off/on in its history nor fires "turned off" scene triggers.
   * @param {object} entry - Registry entry of the light.
   * @param {object} light - Light as the bridge just returned it.
   * @returns {object} The light to publish.
   */
  debounceUnreachable(entry, light) {
    const wasCut = Boolean(entry.light.state) && entry.light.state.reachable === false;
    entry.light = light; // refresh cached capabilities/state
    if (wasCut || !light.state || light.state.reachable !== false) {
      return light;
    }
    return { ...light, state: { ...light.state, reachable: true } };
  }

  /**
   * One transport entry for a light.
   * @param {object} entry - Registry entry of the light.
   * @param {string} transport - One of DEVICE_TRANSPORTS.
   * @returns {{ external_id: string, transport: string }} Entry for publishTransports.
   */
  transportOf(entry, transport) {
    return { external_id: this.gladys.externalIds(DEVICE_TYPE, entry.platformId).device, transport };
  }

  /**
   * Publish the transport badge of the given lights: `unreachable` while the
   * bridge reports them unreachable (powered off at the wall), `local` otherwise.
   * @param {Array<object>} entries - Registry entries of the lights.
   * @param {Record<string, object>} lights - Lights as they must be shown, by Hue id.
   * @returns {Promise<void>} Resolves once published; never rejects.
   */
  async publishLightTransports(entries, lights) {
    const wanted = [];
    for (const entry of entries) {
      const light = lights[entry.hueId];
      if (light) {
        const powered = !(light.state && light.state.reachable === false);
        wanted.push(this.transportOf(entry, powered ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE));
      }
    }
    await this.queueTransports(wanted);
  }

  /**
   * Publish the transports of the devices created in Gladys whose transport
   * changed, one call at a time so they reach Gladys in order. Like the SDK's
   * publishChangedStates, the cache is written before the request and cleared
   * when it fails (Gladys may have applied a request that timed out), so a
   * forgetTransports() landing meanwhile is not undone. Never rejects: a failed
   * badge is kept in `pendingTransports` and sent again with the next call.
   * @param {Array<{ external_id: string, transport: string }>} wanted - Transports to publish.
   * @returns {Promise<void>} Resolves once published.
   */
  queueTransports(wanted) {
    const run = this.transportQueue.then(() => this.sendTransports(wanted));
    // A rejection must not block every later badge.
    this.transportQueue = run.catch(() => {});
    return run;
  }

  /**
   * One queued publication (see queueTransports).
   * @param {Array<{ external_id: string, transport: string }>} wanted - Transports to publish.
   * @returns {Promise<void>} Resolves once published; never rejects.
   */
  async sendTransports(wanted) {
    // A newer transport for a device replaces the one waiting for a retry.
    wanted.forEach(({ external_id: externalId }) => this.pendingTransports.delete(externalId));
    const retried = [...this.pendingTransports].map(([externalId, transport]) => ({
      external_id: externalId,
      transport,
    }));
    this.pendingTransports.clear();
    const created = new Set(this.gladys.devices.map((device) => device.external_id));
    const changed = [...retried, ...wanted].filter(
      ({ external_id: externalId, transport }) =>
        created.has(externalId) && this.transports.get(externalId) !== transport,
    );
    for (let start = 0; start < changed.length; start += MAX_TRANSPORTS_PER_REQUEST) {
      const batch = changed.slice(start, start + MAX_TRANSPORTS_PER_REQUEST);
      batch.forEach(({ external_id: externalId, transport }) => this.transports.set(externalId, transport));
      try {
        await this.gladys.publishTransports(batch);
      } catch (error) {
        logger.warn(`Could not publish the light transports: ${error.message}`);
        batch.forEach(({ external_id: externalId, transport }) => {
          if (this.transports.get(externalId) === transport) {
            this.transports.delete(externalId); // unless forgotten meanwhile
          }
        });
        changed.slice(start).forEach(({ external_id: externalId, transport }) => {
          this.pendingTransports.set(externalId, transport);
        });
        return;
      }
    }
  }

  /**
   * Forget the transports published so far, so the next refresh sends them
   * again: for one device the user created, updated or deleted, or for all of
   * them after a reconnection.
   * @param {string} [externalId] - Device external_id; all devices when omitted.
   */
  forgetTransports(externalId) {
    if (externalId === undefined) {
      this.transports.clear();
    } else {
      this.transports.delete(externalId);
    }
  }

  /**
   * Forget every paired bridge that is gone for good: replaced, migrated to a
   * Bridge Pro, reset, or unplugged. Without this an old bridge stays stored
   * forever, the status keeps saying "1 Hue bridge unreachable" and the
   * background resync never stops. A bridge is forgotten when its read gets an
   * answer proving it is gone (see `isGone`), or no answer at all after getting
   * none for `SILENT_FORGET_MS` already (a firmware update reboots it for 1 to 2
   * minutes; a 429/5xx answer is not "no answer"). The probe is recorded like
   * any read, so that a later click can forget a bridge nothing else reads. Any
   * other failure keeps the bridge, in `busy`. Their lights stay in Gladys, for
   * the user to delete, with the `unreachable` badge. Runs under the lock it
   * shares with pairing, so no bridge is paired again while it runs.
   *
   * Never rejects once bridges are removed: what follows the removal is
   * best-effort, and the caller must report what was forgotten.
   * @returns {Promise<{ forgotten: object[], kept: object[], busy: object[], saveError?: Error }>} Bridges
   * forgotten, kept (`busy` among them), and the error of saving the removal, if any.
   */
  forgetUnreachableBridges() {
    return this.exclusive(() => this.forgetGoneBridges());
  }

  /**
   * The body of `forgetUnreachableBridges`, run under the bridge lock.
   * @returns {Promise<{ forgotten: object[], kept: object[], busy: object[], saveError?: Error }>} See
   * `forgetUnreachableBridges`.
   */
  async forgetGoneBridges() {
    const silentSince = new Map(this.silentSince);
    const bridges = [...this.store.list()];
    // In parallel: each dead bridge costs a full timeout (~16 s with the retry).
    const reads = bridges.map((bridge) => this.clientFor(bridge).getLights());
    const results = await Promise.allSettled(reads);
    const forgotten = [];
    const kept = [];
    const busy = [];
    for (const [index, result] of results.entries()) {
      const bridge = bridges[index];
      const { reason } = result;
      const since = silentSince.get(platformKeyOf(bridge));
      const longSilent = since !== undefined && performance.now() - since >= SILENT_FORGET_MS;
      if (result.status === 'rejected' && (isGone(reason) || (isUnreachable(reason) && longSilent))) {
        logger.info(`Forgetting bridge ${bridge.ip}: ${reason.message}`);
        forgotten.push(bridge);
        continue;
      }
      if (result.status === 'rejected') {
        logger.info(`Keeping bridge ${bridge.ip}, which may only be busy or restarting: ${reason.message}`);
        busy.push(bridge);
      }
      kept.push(bridge);
      // Like any read: the status, and when it started not answering.
      await this.markBridge(bridge, result.status === 'fulfilled' || !isUnreachable(reason));
    }
    if (forgotten.length === 0) {
      return { forgotten, kept, busy };
    }

    const saveError = await this.store.remove(forgotten);
    // By owner, not by address: a bridge still stored may share it.
    const candidates = [...this.store.list(), ...forgotten];
    for (const deviceId of [...this.registry.keys()]) {
      if (forgotten.includes(this.ownerOf(deviceId, candidates))) {
        this.registry.delete(deviceId);
      }
    }
    for (const bridge of forgotten) {
      this.silentSince.delete(platformKeyOf(bridge));
      this.unreachable.delete(platformKeyOf(bridge));
    }
    // Stops the background resync when no unreachable bridge is left.
    this.scheduleResync();
    try {
      // Nothing will ever refresh these lights again.
      for (const bridge of forgotten) {
        await this.markLightsUnreachable(bridge);
      }
      // Even if no bridge answers: the previous list holds the forgotten lights.
      // From the probe's reads: reading again would push the action past its
      // 30 s timeout when a bridge does not answer.
      await this.syncDevices({ force: true, reads: new Map(bridges.map((bridge, index) => [bridge, reads[index]])) });
    } catch (error) {
      logger.warn(`Could not resynchronize after forgetting bridges: ${error.message}`);
      await this.reportStatus(true).catch((statusError) =>
        logger.warn(`Could not report the connection status: ${statusError.message}`),
      );
    }
    return { forgotten, kept, busy, ...(saveError ? { saveError } : {}) };
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
    const identified = await identifyBridges(await this.candidateBridges());
    // A paired bridge found at a new address is followed there.
    await this.exclusive(() => this.followMovedBridges(identified.bridges));
    return identified;
  }

  /**
   * Try to pair every identified bridge (the physical link button must have
   * been pressed). Successfully paired bridges are persisted.
   *
   * The outcome is split per cause so the UI can tell the user what to actually
   * do next, instead of a single "it failed". `replaced` lists the bridges that
   * took the place of a previous one (a migration to a Bridge Pro), whose lights
   * keep their devices.
   * @returns {Promise<{ paired: object[], pending: object[], unreachable: object[], notABridge: string[],
   *   replaced: Array<{ bridge: object, previous: object }> }>} Result per bridge.
   */
  async pairBridges() {
    const { bridges, ignored } = await this.identifiedBridges();
    const result = { paired: [], pending: [], unreachable: [], notABridge: ignored, replaced: [] };
    // Only the store change waits for a running Forget: discovery above does not.
    await this.exclusive(() => this.pairIdentified(bridges, result));
    return result;
  }

  /**
   * The store part of `pairBridges`, run under the bridge lock. A bridge whose
   * stored username still works needs no link button. The username of another
   * bridge is never tried on a new one, although a migration to a Bridge Pro
   * moves the keys of the apps: nothing but the id it announces proves who the
   * new bridge is, and anything on the network can claim one. It is recognized
   * by its lights instead, once paired (see `previousOwnerOf`).
   * @param {Array<object>} bridges - Identified bridges.
   * @param {{ paired: object[], pending: object[], unreachable: object[], replaced: object[] }} result - Filled
   * in place.
   * @returns {Promise<void>} Resolves once every bridge was tried.
   */
  async pairIdentified(bridges, result) {
    for (const bridge of bridges) {
      // Like `upsert`: by id, or an entry saved without one at this address.
      const stored =
        this.store.list().find((known) => known.id === bridge.id) ||
        this.store.list().find((known) => !known.id && known.ip === bridge.ip);
      if (stored && keepsPin(stored, bridge) && (await this.keyWorks(bridge, stored.username))) {
        // Paired already: no new user, which would be left orphan on the bridge.
        await this.store.upsert(credentialsOf(bridge, stored.username));
        result.paired.push(bridge);
        continue;
      }
      await this.pairWithButton(bridge, Boolean(stored), result);
    }
  }

  /**
   * Pair a bridge with the link button, and recognize it as the replacement of
   * a bridge that does not answer, or was forgotten, when it holds its lights.
   * @param {object} bridge - Identified bridge.
   * @param {boolean} known - Whether it is stored already.
   * @param {{ paired: object[], pending: object[], unreachable: object[], replaced: object[] }} result - Filled
   * in place.
   * @returns {Promise<void>} Resolves once tried.
   */
  async pairWithButton(bridge, known, result) {
    // Reuse what identification already learned: the scheme that answered and
    // the certificate pinned on the way.
    const client = new HueBridgeClient(bridge.ip, undefined, {
      scheme: bridge.scheme,
      id: bridge.id,
      certFingerprint: bridge.certFingerprint,
    });
    try {
      const username = await client.createUser(APP_NAME);
      const credentials = credentialsOf({ ...bridge, certFingerprint: client.certFingerprint }, username);
      const previous = known ? undefined : await this.previousOwnerOf(client, bridge);
      if (previous) {
        await this.replaceBridge(bridge, previous, credentials, result);
        return;
      }
      await this.store.upsert(credentials);
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

  /**
   * Store a bridge in place of the one it replaces, under that bridge's key, so
   * that the lights already created keep their external_ids.
   * @param {object} bridge - Identified bridge.
   * @param {object} previous - Stored or forgotten bridge it replaces.
   * @param {object} credentials - Store entry of the new bridge.
   * @param {{ paired: object[], replaced: object[] }} result - Filled in place.
   * @returns {Promise<void>} Resolves once stored.
   */
  async replaceBridge(bridge, previous, credentials, result) {
    logger.info(`Bridge ${bridge.id} replaces bridge ${previous.id || previous.ip}`);
    await this.store.replace(previous, { ...credentials, platformKey: platformKeyOf(previous) });
    result.paired.push(bridge);
    result.replaced.push({ bridge, previous });
  }

  /**
   * Whether a username works on an identified bridge.
   * @param {object} found - Identified bridge.
   * @param {string} username - Username to try.
   * @returns {Promise<boolean>} True when the bridge accepts it.
   */
  async keyWorks(found, username) {
    const client = new HueBridgeClient(found.ip, username, {
      scheme: found.scheme,
      id: found.id,
      certFingerprint: found.certFingerprint,
    });
    try {
      await client.getLights();
      return true;
    } catch (error) {
      logger.debug(`A stored username does not work on bridge ${found.ip}: ${error.message}`);
      return false;
    }
  }

  /**
   * The bridge, failing or forgotten, whose lights a newly paired bridge holds
   * now: at least half of the lights created from it, by `uniqueid` (a Zigbee
   * MAC, which a migration or a reset of the bulbs keeps). A failing bridge
   * only, so that a bulb moved between two working bridges changes nothing.
   * @param {HueBridgeClient} client - Client of the new bridge, paired.
   * @param {{ id: string }} found - The new bridge, as identified.
   * @returns {Promise<object | undefined>} Stored or forgotten bridge, if any.
   */
  async previousOwnerOf(client, found) {
    let lights;
    try {
      lights = await client.getLights();
    } catch (error) {
      logger.debug(`Could not read the lights of the new bridge ${client.ip}: ${error.message}`);
      return undefined;
    }
    const uniqueids = new Set(Object.values(lights || {}).map((light) => light && light.uniqueid));
    const candidates = [
      ...this.store.list().filter((bridge) => this.unreachable.has(platformKeyOf(bridge))),
      // Not itself: forgotten then paired again, `upsert` gives it its key back.
      ...this.store.forgotten.filter((entry) => entry.id !== found.id),
    ];
    for (const previous of candidates) {
      const prefix = this.gladys.externalIds(DEVICE_TYPE, `${platformKeyOf(previous)}-`).device;
      const created = this.createdLightsOf(previous).map((externalId) => externalId.slice(prefix.length));
      const moved = created.filter((uniqueid) => uniqueids.has(uniqueid));
      if (moved.length > 0 && moved.length * 2 >= created.length) {
        return previous;
      }
    }
    return undefined;
  }
}

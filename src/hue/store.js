// -----------------------------------------------------------------------------
// Persistent store for paired bridges.
//
// Once a bridge is paired, its username (application key) must survive restarts.
// The container rootfs is READ-ONLY except for the `/data` volume, so we persist
// there. The path is overridable through `HUE_DATA_DIR` for local development
// and tests.
//
// Shape persisted: { bridges: [{ id, ip, username, ... }], forgotten?: [{ id?, ip, platformKey }] }
// -----------------------------------------------------------------------------

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'hue-store' });

const DATA_DIR = process.env.HUE_DATA_DIR || '/data';
const STORE_FILE = path.join(DATA_DIR, 'bridges.json');

// Owner-only: the file holds the bridge usernames, each a full-control key.
const FILE_MODE = 0o600;

/**
 * Whether a forgotten bridge is the one being paired: by id when it had one,
 * otherwise by address, the way `upsert` recognizes an entry saved without an id.
 * @param {{ id?: string, ip: string }} forgotten - Entry of `BridgeStore.forgotten`.
 * @param {{ id?: string, ip: string }} bridge - Bridge being paired or forgotten.
 * @returns {boolean} True when they are the same bridge.
 */
function forgottenMatches(forgotten, bridge) {
  return forgotten.id ? forgotten.id === bridge.id : forgotten.ip === bridge.ip;
}

/**
 * Simple JSON-file store for the list of paired bridges, with an in-memory cache.
 */
export class BridgeStore {
  /**
   * @param {string} [file] - Override the store file path (mainly for tests).
   */
  constructor(file = STORE_FILE) {
    this.file = file;
    /** @type {Array<{ id: string, ip: string, username: string }>} */
    this.bridges = [];
    this.loaded = false;
    /** @type {Error | undefined} Last failure to write the store, if any. */
    this.persistError = undefined;
    // Tail of the write queue (see `persist`).
    this.writing = Promise.resolve();
    /**
     * The `platformKey` of forgotten bridges, given back if they are paired again
     * (see `remove`).
     * @type {Array<{ id?: string, ip: string, platformKey: string }>}
     */
    this.forgotten = [];
  }

  /**
   * Load the persisted bridges into memory (idempotent).
   * @returns {Promise<Array<{ id: string, ip: string, username: string }>>} Bridges.
   */
  async load() {
    // A crash between write and rename leaves the temporary file behind: it may
    // hold credentials, and is never the source of truth (the rename did not happen).
    await fs.rm(`${this.file}.tmp`, { force: true }).catch(() => {});
    // Files written by older versions got the default 0644: tighten them.
    await fs.chmod(this.file, FILE_MODE).catch(() => {});
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.bridges = Array.isArray(parsed.bridges) ? parsed.bridges : [];
      this.forgotten = Array.isArray(parsed.forgotten) ? parsed.forgotten : [];
    } catch (error) {
      if (error.code === 'ENOENT') {
        // First run: nothing paired yet, this is the normal path.
        this.bridges = [];
      } else {
        // Anything else means we HAD credentials and can no longer read them:
        // the user will have to press the link button again, so say it loudly.
        logger.error(`Could not read the bridge store (${error.message}) — pairing may have to be redone`);
        this.bridges = [];
      }
    }
    this.loaded = true;
    return this.bridges;
  }

  /**
   * Persist the current bridge list to disk, atomically.
   *
   * Written to a temporary file then renamed: `rename` is atomic on the same
   * filesystem, so a power cut can never leave a truncated `bridges.json` —
   * which `load()` would read as "no bridge paired", silently losing the
   * pairing and sending the user back to the bridge's link button.
   *
   * Writes run one at a time: two interleaved writes share the temporary file,
   * and the second rename fails once the first moved it away.
   * @returns {Promise<void>} Resolves once written.
   */
  persist() {
    const write = this.writing.then(() => this.write());
    this.writing = write.catch(() => {});
    return write;
  }

  /**
   * One write of the store (see `persist`).
   * @returns {Promise<void>} Resolves once written.
   */
  async write() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporaryFile = `${this.file}.tmp`;
    // `mode` only applies when the file is created: a leftover temporary file
    // would otherwise lend its (looser) mode to the store through the rename.
    await fs.rm(temporaryFile, { force: true });
    const content = { bridges: this.bridges, ...(this.forgotten.length > 0 ? { forgotten: this.forgotten } : {}) };
    await fs.writeFile(temporaryFile, JSON.stringify(content, null, 2), {
      encoding: 'utf8',
      mode: FILE_MODE,
    });
    await fs.rename(temporaryFile, this.file);
  }

  /**
   * Add or update a paired bridge (keyed by id, falling back to ip), then persist.
   *
   * A write failure does NOT fail the pairing: the credentials the bridge just
   * granted are valid, and dropping them would force the user to press the link
   * button again for nothing. They are kept in memory so the session works, and
   * `persistError` is exposed so the caller can warn that they will not survive
   * a restart — much more useful than an EACCES stack trace reported as
   * "could not reach the bridge".
   * @param {{ id: string, ip: string, username: string, scheme?: string, certFingerprint?: string }} bridge -
   * Bridge credentials, plus the transport learned at pairing time: the scheme the bridge answers on and, for
   * HTTPS bridges, the certificate fingerprint pinned on first contact. Entries saved by older versions simply
   * have neither and fall back to plain HTTP. `platformKey` is set by the store itself (see below).
   * @returns {Promise<void>} Resolves once stored (persisted or in memory only).
   */
  async upsert(bridge) {
    const key = bridge.id || bridge.ip;
    // Up to 1.1.0 a bridge paired through the manual IP field was saved without
    // an id: the same bridge coming back WITH its id must update that entry.
    const existing =
      this.bridges.find((b) => (b.id || b.ip) === key) ||
      (bridge.id ? this.bridges.find((b) => !b.id && b.ip === bridge.ip) : undefined);
    if (existing) {
      if (!existing.id && bridge.id && !existing.platformKey) {
        // Its lights' external_ids were built from that IP: freeze it, so they
        // survive the id being learned and any later change of address.
        existing.platformKey = existing.ip;
      }
      Object.assign(existing, bridge);
    } else {
      const forgotten = this.forgotten.find((entry) => forgottenMatches(entry, bridge));
      if (forgotten) {
        // Forgotten, then paired again: its lights keep their external_ids.
        this.forgotten = this.forgotten.filter((entry) => entry !== forgotten);
        this.bridges.push({ ...bridge, platformKey: forgotten.platformKey });
      } else {
        this.bridges.push(bridge);
      }
    }
    try {
      await this.persist();
      this.persistError = undefined;
    } catch (error) {
      this.persistError = error;
      logger.error(`Could not save the paired bridges to ${this.file} (${error.message}) — pairing is memory-only`);
    }
  }

  /**
   * Forget paired bridges, then persist. Like `upsert`, a write failure is kept
   * in `persistError` instead of thrown: the bridges are gone for this session.
   *
   * The external_ids of a bridge's lights are built from `platformKey || id ||
   * ip`. A bridge paired by 1.0.x/1.1.0 relies on its IP (`platformKey`, or no id
   * at all): that key is kept in `forgotten`, so pairing the bridge again gives
   * its lights back the same external_ids instead of new devices.
   * @param {Array<object>} bridges - Entries of `list()` to remove.
   * @returns {Promise<Error | undefined>} The error of saving the removal, if any (also in `persistError`).
   */
  async remove(bridges) {
    for (const bridge of bridges) {
      const platformKey = bridge.platformKey || (bridge.id ? undefined : bridge.ip);
      if (platformKey) {
        const entry = { ...(bridge.id ? { id: bridge.id } : {}), ip: bridge.ip, platformKey };
        this.forgotten = [...this.forgotten.filter((known) => !forgottenMatches(known, bridge)), entry];
      }
    }
    this.bridges = this.bridges.filter((bridge) => !bridges.includes(bridge));
    try {
      await this.persist();
      this.persistError = undefined;
    } catch (error) {
      this.persistError = error;
      logger.error(`Could not save the paired bridges to ${this.file} (${error.message}) — removal is memory-only`);
      return error;
    }
    return undefined;
  }

  /**
   * @returns {Array<{ id: string, ip: string, username: string }>} Paired bridges.
   */
  list() {
    return this.bridges;
  }
}

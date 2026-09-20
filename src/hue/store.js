// -----------------------------------------------------------------------------
// Persistent store for paired bridges.
//
// Once a bridge is paired, its username (application key) must survive restarts.
// The container rootfs is READ-ONLY except for the `/data` volume, so we persist
// there. The path is overridable through `HUE_DATA_DIR` for local development
// and tests.
//
// Shape persisted: { bridges: [{ id, ip, username }] }
// -----------------------------------------------------------------------------

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'hue-store' });

const DATA_DIR = process.env.HUE_DATA_DIR || '/data';
const STORE_FILE = path.join(DATA_DIR, 'bridges.json');

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
  }

  /**
   * Load the persisted bridges into memory (idempotent).
   * @returns {Promise<Array<{ id: string, ip: string, username: string }>>} Bridges.
   */
  async load() {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.bridges = Array.isArray(parsed.bridges) ? parsed.bridges : [];
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
   * @returns {Promise<void>} Resolves once written.
   */
  async persist() {
    const directory = path.dirname(this.file);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    // mkdir's mode only applies at creation time. Tighten an existing bind mount
    // too, otherwise other host users may be able to traverse the credential dir.
    await fs.chmod(directory, 0o700);

    // Unique + exclusive prevents concurrent saves (or a pre-created symlink)
    // from redirecting the secret write to a predictable `.tmp` path.
    const temporaryFile = path.join(directory, `.${path.basename(this.file)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporaryFile, JSON.stringify({ bridges: this.bridges }, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await fs.rename(temporaryFile, this.file);
      // rename preserves the temporary file's mode, but chmod also repairs a
      // credential file written by an older release with broader permissions.
      await fs.chmod(this.file, 0o600);
    } catch (error) {
      await fs.unlink(temporaryFile).catch(() => {});
      throw error;
    }
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
   * have neither and fall back to plain HTTP.
   * @returns {Promise<void>} Resolves once stored (persisted or in memory only).
   */
  async upsert(bridge) {
    const key = bridge.id || bridge.ip;
    const existing = this.bridges.find((b) => (b.id || b.ip) === key);
    if (existing) {
      Object.assign(existing, bridge);
    } else {
      this.bridges.push(bridge);
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
   * @returns {Array<{ id: string, ip: string, username: string }>} Paired bridges.
   */
  list() {
    return this.bridges;
  }
}

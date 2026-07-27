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
      if (error.code !== 'ENOENT') {
        logger.warn(`Could not read bridge store (${error.message}), starting empty`);
      }
      this.bridges = [];
    }
    this.loaded = true;
    return this.bridges;
  }

  /**
   * Persist the current bridge list to disk.
   * @returns {Promise<void>} Resolves once written.
   */
  async persist() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify({ bridges: this.bridges }, null, 2), 'utf8');
  }

  /**
   * Add or update a paired bridge (keyed by id, falling back to ip), then persist.
   * @param {{ id: string, ip: string, username: string }} bridge - Bridge credentials.
   * @returns {Promise<void>} Resolves once persisted.
   */
  async upsert(bridge) {
    const key = bridge.id || bridge.ip;
    const existing = this.bridges.find((b) => (b.id || b.ip) === key);
    if (existing) {
      Object.assign(existing, bridge);
    } else {
      this.bridges.push(bridge);
    }
    await this.persist();
  }

  /**
   * @returns {Array<{ id: string, ip: string, username: string }>} Paired bridges.
   */
  list() {
    return this.bridges;
  }
}

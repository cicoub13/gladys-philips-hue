import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BridgeStore } from '../src/hue/store.js';

async function tempFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hue-store-'));
  return path.join(dir, 'bridges.json');
}

test('BridgeStore starts empty when the file does not exist', async () => {
  const store = new BridgeStore(await tempFile());
  await store.load();
  assert.deepEqual(store.list(), []);
});

test('BridgeStore upserts and persists bridges', async () => {
  const file = await tempFile();
  const store = new BridgeStore(file);
  await store.load();
  await store.upsert({ id: 'b1', ip: '192.168.1.10', username: 'user-1' });
  await store.upsert({ id: 'b1', ip: '192.168.1.11', username: 'user-1' }); // update ip

  const reopened = new BridgeStore(file);
  await reopened.load();
  assert.equal(reopened.list().length, 1);
  assert.equal(reopened.list()[0].ip, '192.168.1.11');
});

test('BridgeStore keeps distinct bridges apart', async () => {
  const store = new BridgeStore(await tempFile());
  await store.load();
  await store.upsert({ id: 'b1', ip: '10.0.0.1', username: 'u1' });
  await store.upsert({ id: 'b2', ip: '10.0.0.2', username: 'u2' });
  assert.equal(store.list().length, 2);
});

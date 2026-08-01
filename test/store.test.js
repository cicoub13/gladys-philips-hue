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

test('BridgeStore writes atomically, never leaving a truncated file', async () => {
  // A power cut mid-write used to leave an unparsable bridges.json, which reads
  // back as "nothing paired": the user had to press the link button again.
  const file = await tempFile();
  const store = new BridgeStore(file);
  await store.load();
  await store.upsert({ id: 'b1', ip: '10.0.0.1', username: 'u1' });

  const written = await fs.readFile(file, 'utf8');
  assert.deepEqual(JSON.parse(written).bridges.length, 1);
  // The temporary file is renamed, not left behind.
  await assert.rejects(() => fs.access(`${file}.tmp`));
});

test('a store that cannot be written keeps the pairing alive and reports why', async () => {
  // The data volume may be owned by root while we run unprivileged: losing the
  // credentials the bridge just granted would send the user back to the link
  // button for nothing.
  //
  // The failure is provoked portably by putting a FILE where the store expects
  // its parent directory, so mkdir fails the same way on every platform.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hue-store-ro-'));
  const blocker = path.join(dir, 'not-a-directory');
  await fs.writeFile(blocker, 'this is a file', 'utf8');

  const store = new BridgeStore(path.join(blocker, 'bridges.json'));
  await store.load();
  await store.upsert({ id: 'b1', ip: '10.0.0.1', username: 'u1' });

  assert.equal(store.list().length, 1, 'the session can still talk to the bridge');
  assert.ok(store.persistError, 'the failure is exposed, not swallowed');
});

test('BridgeStore starts empty rather than crashing on a corrupted file', async () => {
  const file = await tempFile();
  await fs.writeFile(file, '{"bridges": [{"id": "b1"', 'utf8');
  const store = new BridgeStore(file);
  await store.load();
  assert.deepEqual(store.list(), []);

  // And it recovers: a new pairing overwrites the corrupted content.
  await store.upsert({ id: 'b1', ip: '10.0.0.1', username: 'u1' });
  const reopened = new BridgeStore(file);
  await reopened.load();
  assert.equal(reopened.list().length, 1);
});

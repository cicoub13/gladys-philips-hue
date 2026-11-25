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

test('the bridge store is readable by its owner only', async () => {
  // It holds the bridge usernames, each a full-control key to the lights.
  const file = await tempFile();
  const store = new BridgeStore(file);
  await store.load();
  await store.upsert({ id: 'b1', ip: '10.0.0.1', username: 'u1' });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('a store written by an older version is tightened at load', async () => {
  const file = await tempFile();
  await fs.writeFile(file, JSON.stringify({ bridges: [{ id: 'b1', ip: '10.0.0.1', username: 'u1' }] }), {
    mode: 0o644,
  });
  const store = new BridgeStore(file);
  await store.load();
  assert.equal(store.list().length, 1);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('a temporary file left by an interrupted write is cleaned up and never reused', async () => {
  // A crash between the write and the rename leaves `bridges.json.tmp` behind,
  // world-readable: it must not linger, nor lend its mode to the next write.
  const file = await tempFile();
  await fs.writeFile(`${file}.tmp`, '{"bridges": [', { mode: 0o644 });
  const store = new BridgeStore(file);
  await store.load();
  await assert.rejects(() => fs.access(`${file}.tmp`), 'the leftover is removed at load');

  await fs.writeFile(`${file}.tmp`, '{"bridges": [', { mode: 0o644 });
  await store.upsert({ id: 'b1', ip: '10.0.0.1', username: 'u1' });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('BridgeStore survives concurrent writes', async () => {
  // Two bridges switched to HTTPS in the same refresh: interleaved writes
  // shared the temporary file, and the second rename failed with ENOENT.
  const file = await tempFile();
  const store = new BridgeStore(file);
  await store.load();
  await Promise.all([
    store.upsert({ id: 'b1', ip: '192.168.1.10', username: 'user-1' }),
    store.upsert({ id: 'b2', ip: '192.168.1.20', username: 'user-2' }),
  ]);
  assert.equal(store.persistError, undefined);

  const reopened = new BridgeStore(file);
  await reopened.load();
  assert.equal(reopened.list().length, 2);
});

test('BridgeStore removes bridges and persists the removal', async () => {
  const file = await tempFile();
  const store = new BridgeStore(file);
  await store.load();
  await store.upsert({ id: 'b1', ip: '192.168.1.10', username: 'user-1' });
  await store.upsert({ id: 'b2', ip: '192.168.1.20', username: 'user-2' });

  await store.remove([store.list()[1]]);
  const reopened = new BridgeStore(file);
  await reopened.load();
  assert.deepEqual(
    reopened.list().map((bridge) => bridge.id),
    ['b1'],
  );
});

test('a bridge paired by 1.0.x/1.1.0, forgotten then paired again, keeps its external_ids', async () => {
  // Its lights' ids are built from its old IP (`platformKey`): a fresh entry
  // without it would turn every light into a new device.
  const file = await tempFile();
  const store = new BridgeStore(file);
  await store.load();
  store.bridges.push({ id: 'abc', ip: '192.168.1.20', username: 'old', platformKey: '192.168.1.10' });
  store.bridges.push({ ip: '192.168.1.30', username: 'older' }); // id never learned
  await store.remove([...store.list()]);

  const reopened = new BridgeStore(file);
  await reopened.load();
  await reopened.upsert({ id: 'abc', ip: '192.168.1.50', username: 'new' });
  await reopened.upsert({ id: 'def', ip: '192.168.1.30', username: 'new-2' });
  assert.deepEqual(
    reopened.list().map((bridge) => bridge.platformKey),
    ['192.168.1.10', '192.168.1.30'],
  );
  assert.deepEqual(reopened.forgotten, [], 'each key is given back once');
});

test('forgetting a bridge with an id-based key keeps no key, only its id', async () => {
  const file = await tempFile();
  const store = new BridgeStore(file);
  await store.load();
  await store.upsert({ id: 'b1', ip: '192.168.1.10', username: 'user-1' });
  await store.remove([...store.list()]);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), {
    bridges: [],
    forgotten: [{ id: 'b1', ip: '192.168.1.10' }],
  });
  await store.upsert({ id: 'b1', ip: '192.168.1.10', username: 'user-2' });
  assert.deepEqual(store.list(), [{ id: 'b1', ip: '192.168.1.10', username: 'user-2' }]);
});

test("a bridge with an id paired at a forgotten id-less bridge's address keeps its own key", async () => {
  // Otherwise its lights would move from `B-…` to `10.0.0.1-…`, orphaning its devices.
  const store = new BridgeStore(await tempFile());
  await store.load();
  store.bridges = [
    { ip: '10.0.0.1', username: 'user-a' },
    { id: 'B', ip: '10.0.0.2', username: 'user-b' },
  ];
  await store.remove([...store.list()]);
  await store.upsert({ id: 'B', ip: '10.0.0.1', username: 'user-b2' });
  assert.deepEqual(store.list(), [{ id: 'B', ip: '10.0.0.1', username: 'user-b2' }]);
  assert.deepEqual(store.forgotten, [{ ip: '10.0.0.1', platformKey: '10.0.0.1' }]);
});

test('a bridge replacing another one takes its place, stored or forgotten, and survives a restart', async () => {
  const file = await tempFile();
  const store = new BridgeStore(file);
  await store.load();
  await store.upsert({ id: 'old', ip: '192.168.1.10', username: 'user-1' });
  await store.upsert({ id: 'gone', ip: '192.168.1.20', username: 'user-2' });
  await store.remove([store.list()[1]]);

  await store.replace(store.list()[0], { id: 'pro', ip: '192.168.1.30', username: 'user-1', platformKey: 'old' });
  await store.replace(store.forgotten[0], { id: 'pro2', ip: '192.168.1.40', username: 'user-3', platformKey: 'gone' });

  const reopened = new BridgeStore(file);
  await reopened.load();
  assert.deepEqual(
    reopened.list().map((bridge) => [bridge.id, bridge.platformKey]),
    [
      ['pro', 'old'],
      ['pro2', 'gone'],
    ],
  );
  assert.deepEqual(reopened.forgotten, []);
});

test('a replaced bridge paired again as a bridge of its own gets a key of its own', async () => {
  // A BSB002 migrated to a Bridge Pro, reset, then paired again: under the key
  // the Pro took, commands to its lights would reach the Pro.
  const store = new BridgeStore(await tempFile());
  await store.load();
  await store.upsert({ id: 'b1', ip: '192.168.1.10', username: 'user-1' });
  await store.replace(store.list()[0], { id: 'pro', ip: '192.168.1.30', username: 'user-1', platformKey: 'b1' });
  await store.upsert({ id: 'b1', ip: '192.168.1.10', username: 'user-2' });
  await store.upsert({ id: 'b1', ip: '192.168.1.11', username: 'user-2' }); // the same bridge, moved

  assert.deepEqual(
    store.list().map((bridge) => [bridge.id, bridge.platformKey]),
    [
      ['pro', 'b1'],
      ['b1', 'b1-2'],
    ],
  );
});

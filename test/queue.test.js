import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequestQueue } from '../src/hue/queue.js';

/**
 * A task that resolves when told to, recording when it started.
 * @param {Array<string>} log - Shared log.
 * @param {string} name - Task name.
 * @returns {{ task: () => Promise<string>, finish: () => void }} Task and its trigger.
 */
function deferred(log, name) {
  let finish;
  const done = new Promise((resolve) => {
    finish = () => resolve(name);
  });
  return {
    task: () => {
      log.push(name);
      return done;
    },
    finish: () => finish(),
  };
}

const settle = () => new Promise(setImmediate);

test('the first request starts at once, the next ones one spacing apart', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const queue = new RequestQueue();
  const log = [];
  const tasks = ['a', 'b', 'c'].map((name) => deferred(log, name));
  tasks.forEach(({ task }) => queue.run(task));
  await settle();
  assert.deepEqual(log, ['a']);
  t.mock.timers.tick(100);
  await settle();
  assert.deepEqual(log, ['a', 'b']);
  t.mock.timers.tick(100);
  await settle();
  assert.deepEqual(log, ['a', 'b', 'c']);
});

test('no more than 3 requests are in flight at once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const queue = new RequestQueue();
  const log = [];
  const tasks = ['a', 'b', 'c', 'd'].map((name) => deferred(log, name));
  const results = tasks.map(({ task }) => queue.run(task));
  for (let step = 0; step < 5; step += 1) {
    t.mock.timers.tick(100);
    await settle();
  }
  assert.deepEqual(log, ['a', 'b', 'c'], 'd waits for a slot');

  tasks[0].finish();
  await results[0];
  await settle();
  assert.deepEqual(log, ['a', 'b', 'c', 'd']);
});

test('a failed request frees its slot and reaches its caller only', async () => {
  const queue = new RequestQueue({ spacingMs: 0 });
  await assert.rejects(
    queue.run(async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(await queue.run(async () => 'ok'), 'ok');
  await settle();
  assert.equal(queue.inFlight, 0);
});

test('a request that waited too long for its turn is dropped, not sent late', async () => {
  const queue = new RequestQueue({ maxInFlight: 1, spacingMs: 0 });
  const log = [];
  const hung = deferred(log, 'hung');
  queue.run(hung.task);
  const late = queue.run(deferred(log, 'late').task, { maxWaitMs: 50 });
  await new Promise((resolve) => setTimeout(resolve, 60)); // the bridge does not answer for a while
  hung.finish();
  await assert.rejects(late, (error) => error.queueTimeout === true);
  assert.deepEqual(log, ['hung']);
});

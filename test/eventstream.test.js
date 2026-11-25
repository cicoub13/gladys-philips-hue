import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventStream, nextReconnectDelay, parseSse } from '../src/hue/eventstream.js';

const settle = () => new Promise(setImmediate);

/**
 * An `open` for EventStream whose connections the test drives.
 * @returns {{ open: Function, connections: Array<{ response: PassThrough, close: Function }>, failures: Error[] }}
 * The fake, its connections, and the errors the next attempts must throw.
 */
function fakeBridge() {
  const fake = { connections: [], failures: [] };
  fake.open = async () => {
    if (fake.failures.length > 0) {
      throw fake.failures.shift();
    }
    const response = new PassThrough();
    const connection = { response, close: () => response.destroy() };
    fake.connections.push(connection);
    return connection;
  };
  return fake;
}

test('parseSse keeps the data of complete events, and the start of the next one', () => {
  const text = ': hi\n\nid: 1:0\ndata: [1]\n\nid: 2:0\r\ndata: [2,\r\ndata: 3]\r\n\r\nid: 3:0\ndata: [4';
  assert.deepEqual(parseSse(text), { messages: ['[1]', '[2,\n3]'], rest: 'id: 3:0\ndata: [4' });
});

test('the reconnection delay doubles up to a minute, with jitter', () => {
  assert.equal(nextReconnectDelay(0, 0), 500);
  assert.equal(nextReconnectDelay(0, 1), 1000);
  assert.equal(nextReconnectDelay(3, 1), 8000);
  assert.equal(nextReconnectDelay(20, 1), 60000);
});

test('each message is parsed and handed over, even split across chunks', async () => {
  const fake = fakeBridge();
  const received = [];
  let opened = 0;
  const stream = new EventStream({
    name: 'test',
    open: fake.open,
    onEvents: (events) => received.push(events),
    onOpen: () => {
      opened += 1;
    },
  });
  stream.start();
  await settle();
  const { response } = fake.connections[0];
  response.write(': hi\n\nid: 1:0\ndata: [{"type":"upd');
  response.write('ate","data":[]}]\n\ndata: not json\n\n');
  await settle();
  assert.deepEqual(received, [[{ type: 'update', data: [] }]]);
  assert.equal(opened, 1);
  stream.stop();
});

test('a dropped stream is opened again, later each time it fails', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeBridge();
  const stream = new EventStream({ name: 'test', open: fake.open, onEvents: () => {} });
  stream.start();
  await settle();
  fake.failures.push(new Error('connect EHOSTUNREACH'));
  fake.connections[0].response.destroy(); // the bridge rebooted
  await settle();

  t.mock.timers.tick(1000); // first retry: fails
  await settle();
  assert.equal(fake.connections.length, 1);
  t.mock.timers.tick(2000); // second retry: succeeds
  await settle();
  assert.equal(fake.connections.length, 2);
  stream.stop();
});

test('a stream the bridge closes right after opening it is reopened later each time', async (t) => {
  // Only a connection that lasted starts the backoff over: each reopening
  // costs three requests and a read of every light.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeBridge();
  const stream = new EventStream({ name: 'test', open: fake.open, onEvents: () => {} });
  stream.start();
  for (const delay of [1000, 2000, 4000]) {
    await settle();
    fake.connections.at(-1).response.destroy();
    await settle();
    t.mock.timers.tick(delay);
  }
  await settle();
  assert.equal(fake.connections.length, 4);
  assert.equal(stream.attempts, 3);
  stream.stop();
});

test('a bridge without event stream is given up on, once', async () => {
  const fake = fakeBridge();
  fake.failures.push(Object.assign(new Error('no v2 API'), { permanent: true }));
  const givenUp = [];
  const stream = new EventStream({
    name: 'test',
    open: fake.open,
    onEvents: () => {},
    onGiveUp: (e) => givenUp.push(e),
  });
  stream.start();
  await settle();
  assert.equal(givenUp.length, 1);
  assert.equal(stream.timer, undefined, 'no retry');
});

test('stop() closes the stream for good', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeBridge();
  const stream = new EventStream({ name: 'test', open: fake.open, onEvents: () => {} });
  stream.start();
  await settle();
  stream.stop();
  await settle();
  assert.equal(fake.connections[0].response.destroyed, true);
  t.mock.timers.tick(60000);
  await settle();
  assert.equal(fake.connections.length, 1);
});

test('reconnect() drops a stream that may be dead, and opens a new one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeBridge();
  const stream = new EventStream({ name: 'test', open: fake.open, onEvents: () => {} });
  stream.start();
  await settle();
  stream.reconnect();
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(fake.connections.length, 2);
  stream.stop();
});

test('an attempt that fails for good after stop() does not give up for the new stream', async () => {
  // The bridge moved: the old stream is stopped while probing its old address.
  let fail;
  const givenUp = [];
  const stream = new EventStream({
    name: 'test',
    open: () =>
      new Promise((resolve, reject) => {
        fail = () => reject(Object.assign(new Error('another bridge answers here'), { permanent: true }));
      }),
    onEvents: () => {},
    onGiveUp: (error) => givenUp.push(error),
  });
  stream.start();
  stream.stop();
  fail();
  await settle();
  assert.deepEqual(givenUp, []);
});

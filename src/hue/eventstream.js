// -----------------------------------------------------------------------------
// The v2 event stream of a bridge (`GET /eventstream/clip/v2`, Server-Sent
// Events), kept open, and opened again with backoff when it drops.
//
// Square bridges (BSB002, firmware 1.48+) and the Bridge Pro push every change
// on it: the Hue app, a dimmer, a Hue automation. Each message is a JSON array
// of `{ type: 'update', data: [resources] }`:
//
//   : hi
//
//   id: 1634576695:0
//   data: [{"type":"update","data":[{"id":"…","id_v1":"/lights/3","on":{"on":true},"type":"light"}]}]
//
// Docs: https://developers.meethue.com/develop/hue-api-v2/migration-guide-to-the-new-hue-api/
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'hue-eventstream' });

// Reconnection: doubles from 1 s up to 1 min, with jitter.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60 * 1000;

// A connection that lasted this long starts the backoff over when it drops: one
// that a peer closes right after opening it must not be reopened every second.
const STABLE_MS = 30 * 1000;

// A message is a few KB; this only guards against a peer that never ends one.
const MAX_PENDING_CHARS = 1024 * 1024;

/**
 * Split Server-Sent Events text into complete messages.
 * @param {string} text - Text received so far.
 * @returns {{ messages: string[], rest: string }} The `data` of each complete event (comments and ids left out),
 * and the beginning of the next one.
 */
export function parseSse(text) {
  const blocks = text.replace(/\r\n?/g, '\n').split('\n\n');
  const rest = blocks.pop();
  const messages = [];
  for (const block of blocks) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''));
    if (data.length > 0) {
      messages.push(data.join('\n'));
    }
  }
  return { messages, rest };
}

/**
 * Delay before the next connection attempt.
 * @param {number} attempt - Attempts already failed in a row.
 * @param {number} [random] - Value in [0, 1], injectable for tests.
 * @returns {number} Delay in milliseconds.
 */
export function nextReconnectDelay(attempt, random = Math.random()) {
  const step = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
  return Math.round(step / 2 + (random * step) / 2);
}

export class EventStream {
  /**
   * @param {object} options - Stream options.
   * @param {string} options.name - Who the stream is from, for the logs.
   * @param {() => Promise<{ response: import('node:stream').Readable, close: () => void }>} options.open - Opens
   * the connection. An error with `permanent` set stops for good.
   * @param {(events: Array<object>) => void} options.onEvents - Receives each message, parsed.
   * @param {() => void} [options.onOpen] - Called on each connection.
   * @param {(error: Error) => void} [options.onGiveUp] - Called when `open` failed for good.
   */
  constructor({ name, open, onEvents, onOpen = () => {}, onGiveUp = () => {} }) {
    this.name = name;
    this.open = open;
    this.onEvents = onEvents;
    this.onOpen = onOpen;
    this.onGiveUp = onGiveUp;
    this.attempts = 0;
    this.stopped = true;
    this.timer = undefined;
    this.close = undefined;
  }

  /**
   * Open the stream, and keep it open until `stop()`.
   */
  start() {
    this.stopped = false;
    this.connect();
  }

  /**
   * Close the stream for good.
   */
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.drop();
  }

  /**
   * Close the current connection, if any, and open a new one after the usual
   * delay: the bridge did not answer elsewhere, this connection may be dead too.
   */
  reconnect() {
    if (this.close) {
      this.drop();
    }
  }

  /**
   * Close the current connection; its `close` event schedules the next one.
   */
  drop() {
    const close = this.close;
    this.close = undefined;
    if (close) {
      close();
    }
  }

  /**
   * One connection attempt.
   * @returns {Promise<void>} Resolves once connected, or the next attempt scheduled.
   */
  async connect() {
    this.timer = undefined;
    let opened;
    try {
      opened = await this.open();
    } catch (error) {
      if (this.stopped) {
        return; // stopped meanwhile (the bridge moved, say): this attempt says nothing any more
      }
      if (error.permanent) {
        logger.info(`No event stream from ${this.name} (${error.message}): its lights are refreshed by polling only`);
        this.stopped = true;
        this.onGiveUp(error);
        return;
      }
      this.retry(error);
      return;
    }
    if (this.stopped) {
      opened.close();
      return;
    }
    this.listen(opened);
    logger.info(`Event stream from ${this.name} open: changes made outside Gladys show up at once`);
    this.onOpen();
  }

  /**
   * Read the messages of an open connection until it closes.
   * @param {{ response: import('node:stream').Readable, close: () => void }} opened - Open connection.
   */
  listen({ response, close }) {
    const openedAt = performance.now();
    let pending = '';
    let closed = false;
    const done = (error) => {
      if (closed) {
        return;
      }
      closed = true;
      if (this.close === close) {
        this.close = undefined;
      }
      if (performance.now() - openedAt >= STABLE_MS) {
        this.attempts = 0;
      }
      this.retry(error || new Error('the bridge closed the stream'));
    };
    this.close = close;
    response.setEncoding('utf8');
    response.on('data', (chunk) => {
      const { messages, rest } = parseSse(pending + chunk);
      pending = rest;
      for (const message of messages) {
        let events;
        try {
          events = JSON.parse(message);
        } catch {
          logger.debug(`Ignoring an event from ${this.name} that is not JSON`);
          continue;
        }
        this.onEvents(events);
      }
      if (pending.length > MAX_PENDING_CHARS) {
        logger.warn(`The event stream from ${this.name} sent an endless message, reconnecting`);
        close();
      }
    });
    response.on('error', done);
    response.on('close', () => done());
  }

  /**
   * Schedule the next attempt, unless stopped.
   * @param {Error} error - Why the last one failed or ended.
   */
  retry(error) {
    if (this.stopped || this.timer) {
      return;
    }
    const delay = nextReconnectDelay(this.attempts);
    this.attempts += 1;
    logger.debug(`Event stream from ${this.name} down (${error.message}), reconnecting in ${delay} ms`);
    this.timer = setTimeout(() => this.connect(), delay);
    // The Gladys WebSocket keeps the process alive; this timer must not.
    this.timer.unref();
  }
}

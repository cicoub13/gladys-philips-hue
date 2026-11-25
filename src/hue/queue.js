// -----------------------------------------------------------------------------
// Request pacing, one queue per bridge.
//
// A Hue bridge handles about 10 requests per second, and only a few at once:
// beyond that it answers 429/503, or drops the request. A Gladys scene turning
// off 15 lights sends 15 commands at the same time, so every request to a
// bridge goes through its queue: at most 3 in flight, and a new one starts at
// most every 100 ms. aiohue (Home Assistant) does the same.
//
// A request that waited too long is dropped instead of sent late: behind a
// bridge that stopped answering, a command Gladys already reported failed would
// otherwise reach the light much later, and undo what the user did since.
// -----------------------------------------------------------------------------

const MAX_IN_FLIGHT = 3;
const SPACING_MS = 100;

export class RequestQueue {
  /**
   * @param {{ maxInFlight?: number, spacingMs?: number }} [options] - Limits (defaults: 3 at once, one start
   * per 100 ms).
   */
  constructor({ maxInFlight = MAX_IN_FLIGHT, spacingMs = SPACING_MS } = {}) {
    this.maxInFlight = maxInFlight;
    this.spacingMs = spacingMs;
    this.waiting = [];
    this.inFlight = 0;
    // Set for `spacingMs` after each start.
    this.cooling = false;
  }

  /**
   * Run a task once the bridge has room for it.
   * @param {() => Promise<any>} task - The request.
   * @param {{ maxWaitMs?: number }} [options] - How long it may wait for its turn (no limit by default).
   * @returns {Promise<any>} The task's result; an error with `queueTimeout` set when it waited too long.
   */
  run(task, { maxWaitMs = Infinity } = {}) {
    return new Promise((resolve, reject) => {
      const job = { task, resolve, reject };
      if (Number.isFinite(maxWaitMs)) {
        // Rejected on time, even while every slot is held by a request that hangs.
        job.expiry = setTimeout(
          () => {
            this.waiting = this.waiting.filter((waiting) => waiting !== job);
            const error = new Error(`dropped after waiting ${Math.round(maxWaitMs)} ms for the bridge`);
            error.queueTimeout = true;
            reject(error);
          },
          Math.max(0, maxWaitMs),
        );
        job.expiry.unref();
      }
      this.waiting.push(job);
      this.pump();
    });
  }

  /**
   * Start the next waiting task, if the limits allow it.
   */
  pump() {
    if (this.waiting.length === 0 || this.inFlight >= this.maxInFlight || this.cooling) {
      return;
    }
    const job = this.waiting.shift();
    clearTimeout(job.expiry);
    const { task, resolve, reject } = job;
    this.inFlight += 1;
    this.cooling = true;
    setTimeout(() => {
      this.cooling = false;
      this.pump();
    }, this.spacingMs);
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        this.inFlight -= 1;
        this.pump();
      });
  }
}

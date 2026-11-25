// -----------------------------------------------------------------------------
// Request pacing, one queue per bridge.
//
// A Hue bridge handles about 10 requests per second, and only a few at once:
// beyond that it answers 429/503, or drops the request. A Gladys scene turning
// off 15 lights sends 15 commands at the same time, so every request to a
// bridge goes through its queue: at most 3 in flight, and a new one starts at
// most every 100 ms. aiohue (Home Assistant) does the same.
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
   * @returns {Promise<any>} The task's result.
   */
  run(task) {
    return new Promise((resolve, reject) => {
      this.waiting.push({ task, resolve, reject });
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
    const { task, resolve, reject } = this.waiting.shift();
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

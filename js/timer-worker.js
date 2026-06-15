/**
 * @file timer-worker.js
 * @description Web Worker that acts as an isolated metronome heartbeat.
 *
 * Runs off the main thread to avoid UI jank and browser timer throttling.
 * Posts a "tick" message every 25ms, which the main thread uses to drive
 * the Web Audio scheduler and data recording loop.
 *
 * Communication protocol:
 *   Incoming: "start" → begins the interval
 *             "stop"  → clears the interval
 *   Outgoing: "tick"  → emitted on every interval fire
 */

/** @type {number|null} The active setInterval handle, or null when stopped. */
let timerID = null;

/**
 * Interval in milliseconds between heartbeat ticks.
 * 25ms gives ~40 ticks/second — smooth enough for the Web Audio lookahead
 * scheduler while keeping CPU overhead negligible.
 */
const TICK_INTERVAL_MS = 25;

self.onmessage = function (e) {
  if (e.data === "start") {
    // Guard: clear any pre-existing interval before starting a new one
    // to prevent duplicate tick sources if "start" is sent twice.
    if (timerID !== null) {
      clearInterval(timerID);
    }
    timerID = setInterval(() => postMessage("tick"), TICK_INTERVAL_MS);

  } else if (e.data === "stop") {
    clearInterval(timerID);
    timerID = null;
  }
};
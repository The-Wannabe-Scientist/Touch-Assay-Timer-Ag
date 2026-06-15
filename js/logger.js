/**
 * @file logger.js
 * @module Logger
 * @description Intercepts console output and uncaught errors, persisting them
 * to IndexedDB so that crash data survives page reloads.
 *
 * Usage: call initLogger() as early as possible (top of main.js DOMContentLoaded).
 * Logs can be downloaded via downloadLogs() or erased via clearLogs().
 *
 * Log levels: INFO, WARN, ERROR, FATAL
 *
 * FATAL is used for uncaught errors and unhandled Promise rejections that
 * would not otherwise appear in a console.error call.
 */

import { saveLog, getAllLogs, clearAllLogs } from "./db.js";


/* ==========================================================================
   Internal State
   ========================================================================== */

/**
 * Cached references to the original console methods.
 * Stored before overriding so that the logger itself can write to the real
 * console without triggering recursive log → IDB → log loops.
 */
const originalConsole = {
  log:   console.log,
  warn:  console.warn,
  error: console.error
};


/* ==========================================================================
   Internal Helpers
   ========================================================================== */

/**
 * Converts an arbitrary list of console arguments into a single string.
 *
 * Handles the common cases:
 *   - Error objects:  formatted as "ErrorName: message\nstack trace"
 *   - Plain objects:  JSON-serialised (with a fallback for circular refs)
 *   - Primitives:     coerced to string via String()
 *
 * @param {any[]} args - The spread arguments passed to console.log/warn/error.
 * @returns {string} A single human-readable string of all arguments joined by spaces.
 */
function formatMessage(args) {
  return args.map(arg => {
    if (arg instanceof Error) {
      return `${arg.name}: ${arg.message}\n${arg.stack}`;
    }
    if (typeof arg === "object" && arg !== null) {
      try {
        return JSON.stringify(arg);
      } catch {
        return "[Unserializable Object]";
      }
    }
    return String(arg);
  }).join(" ");
}

/**
 * Constructs a log entry and persists it to IndexedDB asynchronously.
 * Failures here are swallowed (logging to the original console) to avoid
 * an infinite error loop if the DB itself is broken.
 *
 * @param {"INFO"|"WARN"|"ERROR"|"FATAL"} level - Severity level.
 * @param {any[]}                         args  - Raw console arguments.
 */
function logToDB(level, args) {
  const entry = {
    timestamp: Date.now(),
    level,
    message: formatMessage(args),
    url:     window.location.href
  };

  saveLog(entry).catch(err =>
    originalConsole.error("Logger failed to save entry to DB:", err)
  );
}


/* ==========================================================================
   Public API
   ========================================================================== */

/**
 * Installs the persistent logger by overriding console.log/warn/error and
 * registering global error event listeners.
 *
 * Should be called once, as early as possible in the application lifecycle,
 * so that startup errors are captured.
 */
export function initLogger() {
  // Override the three main console methods to also persist to IDB
  console.log   = (...args) => { originalConsole.log(...args);   logToDB("INFO",  args); };
  console.warn  = (...args) => { originalConsole.warn(...args);  logToDB("WARN",  args); };
  console.error = (...args) => { originalConsole.error(...args); logToDB("ERROR", args); };

  // Capture synchronous uncaught errors (e.g. ReferenceError, TypeError)
  window.addEventListener("error", event => {
    logToDB("FATAL", [
      `Uncaught Error: ${event.message} at ${event.filename}:${event.lineno}`
    ]);
  });

  // Capture asynchronous uncaught Promise rejections (e.g. failed await calls)
  window.addEventListener("unhandledrejection", event => {
    logToDB("FATAL", [`Unhandled Promise Rejection: ${event.reason}`]);
  });

  console.log("Persistent logger initialised.");
}

/**
 * Fetches all stored log entries from IndexedDB and downloads them as a
 * plain-text file. The file is named with the current Unix timestamp to
 * avoid overwriting previous downloads.
 *
 * If no logs exist, shows a brief alert and returns without creating a file.
 */
export async function downloadLogs() {
  const logs = await getAllLogs();

  if (logs.length === 0) {
    alert("No logs recorded yet.");
    return;
  }

  // Build human-readable log text
  let logText = "Touch Assay Timer — System Logs\n";
  logText     += "================================\n\n";

  logs.forEach(log => {
    const timeString = new Date(log.timestamp).toISOString();
    logText += `[${timeString}] [${log.level}]\n${log.message}\n\n`;
  });

  // Trigger browser file download
  const blob = new Blob([logText], { type: "text/plain" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");

  a.href     = url;
  a.download = `touch_assay_logs_${Date.now()}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Permanently erases all persisted log entries from IndexedDB.
 * This action is irreversible — the UI should confirm with the user first.
 */
export async function clearLogs() {
  await clearAllLogs();
  console.log("System logs cleared by user.");
}
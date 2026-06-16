/**
 * @file db.js
 * @module Database
 * @description IndexedDB persistence layer for the Touch Assay Timer.
 *
 * Object store layout:
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ Store     │ Key        │ Indexes              │ Contains         │
 * ├──────────────────────────────────────────────────────────────────┤
 * │ assays    │ assayId    │ —                    │ Assay config     │
 * │ trials    │ trialId    │ assayId, status       │ Trial metadata   │
 * │ runs      │ runId      │ trialId, genotype    │ Run data+values  │
 * │ logs      │ id (auto)  │ —                    │ Diagnostic logs  │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * Connection caching:
 *   A single IDBDatabase connection is cached in `cachedDB` and reused
 *   across all operations. This eliminates per-operation connection overhead
 *   (important during the high-frequency scheduler loop).
 *   The cache is cleared automatically if the browser closes the connection.
 *
 * Transaction strategy:
 *   Each exported function opens its own transaction(s) and awaits completion.
 *   Multi-step operations (e.g. deleteAssay) use sequential independent
 *   transactions rather than one combined multi-store transaction to avoid
 *   IDB auto-commit races when awaiting between operations.
 */


/* ==========================================================================
   Configuration
   ========================================================================== */

const DB_NAME    = "touch-assay-db";
const DB_VERSION = 3;  // Increment this when changing the schema

/** @enum {string} Object store name constants — used everywhere to avoid typos. */
const STORES = {
  ASSAYS: "assays",
  TRIALS: "trials",
  RUNS:   "runs",
  LOGS:   "logs"
};


/* ==========================================================================
   Connection Management
   ========================================================================== */

/**
 * Cached IDBDatabase connection.
 * Null when no connection exists yet, or after the browser closes it.
 * @type {IDBDatabase|null}
 */
let cachedDB = null;

/**
 * Opens (or returns the cached) IndexedDB connection.
 *
 * The onupgradeneeded handler runs only when the DB does not exist yet or
 * when DB_VERSION is incremented. It is responsible for creating all stores
 * and indexes.
 *
 * @returns {Promise<IDBDatabase>} Resolves with the open database connection.
 */
export function openDB() {
  // Return the cached connection immediately if available
  if (cachedDB) return Promise.resolve(cachedDB);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    // Schema setup — runs only on first launch or version upgrade
    req.onupgradeneeded = event => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(STORES.ASSAYS)) {
        db.createObjectStore(STORES.ASSAYS, { keyPath: "assayId" });
      }

      if (!db.objectStoreNames.contains(STORES.TRIALS)) {
        const trialStore = db.createObjectStore(STORES.TRIALS, { keyPath: "trialId" });
        // Index by assayId to efficiently fetch all trials for a given assay
        trialStore.createIndex("assayId", "assayId", { unique: false });
        // Index by status to efficiently find all active trials on startup
        trialStore.createIndex("status",  "status",  { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.RUNS)) {
        const runStore = db.createObjectStore(STORES.RUNS, { keyPath: "runId" });
        // Index by trialId to fetch all runs for a given trial
        runStore.createIndex("trialId",  "trialId",  { unique: false });
        runStore.createIndex("genotype", "genotype", { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.LOGS)) {
        // autoIncrement so log entries always get a unique key without us managing IDs
        db.createObjectStore(STORES.LOGS, { keyPath: "id", autoIncrement: true });
      }
    };

    req.onsuccess = () => {
      cachedDB = req.result;
      // Invalidate the cache when the browser closes the connection
      // (e.g. on storage pressure) so the next call re-opens it
      cachedDB.onclose = () => { cachedDB = null; };
      resolve(cachedDB);
    };

    req.onerror = () => reject(req.error);
  });
}


/* ==========================================================================
   Assay Operations
   ========================================================================== */

/**
 * Persists (creates or updates) an assay record.
 * Uses put() so it is safe to call for both initial saves and updates.
 *
 * @param {Object} assay - A fully formed assay object (must have assayId).
 * @returns {Promise<void>} Resolves when the transaction commits.
 */
export async function saveAssay(assay) {
  const db = await openDB();
  const tx = db.transaction(STORES.ASSAYS, "readwrite");
  tx.objectStore(STORES.ASSAYS).put(assay);
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror    = reject;
  });
}

/**
 * Fetches all assay records from the store (shallow — no trials or runs).
 * Used to populate the Saved Assays list view.
 *
 * @returns {Promise<Object[]>} Array of assay objects (may be empty).
 */
export async function loadAllAssays() {
  const db  = await openDB();
  const tx  = db.transaction(STORES.ASSAYS, "readonly");
  const req = tx.objectStore(STORES.ASSAYS).getAll();
  return new Promise(resolve => {
    req.onsuccess = () => resolve(req.result || []);
  });
}

/**
 * Fully re-hydrates an assay from the database, including all its trials
 * and each trial's runs. The returned object mirrors the in-memory structure
 * used by the application.
 *
 * This is the canonical way to reload an assay after DB writes that were
 * performed without a full object reference (e.g. markTrialCompleted).
 *
 * @param {string} assayId - The ID of the assay to load.
 * @returns {Promise<Object>} The fully populated assay object.
 * @throws {Error} If the assay ID is not found in the database.
 */
export async function hydrateAssay(assayId) {
  const db = await openDB();

  // Step 1: Load the top-level assay record
  let trueAssayId = assayId;
  let assay = await new Promise((resolve, reject) => {
    const tx  = db.transaction(STORES.ASSAYS, "readonly");
    const req = tx.objectStore(STORES.ASSAYS).get(assayId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  });

  // Older numeric IDs from DB get cast to strings via DOM dataset properties
  if (!assay && !isNaN(Number(assayId)) && String(Number(assayId)) === String(assayId)) {
    const numId = Number(assayId);
    assay = await new Promise((resolve, reject) => {
      const tx  = db.transaction(STORES.ASSAYS, "readonly");
      const req = tx.objectStore(STORES.ASSAYS).get(numId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = () => reject(req.error);
    });
    if (assay) trueAssayId = numId;
  }

  if (!assay) throw new Error(`Assay not found in DB: ${assayId}`);

  // Step 2: Load all trials belonging to this assay
  const trials = await new Promise((resolve, reject) => {
    const tx  = db.transaction(STORES.TRIALS, "readonly");
    const req = tx.objectStore(STORES.TRIALS).index("assayId").getAll(trueAssayId);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });

  // Step 3: Load all runs for each trial
  for (const trial of trials) {
    trial.runs = await new Promise((resolve, reject) => {
      const tx  = db.transaction(STORES.RUNS, "readonly");
      const req = tx.objectStore(STORES.RUNS).index("trialId").getAll(trial.trialId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error);
    });
  }

  assay.trials = trials;
  return assay;
}

/**
 * Permanently deletes an assay and all its associated trials and runs.
 *
 * Uses a two-phase strategy to avoid IDB transaction conflicts:
 *
 * Phase 1 (Read): Two sequential readonly transactions collect the IDs of
 *   every trial and run that belongs to this assay. Readonly transactions
 *   can never conflict with each other or with writes on other connections.
 *
 * Phase 2 (Write): One single atomic readwrite transaction issues ALL delete
 *   requests synchronously (no await points inside). This means the
 *   transaction can never auto-commit before all requests are queued, and
 *   concurrent calls can never interleave their write phases.
 *
 * Deletion order within Phase 2: runs → trials → assay (children first).
 *
 * @param {string} assayId - The ID of the assay to delete.
 * @returns {Promise<void>} Resolves when all records have been deleted.
 */
export async function deleteAssay(assayId) {
  const db = await openDB();

  // ── Phase 0: Resolve true ID type (string vs number) ────────────────────
  // Older versions may have used purely numeric IDs (like Date.now()).
  // DOM dataset attributes always cast these to strings, so we must
  // check if a numeric version exists in the DB if the string fails.
  let trueAssayId = assayId;
  const assayExists = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.ASSAYS, "readonly");
    const req = tx.objectStore(STORES.ASSAYS).get(assayId);
    req.onsuccess = () => resolve(!!req.result);
    req.onerror   = () => reject(req.error);
  });

  if (!assayExists && !isNaN(Number(assayId)) && String(Number(assayId)) === String(assayId)) {
    const numId = Number(assayId);
    const numAssayExists = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.ASSAYS, "readonly");
      const req = tx.objectStore(STORES.ASSAYS).get(numId);
      req.onsuccess = () => resolve(!!req.result);
      req.onerror   = () => reject(req.error);
    });
    if (numAssayExists) {
      trueAssayId = numId;
    } else {
      // If neither exists, there's nothing to delete.
      return;
    }
  } else if (!assayExists) {
    // Doesn't exist, nothing to do
    return;
  }

  // ── Phase 1a: Collect all trial records for this assay ──────────────────
  const trials = await new Promise((resolve, reject) => {
    const tx  = db.transaction(STORES.TRIALS, "readonly");
    const req = tx.objectStore(STORES.TRIALS).index("assayId").getAll(trueAssayId);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });

  // ── Phase 1b: Collect all run IDs for every trial ───────────────────────
  // Each trial gets its own readonly transaction (safe — reads never conflict).
  const allRunIds = [];
  for (const trial of trials) {
    const runIds = await new Promise((resolve, reject) => {
      const tx  = db.transaction(STORES.RUNS, "readonly");
      const req = tx.objectStore(STORES.RUNS).index("trialId").getAll(trial.trialId);
      req.onsuccess = () => resolve((req.result || []).map(r => r.runId));
      req.onerror   = () => reject(req.error);
    });
    allRunIds.push(...runIds);
  }

  // ── Phase 2: Delete everything in one atomic transaction ─────────────────
  // All requests are queued synchronously — no await inside this Promise so
  // the transaction cannot auto-commit before every delete is registered.
  await new Promise((resolve, reject) => {
    const tx = db.transaction(
      [STORES.RUNS, STORES.TRIALS, STORES.ASSAYS],
      "readwrite"
    );
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
    tx.onabort    = () => reject(tx.error ?? new Error("deleteAssay: transaction aborted"));

    const runStore   = tx.objectStore(STORES.RUNS);
    const trialStore = tx.objectStore(STORES.TRIALS);
    const assayStore = tx.objectStore(STORES.ASSAYS);

    // Queue all deletes synchronously (children before parent)
    allRunIds.forEach(id => runStore.delete(id));
    trials.forEach(t   => trialStore.delete(t.trialId));
    assayStore.delete(trueAssayId);
  });
}


/* ==========================================================================
   Trial Operations
   ========================================================================== */

/**
 * Persists (creates or updates) a trial record.
 * Spreads the assayId into the stored object so the "assayId" index works.
 *
 * Note: The in-memory trial object's `runs` array is NOT stored here —
 * runs have their own store and are written via saveRun().
 *
 * @param {string} assayId - Parent assay ID (stored as a field for indexing).
 * @param {Object} trial   - The trial object to persist.
 * @returns {Promise<void>} Resolves when the transaction commits.
 */
export async function saveTrial(assayId, trial) {
  const db = await openDB();
  const tx = db.transaction(STORES.TRIALS, "readwrite");
  // Spread assayId in so the index can look up trials by parent assay
  tx.objectStore(STORES.TRIALS).put({ ...trial, assayId });
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror    = reject;
  });
}

/**
 * Marks a trial as completed and records the end timestamp.
 * Performs a read-modify-write within a single transaction for atomicity.
 *
 * @param {string} _assayId - Unused — kept for API consistency.
 * @param {string} trialId  - The ID of the trial to complete.
 * @returns {Promise<void>} Resolves when the transaction commits.
 */
export async function markTrialCompleted(_assayId, trialId) {
  const db    = await openDB();
  const tx    = db.transaction(STORES.TRIALS, "readwrite");
  const store = tx.objectStore(STORES.TRIALS);
  const req   = store.get(trialId);

  req.onsuccess = () => {
    const trial = req.result;
    if (!trial) return;
    trial.status  = "completed";
    trial.endedAt = Date.now();
    store.put(trial);
  };

  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror    = reject;
  });
}

/**
 * Marks a trial as abandoned with an explanatory reason and records the end timestamp.
 * Performs a read-modify-write within a single transaction for atomicity.
 *
 * @param {string} _assayId - Unused — kept for API consistency.
 * @param {string} trialId  - The ID of the trial to abandon.
 * @param {string} [reason="App closed or reloaded"] - Human-readable explanation.
 * @returns {Promise<void>} Resolves when the transaction commits.
 */
export async function markTrialAbandoned(_assayId, trialId, reason = "App closed or reloaded") {
  const db    = await openDB();
  const tx    = db.transaction(STORES.TRIALS, "readwrite");
  const store = tx.objectStore(STORES.TRIALS);
  const req   = store.get(trialId);

  req.onsuccess = () => {
    const trial = req.result;
    if (!trial) return;
    trial.status          = "abandoned";
    trial.abandonedReason = reason;
    trial.endedAt         = Date.now();
    store.put(trial);
  };

  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror    = reject;
  });
}


/* ==========================================================================
   Run Operations
   ========================================================================== */

/**
 * Persists (creates or updates) a run record.
 * Spreads the trialId into the stored object so the "trialId" index works.
 *
 * Called both during a run (batch saves) and at completion/abandonment.
 *
 * @param {string} _assayId - Unused — kept for API consistency.
 * @param {string} trialId  - Parent trial ID (stored as a field for indexing).
 * @param {Object} run      - The run object to persist (including its values array).
 * @returns {Promise<void>} Resolves when the transaction commits.
 */
export async function saveRun(_assayId, trialId, run) {
  const db = await openDB();
  const tx = db.transaction(STORES.RUNS, "readwrite");
  // Spread trialId in so the index can look up runs by parent trial
  tx.objectStore(STORES.RUNS).put({ ...run, trialId });
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror    = reject;
  });
}


/* ==========================================================================
   Startup Cleanup
   ========================================================================== */

/**
 * On app restart, finds any trials and runs left in "active" state from
 * a previous session (crash, force-close, etc.) and marks them as abandoned.
 *
 * Uses a three-phase read → read → write pattern:
 *   Phase 1: Fetch all active trials via the "status" index.
 *   Phase 2: For each trial, fetch all runs and find those still active.
 *   Phase 3: Write all updates in a single atomic transaction.
 *
 * Called once during DOMContentLoaded initialisation.
 *
 * @returns {Promise<void>} Resolves when cleanup is complete (or a no-op if nothing active).
 */
export async function abandonAllActiveTrialsInDB() {
  const db = await openDB();

  // Phase 1: Find all active trials
  const activeTrials = await new Promise((resolve, reject) => {
    const tx  = db.transaction(STORES.TRIALS, "readonly");
    const req = tx.objectStore(STORES.TRIALS).index("status").getAll("active");
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });

  // Nothing to clean up — exit early
  if (activeTrials.length === 0) return;

  // Phase 2: Collect any active runs across all orphaned trials
  const runUpdates = [];
  for (const trial of activeTrials) {
    const runs = await new Promise((resolve, reject) => {
      const tx  = db.transaction(STORES.RUNS, "readonly");
      const req = tx.objectStore(STORES.RUNS).index("trialId").getAll(trial.trialId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error);
    });

    // Mutate the in-memory objects that will be written in Phase 3
    runs
      .filter(r => r.status === "active")
      .forEach(run => {
        run.status               = "abandoned";
        run.endedAt              = Date.now();
        run.eligibleForAnalysis  = false;
        run.ineligibleReason     = "App closed unexpectedly";
        runUpdates.push(run);
      });
  }

  // Phase 3: Commit all trial and run updates atomically
  const tx = db.transaction([STORES.TRIALS, STORES.RUNS], "readwrite");

  activeTrials.forEach(trial => {
    trial.status          = "abandoned";
    trial.abandonedReason = "App closed unexpectedly";
    trial.endedAt         = Date.now();
    tx.objectStore(STORES.TRIALS).put(trial);
  });

  runUpdates.forEach(run => tx.objectStore(STORES.RUNS).put(run));

  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror    = reject;
  });
}


/* ==========================================================================
   Log Operations
   ========================================================================== */

/**
 * Appends a log entry to the LOGS store.
 *
 * Uses add() (not put()) so the autoIncrement key is always generated fresh.
 * Any pre-existing `id` field on the entry object is stripped first to
 * prevent it being used as the key (which would overwrite an existing record).
 *
 * @param {Object}                   entry           - The log data to persist.
 * @param {number}                   entry.timestamp - Unix timestamp.
 * @param {"INFO"|"WARN"|"ERROR"|"FATAL"} entry.level - Severity level.
 * @param {string}                   entry.message   - Formatted log message.
 * @param {string}                   entry.url       - Page URL at time of log.
 * @returns {Promise<void>} Resolves when the transaction commits.
 */
export async function saveLog(entry) {
  const db = await openDB();
  const tx = db.transaction(STORES.LOGS, "readwrite");

  // Strip any existing 'id' so add() always generates a fresh autoIncrement key
  const { id: _ignored, ...entryWithoutId } = entry;
  tx.objectStore(STORES.LOGS).add(entryWithoutId);

  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror    = reject;
  });
}

/**
 * Returns all stored log entries, ordered by their autoIncrement key
 * (i.e. insertion order, oldest first).
 *
 * @returns {Promise<Object[]>} Array of log entry objects.
 */
export async function getAllLogs() {
  const db  = await openDB();
  const tx  = db.transaction(STORES.LOGS, "readonly");
  const req = tx.objectStore(STORES.LOGS).getAll();
  return new Promise(resolve => {
    req.onsuccess = () => resolve(req.result || []);
  });
}

/**
 * Removes all entries from the LOGS store.
 * Called from the Settings screen after user confirmation.
 *
 * @returns {Promise<void>} Resolves when the transaction commits.
 */
export async function clearAllLogs() {
  const db = await openDB();
  const tx = db.transaction(STORES.LOGS, "readwrite");
  tx.objectStore(STORES.LOGS).clear();
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror    = reject;
  });
}

/**
 * Returns the total number of log entries currently stored.
 * Uses a count() cursor which is faster than getAll() for large stores.
 *
 * @returns {Promise<number>}
 */
export async function getLogCount() {
  const db  = await openDB();
  const tx  = db.transaction(STORES.LOGS, "readonly");
  const req = tx.objectStore(STORES.LOGS).count();
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Deletes the oldest log entries so that at most `keepCount` remain.
 * Iterates a cursor (ascending autoIncrement key order) and deletes until
 * the store is within the desired limit.
 *
 * @param {number} keepCount - Maximum number of entries to retain.
 * @returns {Promise<void>}
 */
export async function pruneOldestLogs(keepCount) {
  const db    = await openDB();
  const tx    = db.transaction(STORES.LOGS, "readwrite");
  const store = tx.objectStore(STORES.LOGS);

  const total = await new Promise((resolve, reject) => {
    const req = store.count();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });

  const deleteCount = total - keepCount;
  if (deleteCount <= 0) return; // Nothing to prune

  let deleted = 0;
  const cursorReq = store.openCursor(); // ascending by key → oldest first
  await new Promise((resolve, reject) => {
    cursorReq.onsuccess = e => {
      const cursor = e.target.result;
      if (!cursor || deleted >= deleteCount) { resolve(); return; }
      cursor.delete();
      deleted++;
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });

  // Wait for the overall transaction to commit
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}
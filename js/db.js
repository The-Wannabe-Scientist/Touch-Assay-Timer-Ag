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
 *   Multi-step operations (e.g. deleteAssay) read in sequential independent
 *   transactions, then write in one multi-store transaction whose requests
 *   are all queued without an await in between, so it cannot auto-commit
 *   part way. importAllDataFromJSON does its reads and writes in that one
 *   transaction, so an import is all-or-nothing.
 */


/* ==========================================================================
   Configuration
   ========================================================================== */

const DB_NAME    = "touch-assay-db";
const DB_VERSION = 4;  // Increment this when changing the schema

/** @enum {string} Object store name constants — used everywhere to avoid typos. */
const STORES = {
  ASSAYS: "assays",
  TRIALS: "trials",
  RUNS:   "runs"
};


/* ==========================================================================
   Connection Management
   ========================================================================== */

/**
 * Whether IndexedDB is available in this browser context.
 * Set to false when openDB() fails (e.g. private browsing, storage quota exceeded).
 * @type {boolean}
 */
let idbAvailable = true;

/**
 * Returns whether IndexedDB was successfully opened on startup.
 * @returns {boolean}
 */
export function getIdbAvailable() { return idbAvailable; }

/**
 * Cached IDBDatabase connection.
 * Null when no connection exists yet, or after the browser closes it.
 * @type {IDBDatabase|null}
 */
let cachedDB = null;

/** Whether this page has opened the database before (see dbRecreated). */
let hasOpenedOnce = false;

/**
 * Set when the database had to be created from scratch after this page had
 * already opened it — i.e. the stores were wiped while the app was open.
 * @type {boolean}
 */
let dbRecreated = false;

/**
 * Reports, once, whether the database was wiped and re-created since the
 * last call. Opens the connection first, so a wipe that closed it is noticed
 * now rather than by the next save — which would otherwise silently write
 * into an empty DB, with every record the page had stored before gone.
 *
 * @returns {Promise<boolean>}
 */
export async function consumeDbRecreated() {
  try { await openDB(); } catch { /* unavailable — nothing was re-created */ }
  const r = dbRecreated;
  dbRecreated = false;
  return r;
}

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
  // Return the cached connection immediately if available.
  if (cachedDB) return Promise.resolve(cachedDB);

  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      // indexedDB is missing, or open() threw synchronously (SecurityError
      // when site storage is blocked). req.onerror never runs for these.
      idbAvailable = false;
      reject(err);
      return;
    }

    // Schema setup — runs only on first launch or version upgrade. Each
    // `if (event.oldVersion < N)` block is idempotent and only runs when
    // migrating from an older version, ensuring safe incremental upgrades.
    req.onupgradeneeded = event => {
      // Use req.result/req.transaction (not event.target.result) — event.target
      // is the same IDBOpenDBRequest as req for a handler attached directly to
      // it, and req is already correctly typed, unlike the generic EventTarget
      // that event.target carries.
      const db  = req.result;
      const oldV = event.oldVersion;  // 0 = fresh install

      // A fresh database after this page already had one means the stores
      // were wiped while the app was open (site data cleared, eviction).
      // The caller re-saves what it still holds in memory — see
      // consumeDbRecreated().
      if (oldV === 0 && hasOpenedOnce) dbRecreated = true;

      // ── Version 1–3 stores (create on fresh install or old upgrade) ────
      if (!db.objectStoreNames.contains(STORES.ASSAYS)) {
        db.createObjectStore(STORES.ASSAYS, { keyPath: "assayId" });
      }

      if (!db.objectStoreNames.contains(STORES.TRIALS)) {
        const trialStore = db.createObjectStore(STORES.TRIALS, { keyPath: "trialId" });
        trialStore.createIndex("assayId", "assayId", { unique: false });
        trialStore.createIndex("status",  "status",  { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.RUNS)) {
        const runStore = db.createObjectStore(STORES.RUNS, { keyPath: "runId" });
        runStore.createIndex("trialId",  "trialId",  { unique: false });
        runStore.createIndex("genotype", "genotype", { unique: false });
      }


      // ── Version 4: add "status" index to runs store ──────────────────
      // Enables efficient orphan-run scanning on startup without a full table scan.
      if (oldV < 4 && db.objectStoreNames.contains(STORES.RUNS)) {
        const runStore = req.transaction.objectStore(STORES.RUNS);
        if (!runStore.indexNames.contains("status")) {
          runStore.createIndex("status", "status", { unique: false });
        }
      }
    };

    req.onsuccess = () => {
      cachedDB = req.result;
      hasOpenedOnce = true;
      // Invalidate the cache when the browser closes the connection
      // (e.g. on storage pressure) so the next call re-opens it.
      cachedDB.onclose = () => { cachedDB = null; };
      resolve(cachedDB);
    };

    req.onerror = () => {
      idbAvailable = false;
      reject(req.error);
    };
  });
}

/**
 * The reason to reject with when a write transaction's `error` event fires.
 *
 * That event is a failed request bubbling up, and it fires before the
 * transaction aborts — so `tx.error` is still null at that point. Rejecting
 * with it would hand callers a null reason, which the app's unhandled-
 * rejection filter discards and no catch block can describe.
 *
 * @param {Event}          event - The `error` event received by tx.onerror.
 * @param {IDBTransaction} tx    - The transaction it bubbled to.
 * @param {string}         label - Operation name for the fallback message.
 * @returns {Error|DOMException}
 */
function requestError(event, tx, label) {
  return event?.target?.error ?? tx.error ?? new Error(`${label}: request failed`);
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
    tx.onerror    = e => reject(requestError(e, tx, "saveAssay"));
    // A commit-time failure (e.g. QuotaExceededError) fires only `abort` —
    // see saveRun().
    tx.onabort    = () => reject(tx.error ?? new Error("saveAssay: transaction aborted"));
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
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result || []);
    // Without these handlers the Promise would leak forever on an IDB error,
    // causing the Saved Assays panel to hang with no feedback.
    req.onerror   = () => reject(req.error);
    tx.onerror    = () => reject(tx.error);
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

  // Step 1: Load the top-level assay record.
  // Typed string|number (not just string) — older DB records can have a
  // numeric key (see the fallback branch below), so trueAssayId may be
  // reassigned to a number after the initial string lookup misses.
  /** @type {string|number} */
  let trueAssayId = assayId;
  let assay = await new Promise((resolve, reject) => {
    const tx  = db.transaction(STORES.ASSAYS, "readonly");
    const req = tx.objectStore(STORES.ASSAYS).get(assayId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  });

  // Older numeric IDs from DB get cast to strings via DOM dataset properties.
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

  // Step 2: Load all trials belonging to this assay.
  const trials = await new Promise((resolve, reject) => {
    const tx  = db.transaction(STORES.TRIALS, "readonly");
    const req = tx.objectStore(STORES.TRIALS).index("assayId").getAll(trueAssayId);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });

  // Step 3: Load all runs for each trial.
  for (const trial of trials) {
    const runs = await new Promise((resolve, reject) => {
      const tx  = db.transaction(STORES.RUNS, "readonly");
      const req = tx.objectStore(STORES.RUNS).index("trialId").getAll(trial.trialId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error);
    });
    // Sort in start order — IDB getAll() returns records in primary-key order.
    // runSeq (the run's position in the trial when it started) comes first
    // because it doesn't depend on the wall clock: a backward clock step
    // between a failed attempt and its retry would otherwise swap them, and
    // with them the export's "(retry N)" labels. Older runs have no runSeq
    // and fall back to startedAt.
    trial.runs = runs.sort(
      (a, b) => (a.runSeq ?? -1) - (b.runSeq ?? -1) || (a.startedAt || 0) - (b.startedAt || 0)
    );
  }

  // Sort by trialIndex — the "assayId" index returns records in primary-key
  // (trialId) order, and trialIds are random UUIDs, so without this the trial
  // list comes back shuffled: the Export screen's dataset checkboxes and the
  // resulting workbook's sheet order would read "Trial 2, Trial 3, Trial 1".
  // startedAt breaks ties for any legacy record missing a trialIndex.
  assay.trials = trials.sort(
    (a, b) => (a.trialIndex ?? 0) - (b.trialIndex ?? 0) || (a.startedAt || 0) - (b.startedAt || 0)
  );
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

  // Resolve true ID type (string vs number).
  // Older versions may have used purely numeric IDs (like Date.now()).
  // DOM dataset attributes always cast these to strings, so we must
  // check if a numeric version exists in the DB if the string fails.
  //
  // Note: this fallback block is intentionally duplicated from hydrateAssay()
  // rather than extracted into a shared helper because both functions open their
  // own transactions at different points. A shared async helper would require an
  // extra round-trip to IDB and could open a transaction in a context where
  // auto-commit has already fired in the caller.
  // Typed string|number — see the matching comment in hydrateAssay() above.
  /** @type {string|number} */
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
    // Doesn't exist, nothing to do.
    return;
  }

  // Collect all trial records for this assay.
  const trials = await new Promise((resolve, reject) => {
    const tx  = db.transaction(STORES.TRIALS, "readonly");
    const req = tx.objectStore(STORES.TRIALS).index("assayId").getAll(trueAssayId);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });

  // Collect all run IDs for every trial
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

  // Delete everything in one atomic transaction.
  // All requests are queued synchronously — no await inside this Promise so
  // the transaction cannot auto-commit before every delete is registered.
  await new Promise((resolve, reject) => {
    const tx = db.transaction(
      [STORES.RUNS, STORES.TRIALS, STORES.ASSAYS],
      "readwrite"
    );
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(requestError(e, tx, "deleteAssay"));
    tx.onabort    = () => reject(tx.error ?? new Error("deleteAssay: transaction aborted"));

    const runStore   = tx.objectStore(STORES.RUNS);
    const trialStore = tx.objectStore(STORES.TRIALS);
    const assayStore = tx.objectStore(STORES.ASSAYS);

    // Queue all deletes synchronously (children before parent).
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
  // Exclude the in-memory runs array — runs live in their own store (saveRun).
  // Spreading trial directly would write duplicate run data into the trials record,
  // bloating IDB storage and potentially overwriting in-progress run state.
  const { runs: _runs, ...trialData } = trial;
  tx.objectStore(STORES.TRIALS).put({ ...trialData, assayId });
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(requestError(e, tx, "saveTrial"));
    tx.onabort    = () => reject(tx.error ?? new Error("saveTrial: transaction aborted"));
  });
}

/**
 * Marks a trial as completed and records the end timestamp.
 * Performs a read-modify-write within a single transaction for atomicity.
 *
 * @param {string} _assayId - Not used internally; kept for API consistency with
 *   saveTrial(). Can be removed in a future breaking change once all callers
 *   are updated.
 * @deprecated The `_assayId` parameter is unused. Future callers should omit it.
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
    // If the trial doesn't exist, abort the transaction so the caller
    // receives a rejection instead of a silent no-op (tx.oncomplete would resolve
    // even with no actual write, giving a false sense of success).
    if (!trial) { tx.abort(); return; }
    trial.status  = "completed";
    trial.endedAt = Date.now();
    store.put(trial);
  };

  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(requestError(e, tx, "markTrialCompleted"));
    // tx.error is null after our own tx.abort() above (trial not found) and
    // set when the commit itself failed (e.g. QuotaExceededError).
    tx.onabort    = () => reject(tx.error ?? new Error(`markTrialCompleted: trial ${trialId} not found`));
  });
}

/**
 * Marks a trial as abandoned with an explanatory reason and records the end timestamp.
 * Performs a read-modify-write within a single transaction for atomicity.
 *
 * @param {string} _assayId - Not used internally; kept for API consistency with
 *   saveTrial(). Can be removed in a future breaking change once all callers
 *   are updated.
 * @deprecated The `_assayId` parameter is unused. Future callers should omit it.
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
    // Abort if trial not found (same rationale as markTrialCompleted).
    if (!trial) { tx.abort(); return; }
    trial.status          = "abandoned";
    trial.abandonedReason = reason;
    trial.endedAt         = Date.now();
    store.put(trial);
  };

  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(requestError(e, tx, "markTrialAbandoned"));
    tx.onabort    = () => reject(tx.error ?? new Error(`markTrialAbandoned: trial ${trialId} not found`));
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
 * @param {string} _assayId - Not used internally; the run is keyed by trialId
 *   alone. Kept for API consistency — can be removed in a future breaking change.
 * @deprecated The `_assayId` parameter is unused. Future callers should omit it.
 * @param {string} trialId  - Parent trial ID (stored as a field for indexing).
 * @param {Object} run      - The run object to persist (including its values array).
 * @returns {Promise<void>} Resolves when the transaction commits.
 */
export async function saveRun(_assayId, trialId, run) {
  const db = await openDB();
  const tx = db.transaction(STORES.RUNS, "readwrite");
  // Spread trialId in so the index can look up runs by parent trial.
  tx.objectStore(STORES.RUNS).put({ ...run, trialId });
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(requestError(e, tx, "saveRun"));
    // A failure at commit time (e.g. QuotaExceededError) fires only `abort`,
    // never `error`. Without this the promise would never settle and callers
    // awaiting the save would hang.
    tx.onabort    = () => reject(tx.error ?? new Error("saveRun: transaction aborted"));
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

  // Phase 1: Find all active trials.
  const activeTrials = await new Promise((resolve, reject) => {
    const tx  = db.transaction(STORES.TRIALS, "readonly");
    const req = tx.objectStore(STORES.TRIALS).index("status").getAll("active");
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });

  // Nothing to clean up — exit early.
  if (activeTrials.length === 0) return;

  // Phase 2: Collect any active runs across all orphaned trials.
  const activeRunIds = [];
  for (const trial of activeTrials) {
    const runs = await new Promise((resolve, reject) => {
      const tx  = db.transaction(STORES.RUNS, "readonly");
      const req = tx.objectStore(STORES.RUNS).index("trialId").getAll(trial.trialId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error);
    });
    runs.filter(r => r.status === "active").forEach(r => activeRunIds.push(r.runId));
  }

  // Phase 3: Commit all trial and run updates atomically.
  //
  // Each record is re-read inside this readwrite transaction and only changed
  // if it is STILL active. The copies read in Phases 1–2 can be stale by now:
  // another open tab may have completed the run or finished the trial in
  // between, and writing those copies back would replace its values with an
  // empty "abandoned" record.
  const tx = db.transaction([STORES.TRIALS, STORES.RUNS], "readwrite");
  const trialStore = tx.objectStore(STORES.TRIALS);
  const runStore   = tx.objectStore(STORES.RUNS);

  activeTrials.forEach(({ trialId }) => {
    const req = trialStore.get(trialId);
    req.onsuccess = () => {
      const trial = req.result;
      if (!trial || trial.status !== "active") return;
      trial.status          = "abandoned";
      trial.abandonedReason = "App closed unexpectedly";
      trial.endedAt         = Date.now();
      trialStore.put(trial);
    };
  });

  activeRunIds.forEach(runId => {
    const req = runStore.get(runId);
    req.onsuccess = () => {
      const run = req.result;
      if (!run || run.status !== "active") return;
      run.status               = "abandoned";
      run.endedAt              = Date.now();
      run.eligibleForAnalysis  = false;
      run.ineligibleReason     = "App closed unexpectedly";
      // Snapshot the automatic determination (see main.js completeRunNormally
      // for why) so this run can still be manually overridden later with a
      // record of the original reason preserved.
      run.autoEligibleForAnalysis = false;
      run.autoIneligibleReason    = "App closed unexpectedly";
      runStore.put(run);
    };
  });

  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(requestError(e, tx, "abandonAllActiveTrials"));
    tx.onabort    = () => reject(tx.error ?? new Error("abandonAllActiveTrials: transaction aborted"));
  });
}


/* ==========================================================================
   Orphan Run Cleanup
   ========================================================================== */

/**
 * Scans ALL runs (regardless of their parent trial's status) for any that
 * were left in "active" state from a previous session — e.g. if a run was
 * in-progress inside a trial that was already marked abandoned by
 * abandonAllActiveTrialsInDB(), or if the DB write raced with an app crash.
 *
 * Uses the "status" index on the runs store (added in DB_VERSION 4) for
 * efficiency; falls back to a full table scan on older schema versions.
 *
 * Called once at startup alongside abandonAllActiveTrialsInDB().
 *
 * @returns {Promise<void>}
 */
export async function markOrphanRunsStopped() {
  let db;
  try {
    db = await openDB();
  } catch {
    return;  // IDB unavailable — nothing we can do.
  }

  // Fetch all runs with status "active".
  let activeRuns = [];
  try {
    activeRuns = await new Promise((resolve, reject) => {
      const tx    = db.transaction(STORES.RUNS, "readonly");
      const store = tx.objectStore(STORES.RUNS);
      // Use status index if available (DB_VERSION 4+); fall back to getAll filter.
      if (store.indexNames.contains("status")) {
        const req = store.index("status").getAll("active");
        req.onsuccess = () => resolve(req.result || []);
        req.onerror   = () => reject(req.error);
      } else {
        const req = store.getAll();
        req.onsuccess = () => resolve((req.result || []).filter(r => r.status === "active"));
        req.onerror   = () => reject(req.error);
      }
    });
  } catch (err) {
    console.warn("markOrphanRunsStopped: could not scan runs:", err);
    return;
  }

  if (activeRuns.length === 0) return;

  // Mark each orphan as stoppedEarly in one atomic transaction.
  await new Promise((resolve, reject) => {
    const tx    = db.transaction(STORES.RUNS, "readwrite");
    const store = tx.objectStore(STORES.RUNS);
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(requestError(e, tx, "markOrphanRunsStopped"));
    tx.onabort    = () => reject(tx.error ?? new Error("markOrphanRunsStopped: transaction aborted"));

    // Re-read each run inside this transaction and change it only if it is
    // still active — another tab may have completed it since the scan above
    // (see abandonAllActiveTrialsInDB).
    activeRuns.forEach(({ runId }) => {
      const req = store.get(runId);
      req.onsuccess = () => {
        const run = req.result;
        if (!run || run.status !== "active") return;
        run.status              = "stoppedEarly";
        run.endedAt             = Date.now();
        run.eligibleForAnalysis = false;
        run.ineligibleReason    = "App restarted unexpectedly";
        // Snapshot the automatic determination — see main.js completeRunNormally.
        run.autoEligibleForAnalysis = false;
        run.autoIneligibleReason    = "App restarted unexpectedly";
        store.put(run);
      };
    });
  });
}

/**
 * Crash-guard recovery — called at startup to merge any sessionStorage
 * snapshot written by the beforeunload handler into the IDB run record.
 *
 * When the tab is killed while hidden on mobile, neither `unload` nor a
 * resumed `visibilitychange` fires. The only surviving data is the
 * synchronous sessionStorage write from `beforeunload`. This function reads
 * that snapshot and updates the IDB record if the snapshot has more values
 * than what was last committed (i.e. data recorded after the last flush).
 *
 * Safe to call unconditionally on every startup — exits immediately if no
 * guard exists or if the IDB record already has equal or more data.
 */
export async function recoverCrashGuard() {
  try {
    const raw = sessionStorage.getItem("touchAssayCrashGuard");
    if (!raw) return;
    sessionStorage.removeItem("touchAssayCrashGuard");

    const guard = JSON.parse(raw);
    if (!guard?.assayId || !guard?.trialId || !guard?.runId) return;

    const db = await openDB();

    // The IDB spec auto-commits a readwrite transaction once there are no
    // pending requests. Awaiting a Promise between .get() and .put() can flush the
    // microtask queue, trigger auto-commit, and silently drop the write — especially
    // on Safari. The safe pattern is to queue the .put() synchronously inside
    // onsuccess, ensuring both requests share the same transaction lifetime.
    await new Promise((resolve, reject) => {
      const tx    = db.transaction(STORES.RUNS, "readwrite");
      const store = tx.objectStore(STORES.RUNS);
      tx.oncomplete = resolve;
      tx.onerror    = e => reject(requestError(e, tx, "recoverCrashGuard"));
      tx.onabort    = () => reject(tx.error ?? new Error("recoverCrashGuard: transaction aborted"));

      const req = store.get(guard.runId);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const existing = req.result;
        if (
          existing &&
          existing.status === "active" &&
          Array.isArray(guard.values) &&
          guard.values.length > (existing.values?.length ?? 0)
        ) {
          const recovered = guard.values.length - (existing.values?.length ?? 0);
          existing.values = guard.values;
          store.put(existing);  // Queued synchronously — transaction cannot auto-commit before this.
          console.log(`[CrashGuard] Recovered ${recovered} value(s) for run ${guard.runId}`);
        }
      };
    });
  } catch {
    // sessionStorage or IDB unavailable (e.g. Private Browsing) — silent no-op.
  }
}


/* ==========================================================================
   Full Data Backup / Restore
   ========================================================================== */

/**
 * Dumps every record from all three object stores, verbatim, for a full
 * offline backup. Structurally flat (not nested like hydrateAssay) — trials
 * reference their parent assayId and runs reference their parent trialId,
 * exactly as stored, so importAllDataFromJSON() can restore them as-is.
 *
 * Unlike the Excel/CSV export (which produces derived, one-directional
 * analysis output), this captures the raw data needed to fully restore the
 * app's state — the only real safety net against a browser storage wipe,
 * since all data here is local-only with no server/cloud sync.
 *
 * @returns {Promise<{version:number, exportedAt:number, assays:Object[], trials:Object[], runs:Object[]}>}
 */
export async function exportAllDataAsJSON() {
  const db = await openDB();

  const getAllFrom = (storeName) => new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });

  const [assays, trials, runs] = await Promise.all([
    getAllFrom(STORES.ASSAYS),
    getAllFrom(STORES.TRIALS),
    getAllFrom(STORES.RUNS)
  ]);

  return {
    version:    DB_VERSION,
    exportedAt: Date.now(),
    assays, trials, runs
  };
}

const isKey   = v => (typeof v === "string" && v !== "") || Number.isFinite(v);
const isPlain = v => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Whether an assay record has the shape the app relies on: a string (or,
 * from older databases, numeric) assayId, and — when present — a string name
 * and an array of string genotypes. Used to refuse malformed backups, and by
 * the Saved Assays list to set aside a damaged record that is already stored
 * instead of failing to render the whole list.
 *
 * @param {any} a - A record from the assays store or a backup file.
 * @returns {boolean}
 */
export function isWellFormedAssay(a) {
  return isPlain(a) && isKey(a.assayId) &&
    (a.assayName == null || typeof a.assayName === "string") &&
    (a.genotypes == null || (Array.isArray(a.genotypes) && a.genotypes.every(g => typeof g === "string")));
}

/**
 * The latest time a record says it was changed. Used by the import to decide
 * which copy of a record is newer.
 *
 * @param {Object} r - An assay, trial or run record.
 * @returns {number} Unix ms (0 if the record carries no timestamps).
 */
const recordStamp = r => Math.max(
  Number(r.lastModifiedAt) || 0, Number(r.overrideAt) || 0,
  Number(r.endedAt) || 0, Number(r.startedAt) || 0, Number(r.createdAt) || 0
);

/**
 * Whether the record already on this device should be kept instead of the
 * backup's copy.
 *
 * A completed copy beats any other: it carries the real outcome (a run's
 * values, a trial's completion), while another copy of the same record was
 * left open, or was closed by the startup cleanup ("App closed
 * unexpectedly") — which stamps it with the time of that later startup, so
 * timestamps alone would pick the empty copy. Otherwise the backup must not
 * send a finished record back to "active" (the next startup would abandon
 * it), and the newer copy wins.
 *
 * @param {Object|undefined} existing - The stored record, if any.
 * @param {Object}           incoming - The backup's record.
 * @returns {boolean}
 */
function keepExistingRecord(existing, incoming) {
  if (!existing) return false;
  const done = r => r.status === "completed";
  if (done(existing) !== done(incoming)) return done(existing);
  if (incoming.status === "active" && existing.status && existing.status !== "active") return true;
  return recordStamp(existing) > recordStamp(incoming);
}

/**
 * Restores assays/trials/runs from a backup object produced by
 * exportAllDataAsJSON(). Records not already present are added; a record
 * that already exists is replaced only if the backup's copy is the better
 * one (see keepExistingRecord), so importing an old backup can't revert
 * newer work. Deliberately non-destructive: nothing already in the database that
 * ISN'T in the backup is ever touched or deleted.
 *
 * All-or-nothing: every write happens in one transaction, so a failure part
 * way through (e.g. QuotaExceededError at commit) leaves the database as it
 * was. Trial numbers that end up duplicated within an assay (two devices'
 * "Trial 2") are renumbered in start order, since the Excel export names a
 * sheet after each one.
 *
 * @param {Object} data - A backup object with assays/trials/runs arrays.
 * @returns {Promise<{assays:number, trials:number, runs:number, keptNewer:number}>}
 *   Record counts written per store, and how many records were skipped
 *   because this device's copy was newer.
 * @throws {Error} If `data` doesn't look like a valid backup.
 */
export async function importAllDataFromJSON(data) {
  if (
    !data ||
    !Array.isArray(data.assays) ||
    !Array.isArray(data.trials) ||
    !Array.isArray(data.runs)
  ) {
    throw new Error("This file doesn't look like a valid Touch Assay Timer backup.");
  }

  // Check every record before writing any. A record with a missing key makes
  // put() throw part-way through a store, and an assay whose genotypes or name
  // has the wrong type is stored fine but then breaks every screen that lists
  // assays. Older databases used numeric IDs, so numbers are accepted too.
  const badAssay = data.assays.findIndex(a => !isWellFormedAssay(a));
  const badTrial = data.trials.findIndex(t => !isPlain(t) || !isKey(t.trialId) || !isKey(t.assayId));
  const badRun   = data.runs.findIndex(r =>
    !isPlain(r) || !isKey(r.runId) || !isKey(r.trialId) ||
    (r.values != null && !Array.isArray(r.values))
  );
  if (badAssay !== -1 || badTrial !== -1 || badRun !== -1) {
    const where = badAssay !== -1 ? `assay #${badAssay + 1}`
                : badTrial !== -1 ? `trial #${badTrial + 1}`
                :                   `run #${badRun + 1}`;
    throw new Error(`This backup contains a malformed record (${where}), so nothing was imported.`);
  }

  const db = await openDB();
  const kept = { [STORES.ASSAYS]: 0, [STORES.TRIALS]: 0, [STORES.RUNS]: 0 };

  // ONE readwrite transaction over all three stores. Every request is queued
  // from a request callback of the same transaction, so it cannot auto-commit
  // part way. Settle on `abort` only: it fires for every failure (request
  // error, commit-time quota error, explicit abort()), and an `error` event
  // arrives before tx.error is set.
  await new Promise((resolve, reject) => {
    const tx = db.transaction([STORES.ASSAYS, STORES.TRIALS, STORES.RUNS], "readwrite");
    let cause = null;
    tx.oncomplete = () => resolve();
    tx.onabort    = () => reject(cause ?? tx.error ?? new Error("importAllDataFromJSON: transaction aborted"));
    const fail = err => {
      if (cause) return;
      cause = err;
      try { tx.abort(); } catch { /* already finished */ }
    };

    const batches = [
      [STORES.ASSAYS, "assayId", data.assays],
      [STORES.TRIALS, "trialId", data.trials],
      [STORES.RUNS,   "runId",   data.runs]
    ];
    let pending = batches.reduce((n, [, , records]) => n + records.length, 0);
    if (pending === 0) return;  // nothing queued — the transaction completes empty

    for (const [storeName, keyPath, records] of batches) {
      const store = tx.objectStore(storeName);
      records.forEach((record, i) => {
        const req = store.get(record[keyPath]);
        req.onsuccess = () => {
          try {
            if (keepExistingRecord(req.result, record)) kept[storeName]++;
            else store.put(record);
          } catch (err) {
            // A synchronous put() throw does not abort the transaction by
            // itself — the writes already queued would still commit.
            fail(new Error(`Backup record ${storeName}[${i}] could not be stored (${err.name}). Nothing was imported.`));
            return;
          }
          if (--pending === 0) renumberDuplicateTrials(tx, data.trials);
        };
      });
    }
  });

  const keptNewer = kept[STORES.ASSAYS] + kept[STORES.TRIALS] + kept[STORES.RUNS];
  return {
    assays: data.assays.length - kept[STORES.ASSAYS],
    trials: data.trials.length - kept[STORES.TRIALS],
    runs:   data.runs.length   - kept[STORES.RUNS],
    keptNewer
  };
}

/**
 * Inside the import transaction, after every write is queued: for each assay
 * the backup touched, renumber its trials 1…N in (trialIndex, startedAt)
 * order if two of them now share a trialIndex. Requests run in the order
 * they were issued, so these reads see the import's writes.
 *
 * @param {IDBTransaction} tx     - The import's readwrite transaction.
 * @param {Object[]}       trials - The backup's trial records.
 */
function renumberDuplicateTrials(tx, trials) {
  const store = tx.objectStore(STORES.TRIALS);
  for (const assayId of new Set(trials.map(t => t.assayId))) {
    const req = store.index("assayId").getAll(assayId);
    req.onsuccess = () => {
      const ts = req.result || [];
      if (new Set(ts.map(t => t.trialIndex)).size === ts.length) return;
      ts.sort((a, b) => (a.trialIndex ?? 0) - (b.trialIndex ?? 0) || (a.startedAt || 0) - (b.startedAt || 0));
      ts.forEach((t, i) => {
        if (t.trialIndex === i + 1) return;
        t.trialIndex = i + 1;
        store.put(t);
      });
    };
  }
}

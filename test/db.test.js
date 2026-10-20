// Registers global `indexedDB`/`IDBKeyRange` backed by an in-memory implementation,
// so db.js (written for the browser) works unmodified under `node --test`.
import "fake-indexeddb/auto";

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

import {
  openDB, getIdbAvailable,
  saveAssay, loadAllAssays, hydrateAssay, deleteAssay,
  saveTrial, markTrialCompleted, markTrialAbandoned,
  saveRun, abandonAllActiveTrialsInDB, markOrphanRunsStopped,
  recoverCrashGuard, exportAllDataAsJSON, importAllDataFromJSON, isWellFormedAssay
} from "../js/db.js";

// db.js caches a single IDBDatabase connection at module scope (by design —
// see its header comment), so every test in this file shares one underlying
// fake-indexeddb database rather than getting a fresh one. That mirrors how
// the connection actually behaves in the app (opened once per session), but
// it means tests must not assume they're the only data in the store — each
// test below uses its own unique IDs and only asserts on records it created
// itself, rather than on exact store-wide counts.

let uidCounter = 0;
/** Generates a unique ID scoped to this test file, so parallel tests never collide. */
function uid(prefix) {
  uidCounter += 1;
  return `${prefix}_${Date.now()}_${uidCounter}`;
}

function makeAssay(overrides = {}) {
  return {
    assayId: uid("assay"),
    assayName: "Test Assay",
    createdAt: Date.now(),
    lastModifiedAt: Date.now(),
    isi: 1,
    stimCount: 30,
    binSize: 10,
    temperature: 22,
    humidity: 50,
    genotypes: ["WT"],
    trials: [],
    ...overrides
  };
}

function makeTrial(overrides = {}) {
  return {
    trialId: uid("trial"),
    trialIndex: 1,
    status: "active",
    abandonedReason: null,
    startedAt: Date.now(),
    endedAt: null,
    runs: [],
    ...overrides
  };
}

function makeRun(overrides = {}) {
  return {
    runId: uid("run"),
    genotype: "WT",
    animalIndex: 1,
    expectedStimCount: 30,
    values: [1, 0, 1],
    status: "active",
    eligibleForAnalysis: null,
    ineligibleReason: null,
    startedAt: Date.now(),
    endedAt: null,
    ...overrides
  };
}

describe("openDB", () => {
  test("resolves with a database exposing the expected stores and indexes", async () => {
    const db = await openDB();
    assert.ok(db.objectStoreNames.contains("assays"));
    assert.ok(db.objectStoreNames.contains("trials"));
    assert.ok(db.objectStoreNames.contains("runs"));

    const tx = db.transaction(["trials", "runs"], "readonly");
    assert.ok(tx.objectStore("trials").indexNames.contains("assayId"));
    assert.ok(tx.objectStore("trials").indexNames.contains("status"));
    assert.ok(tx.objectStore("runs").indexNames.contains("trialId"));
    assert.ok(tx.objectStore("runs").indexNames.contains("genotype"));
    assert.ok(tx.objectStore("runs").indexNames.contains("status"));
  });

  test("returns the same cached connection on repeated calls", async () => {
    const a = await openDB();
    const b = await openDB();
    assert.equal(a, b);
  });
});

describe("getIdbAvailable", () => {
  test("is true after a successful openDB()", async () => {
    await openDB();
    assert.equal(getIdbAvailable(), true);
  });
});

describe("saveAssay / loadAllAssays", () => {
  test("a saved assay appears in loadAllAssays()", async () => {
    const assay = makeAssay();
    await saveAssay(assay);
    const all = await loadAllAssays();
    assert.ok(all.some(a => a.assayId === assay.assayId));
  });
});

describe("hydrateAssay", () => {
  test("nests trials and runs, sorting each trial's runs by startedAt", async () => {
    const assay = makeAssay();
    await saveAssay(assay);

    const trial = makeTrial();
    await saveTrial(assay.assayId, trial);

    const runLater  = makeRun({ startedAt: 2000 });
    const runEarlier = makeRun({ startedAt: 1000 });
    // Save out of order — hydrateAssay must sort by startedAt, not insertion order.
    await saveRun(assay.assayId, trial.trialId, runLater);
    await saveRun(assay.assayId, trial.trialId, runEarlier);

    const hydrated = await hydrateAssay(assay.assayId);
    assert.equal(hydrated.assayId, assay.assayId);
    assert.equal(hydrated.trials.length, 1);
    assert.equal(hydrated.trials[0].trialId, trial.trialId);
    assert.deepEqual(
      hydrated.trials[0].runs.map(r => r.runId),
      [runEarlier.runId, runLater.runId]
    );
  });

  test("returns trials sorted by trialIndex, not primary-key (trialId) order", async () => {
    const assay = makeAssay();
    await saveAssay(assay);

    // trialIds chosen so primary-key order ("a" < "b" < "c") is the reverse
    // of trialIndex order — the "assayId" index yields records in key order.
    const prefix = uid("t");
    const trial3 = makeTrial({ trialId: `${prefix}_a`, trialIndex: 3 });
    const trial2 = makeTrial({ trialId: `${prefix}_b`, trialIndex: 2 });
    const trial1 = makeTrial({ trialId: `${prefix}_c`, trialIndex: 1 });
    for (const t of [trial3, trial2, trial1]) await saveTrial(assay.assayId, t);

    const hydrated = await hydrateAssay(assay.assayId);
    assert.deepEqual(hydrated.trials.map(t => t.trialIndex), [1, 2, 3]);
  });

  test("throws when the assay does not exist", async () => {
    await assert.rejects(() => hydrateAssay("does-not-exist"), /not found/i);
  });

  test("falls back to a numeric key when the record was stored with a numeric assayId", async () => {
    // Simulate a legacy record whose key is a number (e.g. Date.now()) rather
    // than a string — DOM dataset attributes always cast IDs to strings, so
    // callers pass a string even when the underlying key is numeric.
    const numericId = Date.now();
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("assays", "readwrite");
      tx.objectStore("assays").put(makeAssay({ assayId: numericId }));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });

    const hydrated = await hydrateAssay(String(numericId));
    assert.equal(hydrated.assayId, numericId);
  });
});

describe("deleteAssay", () => {
  test("cascades to the assay's trials and runs but leaves other assays intact", async () => {
    const target  = makeAssay();
    const sibling = makeAssay();
    await saveAssay(target);
    await saveAssay(sibling);

    const targetTrial  = makeTrial();
    const siblingTrial = makeTrial();
    await saveTrial(target.assayId, targetTrial);
    await saveTrial(sibling.assayId, siblingTrial);

    const targetRun  = makeRun();
    const siblingRun = makeRun();
    await saveRun(target.assayId, targetTrial.trialId, targetRun);
    await saveRun(sibling.assayId, siblingTrial.trialId, siblingRun);

    await deleteAssay(target.assayId);

    const all = await loadAllAssays();
    assert.ok(!all.some(a => a.assayId === target.assayId));
    await assert.rejects(() => hydrateAssay(target.assayId), /not found/i);

    // Verify the trial/run rows themselves are gone, not just the assay record.
    const db = await openDB();
    const trialGone = await new Promise((resolve, reject) => {
      const req = db.transaction("trials", "readonly").objectStore("trials").get(targetTrial.trialId);
      req.onsuccess = () => resolve(req.result === undefined);
      req.onerror   = () => reject(req.error);
    });
    const runGone = await new Promise((resolve, reject) => {
      const req = db.transaction("runs", "readonly").objectStore("runs").get(targetRun.runId);
      req.onsuccess = () => resolve(req.result === undefined);
      req.onerror   = () => reject(req.error);
    });
    assert.ok(trialGone);
    assert.ok(runGone);

    // Sibling assay's data must be untouched.
    const siblingHydrated = await hydrateAssay(sibling.assayId);
    assert.equal(siblingHydrated.trials.length, 1);
    assert.equal(siblingHydrated.trials[0].runs.length, 1);
  });

  test("is a no-op for an assay ID that does not exist", async () => {
    await assert.doesNotReject(() => deleteAssay("does-not-exist"));
  });
});

describe("saveTrial / markTrialCompleted / markTrialAbandoned", () => {
  test("markTrialCompleted sets status and endedAt", async () => {
    const assay = makeAssay();
    await saveAssay(assay);
    const trial = makeTrial();
    await saveTrial(assay.assayId, trial);

    await markTrialCompleted(assay.assayId, trial.trialId);

    const hydrated = await hydrateAssay(assay.assayId);
    assert.equal(hydrated.trials[0].status, "completed");
    assert.ok(hydrated.trials[0].endedAt);
  });

  test("markTrialAbandoned sets status, reason, and endedAt", async () => {
    const assay = makeAssay();
    await saveAssay(assay);
    const trial = makeTrial();
    await saveTrial(assay.assayId, trial);

    await markTrialAbandoned(assay.assayId, trial.trialId, "test reason");

    const hydrated = await hydrateAssay(assay.assayId);
    assert.equal(hydrated.trials[0].status, "abandoned");
    assert.equal(hydrated.trials[0].abandonedReason, "test reason");
    assert.ok(hydrated.trials[0].endedAt);
  });

  test("markTrialCompleted rejects for a trial that does not exist", async () => {
    await assert.rejects(() => markTrialCompleted("any-assay", "does-not-exist"), /not found/i);
  });
});

/**
 * Makes every write transaction on the shared connection abort at commit, for
 * the rest of test `t`.
 *
 * A commit-time failure (e.g. QuotaExceededError) fires `abort` on the
 * transaction with no `error` event: every request has already succeeded.
 * Reproduce that by aborting from inside each put request's success handler.
 */
async function abortWritesAtCommit(t) {
  const db = await openDB();
  const realTransaction = db.transaction;
  // Un-shadow the prototype method afterwards — in a hook, so it also runs
  // if the test times out and the connection isn't left aborting every
  // later test's writes.
  t.after(() => { delete db.transaction; });
  db.transaction = function (...args) {
    const tx = realTransaction.apply(this, args);
    const realObjectStore = tx.objectStore.bind(tx);
    tx.objectStore = name => {
      const store = realObjectStore(name);
      const realPut = store.put.bind(store);
      store.put = (...putArgs) => {
        const request = realPut(...putArgs);
        request.addEventListener("success", () => tx.abort());
        return request;
      };
      return store;
    };
    return tx;
  };
}

// The timeouts matter: without an abort handler these promises never settle,
// and the caller would hang instead of reporting a failure.
describe("writes that abort at commit", () => {
  test("saveRun rejects, rather than never settling", { timeout: 2000 }, async (t) => {
    await abortWritesAtCommit(t);
    await assert.rejects(() => saveRun("any-assay", uid("trial"), makeRun()), /aborted/i);
  });

  test("saveAssay rejects, rather than never settling", { timeout: 2000 }, async (t) => {
    await abortWritesAtCommit(t);
    await assert.rejects(() => saveAssay(makeAssay()), /aborted/i);
  });

  test("saveTrial rejects, rather than never settling", { timeout: 2000 }, async (t) => {
    await abortWritesAtCommit(t);
    await assert.rejects(() => saveTrial(uid("assay"), makeTrial()), /aborted/i);
  });

  test("importAllDataFromJSON rejects, rather than never settling", { timeout: 2000 }, async (t) => {
    await abortWritesAtCommit(t);
    await assert.rejects(
      () => importAllDataFromJSON({ assays: [makeAssay()], trials: [], runs: [] }),
      /aborted/i
    );
  });
});

describe("abandonAllActiveTrialsInDB", () => {
  test("abandons this test's active trial and its active run", async () => {
    const assay = makeAssay();
    await saveAssay(assay);
    const trial = makeTrial({ status: "active" });
    await saveTrial(assay.assayId, trial);
    const run = makeRun({ status: "active" });
    await saveRun(assay.assayId, trial.trialId, run);

    await abandonAllActiveTrialsInDB();

    const hydrated = await hydrateAssay(assay.assayId);
    assert.equal(hydrated.trials[0].status, "abandoned");
    assert.equal(hydrated.trials[0].abandonedReason, "App closed unexpectedly");
    assert.equal(hydrated.trials[0].runs[0].status, "abandoned");
    assert.equal(hydrated.trials[0].runs[0].eligibleForAnalysis, false);
  });
});

describe("markOrphanRunsStopped", () => {
  test("stops an active run regardless of its parent trial's status", async () => {
    const assay = makeAssay();
    await saveAssay(assay);
    // Parent trial already completed — the run being still "active" is the
    // orphan case this function specifically targets.
    const trial = makeTrial({ status: "completed" });
    await saveTrial(assay.assayId, trial);
    const run = makeRun({ status: "active" });
    await saveRun(assay.assayId, trial.trialId, run);

    await markOrphanRunsStopped();

    const hydrated = await hydrateAssay(assay.assayId);
    assert.equal(hydrated.trials[0].runs[0].status, "stoppedEarly");
    assert.equal(hydrated.trials[0].runs[0].eligibleForAnalysis, false);
    assert.equal(hydrated.trials[0].runs[0].ineligibleReason, "App restarted unexpectedly");
  });
});

describe("isWellFormedAssay", () => {
  test("accepts the records the app writes, including legacy numeric IDs", () => {
    assert.equal(isWellFormedAssay(makeAssay()), true);
    assert.equal(isWellFormedAssay(makeAssay({ assayId: 1686731847000 })), true);
    assert.equal(isWellFormedAssay(makeAssay({ assayName: undefined, genotypes: undefined })), true);
  });

  test("rejects the shapes that used to blank the Saved Assays list", () => {
    assert.equal(isWellFormedAssay(makeAssay({ genotypes: "N2" })), false);
    assert.equal(isWellFormedAssay(makeAssay({ genotypes: ["N2", 4] })), false);
    assert.equal(isWellFormedAssay(makeAssay({ assayName: { toString: 0 } })), false);
    assert.equal(isWellFormedAssay(makeAssay({ assayId: "" })), false);
    assert.equal(isWellFormedAssay(null), false);
    assert.equal(isWellFormedAssay([makeAssay()]), false);
  });
});

describe("exportAllDataAsJSON / importAllDataFromJSON", () => {
  test("exports include records this test created", async () => {
    const assay = makeAssay();
    await saveAssay(assay);

    const dump = await exportAllDataAsJSON();
    assert.equal(typeof dump.version, "number");
    assert.equal(typeof dump.exportedAt, "number");
    assert.ok(dump.assays.some(a => a.assayId === assay.assayId));
  });

  test("rejects a backup object missing required arrays", async () => {
    await assert.rejects(() => importAllDataFromJSON({ assays: [] }), /valid Touch Assay Timer backup/i);
    await assert.rejects(() => importAllDataFromJSON(null), /valid Touch Assay Timer backup/i);
  });

  test("rejects a backup with a malformed record and writes nothing from it", async () => {
    const good = makeAssay();
    // A string where an array belongs is stored without complaint by IDB, but
    // then breaks every screen that lists assays.
    const bad  = makeAssay({ genotypes: "N2" });
    await assert.rejects(
      () => importAllDataFromJSON({ assays: [good, bad], trials: [], runs: [] }),
      /malformed record \(assay #2\)/
    );
    await assert.rejects(
      () => importAllDataFromJSON({ assays: [makeAssay({ assayName: { toString: 0 } })], trials: [], runs: [] }),
      /malformed record/
    );
    await assert.rejects(
      () => importAllDataFromJSON({ assays: [], trials: [makeTrial()], runs: [] }),  // no assayId
      /malformed record \(trial #1\)/
    );
    await assert.rejects(
      () => importAllDataFromJSON({ assays: [], trials: [], runs: [makeRun({ runId: undefined })] }),
      /malformed record \(run #1\)/
    );

    const all = await loadAllAssays();
    assert.ok(!all.some(a => a.assayId === good.assayId), "a rejected backup must not be partly imported");
  });

  test("accepts records with numeric IDs from older databases", async () => {
    const assay = makeAssay({ assayId: Date.now() + 0.5 });
    const counts = await importAllDataFromJSON({
      assays: [assay],
      trials: [makeTrial({ assayId: assay.assayId })],
      runs:   []
    });
    assert.equal(counts.trials, 1);
  });

  test("upserts records from a valid backup without touching unrelated existing data", async () => {
    const existing = makeAssay();
    await saveAssay(existing);

    const imported = makeAssay();
    const counts = await importAllDataFromJSON({
      assays: [imported],
      trials: [],
      runs: []
    });
    assert.equal(counts.assays, 1);

    const all = await loadAllAssays();
    assert.ok(all.some(a => a.assayId === existing.assayId), "pre-existing data must survive an unrelated import");
    assert.ok(all.some(a => a.assayId === imported.assayId), "imported data must be written");
  });
});

describe("recoverCrashGuard", () => {
  // recoverCrashGuard reads/writes sessionStorage, which doesn't exist in
  // Node — provide a minimal in-memory stand-in scoped to this describe block.
  before(() => {
    const store = new Map();
    global.sessionStorage = {
      getItem:    key => (store.has(key) ? store.get(key) : null),
      setItem:    (key, value) => store.set(key, String(value)),
      removeItem: key => store.delete(key)
    };
  });

  test("is a no-op when no crash-guard snapshot exists", async () => {
    global.sessionStorage.removeItem("touchAssayCrashGuard");
    await assert.doesNotReject(() => recoverCrashGuard());
  });

  test("merges a snapshot with more values than what's currently stored", async () => {
    const assay = makeAssay();
    await saveAssay(assay);
    const trial = makeTrial();
    await saveTrial(assay.assayId, trial);
    const run = makeRun({ status: "active", values: [1, 0] });
    await saveRun(assay.assayId, trial.trialId, run);

    global.sessionStorage.setItem("touchAssayCrashGuard", JSON.stringify({
      assayId: assay.assayId,
      trialId: trial.trialId,
      runId:   run.runId,
      values:  [1, 0, 1, 1],
      savedAt: Date.now()
    }));

    await recoverCrashGuard();

    const hydrated = await hydrateAssay(assay.assayId);
    assert.deepEqual(hydrated.trials[0].runs[0].values, [1, 0, 1, 1]);
    // The snapshot must be consumed so a stale guard can't reapply on a later startup.
    assert.equal(global.sessionStorage.getItem("touchAssayCrashGuard"), null);
  });

  test("ignores a snapshot pointing at a run that no longer exists", async () => {
    global.sessionStorage.setItem("touchAssayCrashGuard", JSON.stringify({
      assayId: "x", trialId: "y", runId: "does-not-exist",
      values: [1], savedAt: Date.now()
    }));
    await assert.doesNotReject(() => recoverCrashGuard());
  });
});

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  createAssay, createTrial, createRun,
  completeTrial, abandonTrial, completeRun,
  getActiveTrial
} from "../js/models.js";

describe("createRun", () => {
  test("starts in a fresh, unresolved state", () => {
    const run = createRun({ genotype: "WT", animalIndex: 1, expectedStimCount: 30 });
    assert.equal(run.status, "active");
    assert.equal(run.eligibleForAnalysis, null);
    assert.equal(run.manuallyOverridden, false);
    assert.deepEqual(run.values, []);
    assert.equal(typeof run.runId, "string");
    assert.ok(run.runId.length > 0);
  });

  test("generates a unique runId for every call", () => {
    const a = createRun({ genotype: "WT", animalIndex: 1, expectedStimCount: 30 });
    const b = createRun({ genotype: "WT", animalIndex: 2, expectedStimCount: 30 });
    assert.notEqual(a.runId, b.runId);
  });
});

describe("completeTrial / abandonTrial / completeRun — idempotent guards", () => {
  test("completeTrial only transitions an active trial", () => {
    const trial = createTrial(1);
    completeTrial(trial);
    assert.equal(trial.status, "completed");
    assert.ok(trial.endedAt);

    const endedAtFirst = trial.endedAt;
    // Calling again on an already-completed trial must be a no-op
    completeTrial(trial);
    assert.equal(trial.endedAt, endedAtFirst);
  });

  test("abandonTrial records a reason and does not fire on a non-active trial", () => {
    const trial = createTrial(1);
    completeTrial(trial);
    abandonTrial(trial, "should not apply");
    assert.equal(trial.status, "completed");   // unchanged — already completed
    assert.equal(trial.abandonedReason, null);
  });

  test("completeRun only transitions an active run", () => {
    const run = createRun({ genotype: "WT", animalIndex: 1, expectedStimCount: 30 });
    completeRun(run);
    assert.equal(run.status, "completed");
    run.status = "stoppedEarly";  // simulate a different path having already tagged it
    completeRun(run);
    assert.equal(run.status, "stoppedEarly");  // completeRun must not override it
  });
});

describe("getActiveTrial", () => {
  test("returns the single active trial", () => {
    const assay = createAssay({
      assayName: "t", isi: 1, stimCount: 30, binSize: 10,
      temperature: 22, humidity: 50, genotypes: ["WT"]
    });
    const t1 = createTrial(1);
    completeTrial(t1);
    const t2 = createTrial(2);
    assay.trials.push(t1, t2);

    assert.equal(getActiveTrial(assay), t2);
  });

  test("returns null when there is no active trial", () => {
    const assay = createAssay({
      assayName: "t", isi: 1, stimCount: 30, binSize: 10,
      temperature: 22, humidity: 50, genotypes: ["WT"]
    });
    const t1 = createTrial(1);
    completeTrial(t1);
    assay.trials.push(t1);

    assert.equal(getActiveTrial(assay), null);
  });

  test("returns null for a null/trial-less assay", () => {
    assert.equal(getActiveTrial(null), null);
    assert.equal(getActiveTrial({ trials: [] }), null);
  });
});

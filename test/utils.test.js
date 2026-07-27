import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  normaliseGenotype,
  validateInputs,
  generateAutoID,
  binRunValues,
  computeTouchIndexBins,
  escapeHTML,
  collectPooledRuns,
  collectTouchIndexExclusions,
  summarizeTrialRunsByGenotype
} from "../js/utils.js";

describe("normaliseGenotype", () => {
  test("treats case/whitespace/hyphen/punctuation variants as equal", () => {
    assert.equal(normaliseGenotype("Wild-Type"), normaliseGenotype("wildtype"));
    assert.equal(normaliseGenotype("  UAS-mec-4  "), normaliseGenotype("uasmec4"));
    assert.equal(normaliseGenotype("mec-4(u253)"), normaliseGenotype("MEC4 U253"));
  });

  test("distinguishes genuinely different genotypes", () => {
    assert.notEqual(normaliseGenotype("mec-4"), normaliseGenotype("mec-3"));
  });
});

describe("validateInputs", () => {
  const baseValues = {
    assayName: "test_assay",
    genotypes: ["WT", "mec-4"],
    isi: 1,
    stimCount: 30,
    binSize: 10,
    temperature: 22,
    humidity: 50
  };

  test("accepts a fully valid setup with no errors or warnings", () => {
    const result = validateInputs(baseValues);
    assert.equal(result.isValid, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  });

  test("rejects a missing assay name", () => {
    const result = validateInputs({ ...baseValues, assayName: "" });
    assert.equal(result.isValid, false);
    assert.ok(result.errors.some(e => /assay name/i.test(e)));
  });

  test("rejects an empty genotype list", () => {
    const result = validateInputs({ ...baseValues, genotypes: [] });
    assert.equal(result.isValid, false);
    assert.ok(result.errors.some(e => /genotype/i.test(e)));
  });

  test("rejects blank genotype labels", () => {
    const result = validateInputs({ ...baseValues, genotypes: ["WT", "   "] });
    assert.equal(result.isValid, false);
    assert.ok(result.errors.some(e => /must not be empty/i.test(e)));
  });

  test("rejects fuzzy-duplicate genotypes", () => {
    const result = validateInputs({ ...baseValues, genotypes: ["Wild-Type", "wildtype"] });
    assert.equal(result.isValid, false);
    assert.ok(result.errors.some(e => /unique/i.test(e)));
  });

  test("rejects ISI <= 0", () => {
    const result = validateInputs({ ...baseValues, isi: 0 });
    assert.equal(result.isValid, false);
  });

  test("warns (non-blocking) on a very short ISI", () => {
    const result = validateInputs({ ...baseValues, isi: 0.2 });
    assert.equal(result.isValid, true);
    assert.ok(result.warnings.some(w => /short/i.test(w)));
  });

  test("warns (non-blocking) on an unusually long ISI", () => {
    const result = validateInputs({ ...baseValues, isi: 90 });
    assert.equal(result.isValid, true);
    assert.ok(result.warnings.some(w => /long/i.test(w)));
  });

  test("warns on an unusually large stimulus count", () => {
    const result = validateInputs({ ...baseValues, stimCount: 1000 });
    assert.equal(result.isValid, true);
    assert.ok(result.warnings.some(w => /stimulus count/i.test(w)));
  });

  test("warns on an unusually large bin size", () => {
    const result = validateInputs({ ...baseValues, stimCount: 2000, binSize: 500 });
    assert.equal(result.isValid, true);
    assert.ok(result.warnings.some(w => /bin size/i.test(w)));
  });

  test("rejects bin size greater than stimulus count", () => {
    const result = validateInputs({ ...baseValues, stimCount: 10, binSize: 20 });
    assert.equal(result.isValid, false);
    assert.ok(result.errors.some(e => /cannot be larger/i.test(e)));
  });

  test("warns when total run duration (ISI x stimCount) exceeds an hour", () => {
    const result = validateInputs({ ...baseValues, isi: 5, stimCount: 1000, binSize: 10 });
    assert.equal(result.isValid, true);
    assert.ok(result.warnings.some(w => /minutes per animal/i.test(w)));
  });

  test("treats explicit 0 for optional temperature/humidity as valid (not blank)", () => {
    const result = validateInputs({ ...baseValues, temperature: 0, humidity: 0 });
    assert.equal(result.isValid, true);
  });

  test("rejects an out-of-range humidity", () => {
    const result = validateInputs({ ...baseValues, humidity: 150 });
    assert.equal(result.isValid, false);
  });

  test("leaves optional temperature/humidity unvalidated when null (not provided)", () => {
    const result = validateInputs({ ...baseValues, temperature: null, humidity: null });
    assert.equal(result.isValid, true);
  });
});

describe("generateAutoID", () => {
  test("produces a touch_YYYY-MM-DD_HHMM formatted string", () => {
    const id = generateAutoID();
    assert.match(id, /^touch_\d{4}-\d{2}-\d{2}_\d{4}$/);
  });
});

describe("binRunValues", () => {
  test("bins evenly-divisible values into percentages", () => {
    const result = binRunValues([1, 1, 0, 0, 1, 1], 2);
    assert.deepEqual(result, [100, 0, 100]);
  });

  test("drops a trailing partial bin instead of including it", () => {
    // 7 values, binSize 3 -> two full bins of 3, one leftover value dropped
    const result = binRunValues([1, 1, 1, 0, 0, 0, 1], 3);
    assert.equal(result.length, 2);
    assert.deepEqual(result, [100, 0]);
  });

  test("returns an empty array for null/undefined values", () => {
    assert.deepEqual(binRunValues(null, 5), []);
    assert.deepEqual(binRunValues(undefined, 5), []);
  });

  test("returns an empty array for a non-array input", () => {
    assert.deepEqual(binRunValues("not-an-array", 5), []);
  });
});

describe("computeTouchIndexBins", () => {
  test("normalises each bin against the first bin (baseline)", () => {
    const result = computeTouchIndexBins([50, 25, 10]);
    assert.deepEqual(result, [1, 0.5, 0.2]);
  });

  test("returns null when the baseline bin is zero", () => {
    assert.equal(computeTouchIndexBins([0, 10, 20]), null);
  });

  test("returns null for an empty or missing input", () => {
    assert.equal(computeTouchIndexBins([]), null);
    assert.equal(computeTouchIndexBins(null), null);
    assert.equal(computeTouchIndexBins(undefined), null);
  });
});

describe("escapeHTML", () => {
  test("escapes all HTML-injectable characters", () => {
    assert.equal(
      escapeHTML(`<script>alert("x")</script>&'`),
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;"
    );
  });

  test("returns an empty string for falsy input", () => {
    assert.equal(escapeHTML(""), "");
    assert.equal(escapeHTML(null), "");
    assert.equal(escapeHTML(undefined), "");
  });
});

describe("collectPooledRuns", () => {
  const assay = {
    trials: [
      { trialIndex: 1, status: "completed", runs: [{ runId: "a" }, { runId: "b" }] },
      { trialIndex: 2, status: "abandoned",  runs: [{ runId: "c" }] },
      { trialIndex: 3, status: "active",     runs: [{ runId: "d" }] }
    ]
  };

  test("includes only completed trials by default", () => {
    const runs = collectPooledRuns(assay);
    assert.deepEqual(runs.map(r => r.runId), ["a", "b"]);
  });

  test("stamps each run with its parent trial's trialIndex", () => {
    const runs = collectPooledRuns(assay);
    assert.ok(runs.every(r => r.trialIndex === 1));
  });

  test("includeAbandoned:true includes every trial regardless of status", () => {
    const runs = collectPooledRuns(assay, { includeAbandoned: true });
    assert.deepEqual(runs.map(r => r.runId), ["a", "b", "c", "d"]);
  });
});

describe("collectTouchIndexExclusions", () => {
  test("flags only eligible runs whose baseline bin is zero", () => {
    const assay = {
      binSize: 2,
      trials: [{
        trialIndex: 1,
        status: "completed",
        runs: [
          { genotype: "WT",  animalIndex: 1, eligibleForAnalysis: true,  values: [0, 0, 1, 1] }, // baseline 0 -> excluded
          { genotype: "WT",  animalIndex: 2, eligibleForAnalysis: true,  values: [1, 1, 1, 1] }, // baseline 100 -> not excluded
          { genotype: "mut", animalIndex: 1, eligibleForAnalysis: false, values: [0, 0] }        // ineligible -> never scanned
        ]
      }]
    };
    const exclusions = collectTouchIndexExclusions(assay);
    assert.equal(exclusions.length, 1);
    assert.deepEqual(exclusions[0].slice(0, 3), [1, "WT", 1]);
  });

  test("ignores trials that aren't completed", () => {
    const assay = {
      binSize: 2,
      trials: [{
        trialIndex: 1,
        status: "active",
        runs: [{ genotype: "WT", animalIndex: 1, eligibleForAnalysis: true, values: [0, 0] }]
      }]
    };
    assert.deepEqual(collectTouchIndexExclusions(assay), []);
  });
});

describe("summarizeTrialRunsByGenotype", () => {
  test("gives every declared genotype an entry even with zero runs", () => {
    const summary = summarizeTrialRunsByGenotype(["WT", "mec-4"], null);
    assert.deepEqual(Object.keys(summary), ["WT", "mec-4"]);
    assert.deepEqual(summary["WT"], { total: 0, eligible: 0, ineligible: 0, runs: [] });
  });

  test("tallies completed+eligible runs as eligible, everything else as ineligible", () => {
    const trial = {
      runs: [
        { genotype: "WT", status: "completed",    eligibleForAnalysis: true  },
        { genotype: "WT", status: "completed",    eligibleForAnalysis: false },
        { genotype: "WT", status: "stoppedEarly", eligibleForAnalysis: true  },
        { genotype: "WT", status: "abandoned",    eligibleForAnalysis: false }
      ]
    };
    const summary = summarizeTrialRunsByGenotype(["WT"], trial);
    assert.deepEqual(summary["WT"], {
      total: 4, eligible: 1, ineligible: 3,
      runs: trial.runs
    });
  });

  test("excludes still-active (in-progress) runs from the tally", () => {
    const trial = { runs: [{ genotype: "WT", status: "active", eligibleForAnalysis: null }] };
    const summary = summarizeTrialRunsByGenotype(["WT"], trial);
    assert.deepEqual(summary["WT"], { total: 0, eligible: 0, ineligible: 0, runs: [] });
  });

  test("ignores runs for genotypes not declared on the assay", () => {
    const trial = { runs: [{ genotype: "unknown-genotype", status: "completed", eligibleForAnalysis: true }] };
    const summary = summarizeTrialRunsByGenotype(["WT"], trial);
    assert.deepEqual(summary["WT"], { total: 0, eligible: 0, ineligible: 0, runs: [] });
  });
});

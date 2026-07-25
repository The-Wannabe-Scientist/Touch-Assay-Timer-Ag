import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildTrialRaw2D,
  buildTrialBinned2D,
  buildPooledRaw2D,
  buildHtmlTableFrom2D,
  buildMetadata2D,
  applySheetLayout
} from "../js/export.js";

describe("buildTrialRaw2D", () => {
  // Genotype "WT" has a failed first attempt and a successful retry sharing
  // the same animalIndex (by design — see startRun() in main.js); genotype
  // "mut" has one run whose eligibility was manually overridden.
  const assay = { stimCount: 3, genotypes: ["WT", "mut"] };
  const trial = {
    runs: [
      {
        genotype: "WT", animalIndex: 1, status: "completed",
        eligibleForAnalysis: true, ineligibleReason: null, partialBinWarning: null,
        values: [1, 0, 1], manuallyOverridden: false
      },
      {
        genotype: "WT", animalIndex: 1, status: "stoppedEarly",
        eligibleForAnalysis: false, ineligibleReason: "Incomplete stimulus count", partialBinWarning: null,
        values: [1], manuallyOverridden: false
      },
      {
        genotype: "mut", animalIndex: 1, status: "completed",
        eligibleForAnalysis: false, ineligibleReason: "Excluded for movement artifact", partialBinWarning: null,
        values: [1, 1, 1], manuallyOverridden: true, overrideReason: "Excluded for movement artifact",
        autoEligibleForAnalysis: true, autoIneligibleReason: null
      }
    ]
  };

  const result = buildTrialRaw2D(trial, assay);
  const [headerGenotype, headerAnimal, headerStatus, headerPartialBin, headerIneligible, headerOverride, stim1, stim2, stim3] = result;

  test("returns six header rows plus one row per stimulus", () => {
    assert.equal(result.length, 6 + assay.stimCount);
  });

  test("labels the genotype and status of every run, spacer between genotypes", () => {
    assert.deepEqual(headerGenotype, ["Genotype", "WT", "WT", "", "mut"]);
    assert.deepEqual(headerStatus, ["Run Status", "Completed", "Stopped Early", "", "Completed"]);
  });

  test("disambiguates a retried run sharing the same animalIndex", () => {
    assert.deepEqual(headerAnimal, ["Animal", "Animal 1", "Animal 1 (retry 1)", "", "Animal 1"]);
  });

  test("carries the ineligible reason through unmodified for non-overridden runs", () => {
    assert.deepEqual(headerIneligible, ["Ineligible Reason", "", "Incomplete stimulus count", "", "Excluded for movement artifact"]);
  });

  test("documents a manual override with the original automatic decision", () => {
    assert.equal(headerOverride[0], "Manual Override");
    assert.equal(headerOverride[1], "");                  // not overridden
    assert.equal(headerOverride[2], "");                  // not overridden
    assert.match(headerOverride[4], /Manually marked INELIGIBLE/);
    assert.match(headerOverride[4], /auto: eligible/);
    assert.match(headerOverride[4], /Excluded for movement artifact/);
  });

  test("shows blank cells once a run has ended, not zero", () => {
    assert.deepEqual(stim1, ["Stimulus 1", 1, 1, "", 1]);
    assert.deepEqual(stim2, ["Stimulus 2", 0, "", "", 1]);   // WT retry run only recorded 1 value
    assert.deepEqual(stim3, ["Stimulus 3", 1, "", "", 1]);
  });
});

describe("buildTrialBinned2D", () => {
  // Two eligible runs with deliberately clean numbers: bin-1 percentages of
  // 100 and 50 give an exact mean of 75 and SEM of 25 (no floating-point
  // rounding needed to assert against).
  const assay = { genotypes: ["WT"], binSize: 2 };
  const trial = {
    runs: [
      { genotype: "WT", animalIndex: 1, status: "completed", eligibleForAnalysis: true, values: [1, 1, 0, 0] },
      { genotype: "WT", animalIndex: 2, status: "completed", eligibleForAnalysis: true, values: [1, 0, 1, 1] }
    ]
  };

  const result = buildTrialBinned2D(trial, assay);

  test("computes the correct raw per-bin percentages for each run", () => {
    // rows: [genotype, animal, status, override, rawBin1, rawBin2, sep, sep, sep, summaryHeader, summaryBin1, summaryBin2]
    assert.deepEqual(result[4], ["Bin 1 (1–2)", 100, 50]);
    assert.deepEqual(result[5], ["Bin 2 (3–4)", 0, 100]);
  });

  test("computes mean/SEM/N across eligible runs for the summary section", () => {
    assert.deepEqual(result[9], ["Bin", "WT_Mean", "WT_SEM", "WT_N"]);
    assert.deepEqual(result[10], ["Bin 1 (1–2)", 75, 25, 2]);
  });

  test("excludes ineligible runs from the summary statistics", () => {
    const trialWithIneligible = {
      runs: [
        ...trial.runs,
        { genotype: "WT", animalIndex: 3, status: "stoppedEarly", eligibleForAnalysis: false, values: [1, 1] }
      ]
    };
    const r = buildTrialBinned2D(trialWithIneligible, assay);
    // N is still 2 — the ineligible third run must not be counted
    assert.equal(r[10][3], 2);
  });
});

describe("buildPooledRaw2D", () => {
  test("assigns a unique globalAnimalIndex per genotype across trials, regardless of eligibility", () => {
    const assay = { stimCount: 2, genotypes: ["WT"] };
    const runs = [
      { genotype: "WT", animalIndex: 1, trialIndex: 1, status: "completed", eligibleForAnalysis: true, values: [1, 1] },
      { genotype: "WT", animalIndex: 1, trialIndex: 1, status: "stoppedEarly", eligibleForAnalysis: false, values: [1] },
      { genotype: "WT", animalIndex: 1, trialIndex: 2, status: "completed", eligibleForAnalysis: true, values: [0, 0] }
    ];
    const result = buildPooledRaw2D(assay, {}, runs);
    // Header row 1 = Animal (globalAnimalIndex-based) — must be 1, 2, 3 with no collisions
    assert.deepEqual(result[1], ["Animal", "Animal 1", "Animal 2", "Animal 3"]);
    // Header row 3 = Trial Animal (per-trial animalIndex) — the original, possibly-duplicated label
    assert.deepEqual(result[3], ["Trial Animal", "Animal 1", "Animal 1", "Animal 1"]);
  });
});

describe("buildHtmlTableFrom2D", () => {
  test("renders known header/descriptor rows as <th>, everything else as <td>", () => {
    const html = buildHtmlTableFrom2D("Test Section", [
      ["Genotype", "WT"],
      ["Animal", "Animal 1"],
      ["Stimulus 1", 1]
    ]);
    assert.match(html, /<th>Genotype<\/th>/);
    assert.match(html, /<th>Animal<\/th>/);
    assert.match(html, /<td>Stimulus 1<\/td>/);
  });

  test("escapes user-supplied string content to prevent XSS", () => {
    const html = buildHtmlTableFrom2D("<img src=x onerror=alert(1)>", [
      ["Genotype", "<script>bad()</script>"]
    ]);
    assert.doesNotMatch(html, /<script>bad\(\)<\/script>/);
    assert.doesNotMatch(html, /<img src=x/);
  });

  test("returns an empty string for empty input", () => {
    assert.equal(buildHtmlTableFrom2D("Title", []), "");
    assert.equal(buildHtmlTableFrom2D("Title", null), "");
  });
});

describe("buildMetadata2D", () => {
  test("includes the core assay parameters", () => {
    const rows = buildMetadata2D({
      assayName: "test_assay", createdAt: Date.now(), lastModifiedAt: Date.now(),
      genotypes: ["WT", "mec-4"], temperature: 22, humidity: 50,
      isi: 1, stimCount: 30, binSize: 10
    });
    const asObj = Object.fromEntries(rows.slice(1));
    assert.equal(asObj["Experiment ID"], "test_assay");
    assert.equal(asObj["Genotypes"], "WT, mec-4");
    assert.equal(asObj["Inter-stimulus Interval (s)"], 1);
  });
});

describe("applySheetLayout", () => {
  test("no-ops on empty data instead of throwing", () => {
    const sheet = {};
    assert.doesNotThrow(() => applySheetLayout(sheet, []));
    assert.doesNotThrow(() => applySheetLayout(sheet, null));
  });

  test("sets a wider column width for the first (label) column", () => {
    const sheet = {};
    applySheetLayout(sheet, [["Genotype", "WT", "mut"]]);
    assert.equal(sheet["!cols"][0].wch, 22);
    assert.equal(sheet["!cols"][1].wch, 10);
  });
});

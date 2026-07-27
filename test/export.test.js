import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildTrialRaw2D,
  buildTrialBinned2D,
  buildTrialTouchIndexBinned2D,
  buildTrialTouchIndexAnalysed2D,
  buildTouchAnalysedSheet2D,
  buildTrialRawTidy2D,
  buildTrialBinnedTidy2D,
  buildPooledRaw2D,
  buildPooledRawTidy2D,
  buildPooledBinnedTidy2D,
  buildHtmlTableFrom2D,
  buildMetadata2D,
  buildAllSections,
  applySheetLayout,
  injectLiveFormulas,
  extractBinSeries
} from "../js/export.js";

/**
 * Builds a minimal mock of a SheetJS worksheet from a 2D array — just enough
 * shape (cells keyed by "A1"-style address, {t, v}) for injectLiveFormulas()
 * to find and annotate with a live formula. Mirrors XLSX.utils.aoa_to_sheet's
 * addressing convention without depending on the SheetJS package, consistent
 * with injectLiveFormulas() itself not depending on it (see encodeColumnLetter
 * in export.js).
 *
 * Matches real aoa_to_sheet's cell-creation rule exactly (verified against
 * the actual SheetJS package): a cell IS created for "" (empty string) —
 * only null/undefined are skipped. This matters here specifically because a
 * blank SEM cell (N=1, calculateStats() returns "") must still exist for
 * injectLiveFormulas() to attach a live formula to — a mock that skipped ""
 * would silently hide a real gap (or falsely report one) in that path.
 *
 * @param {any[][]} data2D
 * @returns {Object.<string, {t: string, v: any}>}
 */
function mockSheetFromData2D(data2D) {
  const sheet = {};
  data2D.forEach((row, r) => {
    if (!row) return;
    row.forEach((cell, c) => {
      if (cell == null) return;
      const col = String.fromCharCode(65 + c); // Test fixtures below never exceed column Z.
      sheet[`${col}${r + 1}`] = { t: typeof cell === "number" ? "n" : "s", v: cell };
    });
  });
  return sheet;
}

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
  // Partial Bin Warning is dropped: no run in this fixture has one set, and
  // buildTrialRaw2D omits empty optional QC rows entirely (see
  // isDescriptorRowEmpty in export.js) rather than rendering an empty row.
  const [headerGenotype, headerAnimal, headerStatus, headerIneligible, headerOverride, stim1, stim2, stim3] = result;

  test("returns five header rows (Partial Bin Warning omitted — empty) plus one row per stimulus", () => {
    assert.equal(result.length, 5 + assay.stimCount);
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

  test("omits the Partial Bin Warning row entirely when no run has one", () => {
    assert.ok(!result.some(row => row[0] === "Partial Bin Warning"));
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

  // rows: [genotype, animal, status, eligible, rawBin1, rawBin2, sep, sep, sep, summaryHeader, summaryBin1, summaryBin2]
  // (no "Manual Override" row — omitted since neither run was overridden; "Eligible" is
  // never omitted — see the comment on headerEligible in buildTrialBinned2D)

  test("always includes an Eligible row, marking every eligible run", () => {
    assert.deepEqual(result[3], ["Eligible", "Yes", "Yes"]);
  });

  test("computes the correct raw per-bin percentages for each run", () => {
    assert.deepEqual(result[4], ["Bin 1 (1–2)", 100, 50]);
    assert.deepEqual(result[5], ["Bin 2 (3–4)", 0, 100]);
  });

  test("computes mean/SEM/N across eligible runs for the summary section", () => {
    assert.deepEqual(result[9], ["Bin", "WT_Mean", "WT_SEM", "WT_N"]);
    assert.deepEqual(result[10], ["Bin 1 (1–2)", 75, 25, 2]);
  });

  test("excludes ineligible runs from the summary statistics, and marks them blank in the Eligible row", () => {
    const trialWithIneligible = {
      runs: [
        ...trial.runs,
        { genotype: "WT", animalIndex: 3, status: "stoppedEarly", eligibleForAnalysis: false, values: [1, 1] }
      ]
    };
    const r = buildTrialBinned2D(trialWithIneligible, assay);
    assert.deepEqual(r[3], ["Eligible", "Yes", "Yes", ""]);
    // N is still 2 — the ineligible third run must not be counted
    assert.equal(r[10][3], 2);
  });
});

describe("injectLiveFormulas", () => {
  // Two genotypes: WT has 3 runs (2 eligible with clean numbers matching the
  // buildTrialBinned2D fixture above, 1 ineligible run that still recorded a
  // real, non-blank bin-1 value — the case that specifically tests the
  // formula filters by the Eligible row and not just by blank cells). mut
  // has 1 eligible run. Column layout: label=A, WT runs=B,C,D, spacer=E,
  // mut run=F.
  //
  // Row layout (0-indexed): 0 Genotype, 1 Animal, 2 Run Status, 3 Eligible,
  // 4 Bin-1 raw, 5 Bin-2 raw, 6-8 separators, 9 summary header, 10 Bin-1
  // summary, 11 Bin-2 summary. Excel rows are always +1.
  describe("percent-response block (with an Eligible row)", () => {
    const assay = { genotypes: ["WT", "mut"], binSize: 2 };
    const trial = {
      runs: [
        { genotype: "WT",  animalIndex: 1, status: "completed",    eligibleForAnalysis: true,  values: [1, 1, 0, 0] },
        { genotype: "WT",  animalIndex: 2, status: "completed",    eligibleForAnalysis: true,  values: [1, 0, 1, 1] },
        { genotype: "WT",  animalIndex: 3, status: "stoppedEarly", eligibleForAnalysis: false, values: [1, 1] },
        { genotype: "mut", animalIndex: 1, status: "completed",    eligibleForAnalysis: true,  values: [0, 0, 0, 0] }
      ]
    };

    const data2D = buildTrialBinned2D(trial, assay);
    const sheet  = mockSheetFromData2D(data2D);
    injectLiveFormulas(sheet, data2D);

    test("sanity: fixture's static Bin-1 summary numbers are what the formulas below must reproduce", () => {
      assert.deepEqual(data2D[10], ["Bin 1 (1–2)", 75, 25, 2, 0, "", 1]);
    });

    test("WT (3 runs, 1 ineligible with a real value): formula excludes it via the Eligible row, not blankness", () => {
      assert.equal(sheet["D11"].f, 'COUNTIFS(B4:D4,"Yes",B5:D5,"<>")');
      assert.equal(sheet["B11"].f, 'IF(D11=0,"",AVERAGEIFS(B5:D5,B4:D4,"Yes"))');
      assert.equal(
        sheet["C11"].f,
        'IF(D11<=1,"",SQRT(SUMPRODUCT((B4:D4="Yes")*(B5:D5<>"")*(B5:D5-B11)^2)/(D11-1))/SQRT(D11))'
      );
    });

    test("mut (1 run, single-column range): formula still targets the correct isolated column", () => {
      assert.equal(sheet["G11"].f, 'COUNTIFS(F4:F4,"Yes",F5:F5,"<>")');
      assert.equal(sheet["E11"].f, 'IF(G11=0,"",AVERAGEIFS(F5:F5,F4:F4,"Yes"))');
      assert.equal(
        sheet["F11"].f,
        'IF(G11<=1,"",SQRT(SUMPRODUCT((F4:F4="Yes")*(F5:F5<>"")*(F5:F5-E11)^2)/(G11-1))/SQRT(G11))'
      );
    });

    test("does not touch cells outside any tracked block (e.g. the Genotype header row itself)", () => {
      assert.equal(sheet["A1"].f, undefined);
    });
  });

  describe("Touch Index block (no Eligible row — exclusion is blank-cell-encoded)", () => {
    // Single genotype, 2 eligible runs — mirrors how buildTouchAnalysedSheet2D
    // combines tiBinned2D (raw TI values) and tiAnalysed2D (its summary,
    // built as a SEPARATE table with no raw data of its own) into one sheet,
    // which is exactly the cross-table case injectLiveFormulas must handle.
    const assay = { genotypes: ["WT"], binSize: 2 };
    const trial = {
      runs: [
        { genotype: "WT", animalIndex: 1, status: "completed", eligibleForAnalysis: true, values: [1, 1, 0, 0] },
        { genotype: "WT", animalIndex: 2, status: "completed", eligibleForAnalysis: true, values: [1, 0, 1, 1] }
      ]
    };

    const tiBinned2D   = buildTrialTouchIndexBinned2D(trial, assay);
    const tiAnalysed2D = buildTrialTouchIndexAnalysed2D(trial, assay);
    const combined     = buildTouchAnalysedSheet2D({
      percentAnalysed2D: [], tiBinned2D, tiAnalysed2D
    });
    const sheet = mockSheetFromData2D(combined);
    injectLiveFormulas(sheet, combined);

    test("combines tiBinned2D and tiAnalysed2D with the documented 2-blank-row gap", () => {
      // tiBinned2D: [Genotype, Animal, Bin1, Bin2] (4 rows, no Manual Override — none overridden).
      // Then 2 blank rows, then tiAnalysed2D: [header, Bin1, Bin2].
      assert.equal(combined.length, 4 + 2 + 3);
      assert.deepEqual(combined[6], ["Bin", "WT_Mean", "WT_SEM", "WT_N"]);
    });

    test("references tiBinned2D's raw rows with plain COUNT/AVERAGE/STDEV (blank cells already excluded)", () => {
      // tiAnalysed2D's Bin-1 summary is combined-array row 7 -> Excel row 8.
      // tiBinned2D's Bin-1 raw row is combined-array row 2 -> Excel row 3.
      assert.equal(sheet["D8"].f, "COUNT(B3:C3)");
      assert.equal(sheet["B8"].f, 'IF(D8=0,"",AVERAGE(B3:C3))');
      assert.equal(sheet["C8"].f, 'IF(D8<=1,"",STDEV(B3:C3)/SQRT(D8))');
    });
  });

  test("no-ops on a table with no Genotype/Bin summary rows (e.g. the Metadata sheet)", () => {
    const data2D = buildMetadata2D({
      assayName: "x", createdAt: Date.now(), genotypes: [], isi: 1, stimCount: 1, binSize: 1
    });
    const sheet = mockSheetFromData2D(data2D);
    assert.doesNotThrow(() => injectLiveFormulas(sheet, data2D));
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

describe("buildTrialRawTidy2D", () => {
  const assay = { genotypes: ["WT"] };
  const trial = {
    trialIndex: 1,
    runs: [
      { genotype: "WT", animalIndex: 1, runId: "r1", status: "completed", eligibleForAnalysis: true, values: [1, 0] },
      { genotype: "WT", animalIndex: 2, runId: "r2", status: "stoppedEarly", eligibleForAnalysis: false, values: [1] }
    ]
  };
  const rows = buildTrialRawTidy2D(trial, assay);

  test("emits one row per (run, stimulus), not padded to a common length", () => {
    // header + 2 rows for run 1 (values.length=2) + 1 row for run 2 (values.length=1)
    assert.equal(rows.length, 1 + 2 + 1);
  });

  test("carries genotype, run identity, eligibility, and value through per row", () => {
    assert.deepEqual(rows[0], ["Trial", "Genotype", "Animal", "RunID", "RunStatus", "Eligible", "StimulusIndex", "Value"]);
    assert.deepEqual(rows[1], [1, "WT", "Animal 1", "r1", "Completed", true, 1, 1]);
    assert.deepEqual(rows[2], [1, "WT", "Animal 1", "r1", "Completed", true, 2, 0]);
    assert.deepEqual(rows[3], [1, "WT", "Animal 2", "r2", "Stopped Early", false, 1, 1]);
  });
});

describe("buildTrialBinnedTidy2D", () => {
  test("blanks TouchIndex for ineligible runs but still reports BinnedPercent", () => {
    const assay = { genotypes: ["WT"], binSize: 2 };
    const trial = {
      trialIndex: 1,
      runs: [
        { genotype: "WT", animalIndex: 1, runId: "r1", status: "stoppedEarly", eligibleForAnalysis: false, values: [1, 1] }
      ]
    };
    const rows = buildTrialBinnedTidy2D(trial, assay);
    // [Trial, Genotype, Animal, RunID, RunStatus, Eligible, BinIndex, BinStart, BinEnd, BinnedPercent, TouchIndex]
    assert.deepEqual(rows[1], [1, "WT", "Animal 1", "r1", "Stopped Early", false, 1, 1, 2, 100, ""]);
  });
});

describe("buildPooledRawTidy2D / buildPooledBinnedTidy2D", () => {
  const assay = { genotypes: ["WT"], binSize: 2 };
  const runs = [
    { genotype: "WT", animalIndex: 1, trialIndex: 1, runId: "r1", status: "completed", eligibleForAnalysis: true, values: [1, 1, 0, 0] }
  ];

  test("raw tidy carries both the pooled Animal (global) and per-trial TrialAnimal", () => {
    const rows = buildPooledRawTidy2D(assay, {}, runs);
    assert.deepEqual(rows[0], ["Trial", "Genotype", "Animal", "TrialAnimal", "RunID", "RunStatus", "Eligible", "StimulusIndex", "Value"]);
    assert.deepEqual(rows[1], [1, "WT", "Animal 1", "Animal 1", "r1", "Completed", true, 1, 1]);
  });

  test("binned tidy computes Touch Index for an eligible run with a non-zero baseline", () => {
    const rows = buildPooledBinnedTidy2D(assay, {}, runs);
    // Bin 1 = 100%, Bin 2 = 0% -> Touch Index baseline 100 -> [1, 0]
    assert.deepEqual(rows[1], [1, "WT", "Animal 1", "Animal 1", "r1", "Completed", true, 1, 1, 2, 100, 1]);
    assert.deepEqual(rows[2], [1, "WT", "Animal 1", "Animal 1", "r1", "Completed", true, 2, 3, 4, 0, 0]);
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
    // Data cells carry a cell-text/cell-numeric class (see isNumeric in
    // buildHtmlTableFrom2D) so the preview can style them differently —
    // left-aligned text vs. mono/tabular numbers.
    assert.match(html, /<td class="cell-text">Stimulus 1<\/td>/);
    assert.match(html, /<td class="cell-numeric">1<\/td>/);
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

  test("omits the <h3> entirely when no title is given (accordion <summary> shows the name instead)", () => {
    const html = buildHtmlTableFrom2D(null, [["Genotype", "WT"]]);
    assert.doesNotMatch(html, /<h3>/);
  });

  test("renders a wide-format Eligible row's \"Yes\" cells as a green status pill, blanks untouched", () => {
    const html = buildHtmlTableFrom2D(null, [
      ["Genotype", "WT", "WT", "", "mut"],
      ["Eligible", "Yes", "", "", "Yes"]
    ]);
    const pillCount = (html.match(/status-pill status-pill--good/g) || []).length;
    assert.equal(pillCount, 2);
    // The blank (ineligible-or-spacer) Eligible cells stay untouched, not a red pill —
    // ambiguous with the spacer column between genotypes, see the JSDoc rationale.
    assert.doesNotMatch(html, /status-pill--bad/);
  });

  test("renders a tidy-format boolean Eligible column the same way — true as a pill, false as plain \"No\"", () => {
    const html = buildHtmlTableFrom2D(null, [
      ["Trial", "Genotype", "Animal", "RunID", "RunStatus", "Eligible", "StimulusIndex", "Value"],
      [1, "WT", "Animal 1", "r1", "Completed", true, 1, 1],
      [1, "WT", "Animal 2", "r2", "Stopped Early", false, 1, 1]
    ]);
    assert.match(html, /status-pill status-pill--good">✓ Yes<\/span>/);
    assert.match(html, /<td class="cell-text">No<\/td>/);
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

describe("buildAllSections", () => {
  const assay = {
    assayId: "a1", assayName: "x", createdAt: Date.now(), lastModifiedAt: Date.now(),
    isi: 1, stimCount: 4, binSize: 2, genotypes: ["WT"],
    trials: [{
      trialId: "t1", trialIndex: 1, status: "completed",
      runs: [{ genotype: "WT", animalIndex: 1, status: "completed", eligibleForAnalysis: true, values: [1, 1, 0, 0] }]
    }]
  };

  test("flags Raw and Raw/Binned(Tidy) sections as `large`; Metadata/Analysed do not", () => {
    const sections = buildAllSections(assay, [{ type: "trial", trialId: "t1" }], { includeTidy: true });
    const byName = Object.fromEntries(sections.map(s => [s.name, !!s.large]));
    assert.equal(byName["Assay Metadata"], false);
    assert.equal(byName["Trial 1 - Raw"], true);
    assert.equal(byName["Trial 1 - Analysed"], false);
    assert.equal(byName["Trial 1 - Raw (Tidy)"], true);
    assert.equal(byName["Trial 1 - Binned (Tidy)"], true);
  });

  test("omits tidy sections entirely when includeTidy is not set", () => {
    const sections = buildAllSections(assay, [{ type: "trial", trialId: "t1" }]);
    assert.ok(!sections.some(s => s.name.includes("Tidy")));
  });

  test("attaches percentResponse/touchIndex chart series to Analysed sections", () => {
    const sections = buildAllSections(assay, [{ type: "trial", trialId: "t1" }]);
    const analysed = sections.find(s => s.name === "Trial 1 - Analysed");
    assert.ok(analysed.charts);
    assert.deepEqual(analysed.charts.percentResponse.WT.means, [100, 0]);
    // Single eligible run, values [1,1,0,0], binSize 2: bin1=100%, bin2=0% -> TI baseline 100 -> [1, 0]
    assert.deepEqual(analysed.charts.touchIndex.WT.means, [1, 0]);
  });
});

describe("extractBinSeries", () => {
  // Same fixture as the buildTrialBinned2D describe block above: WT has two
  // eligible runs with clean numbers (mean 75, SEM 25, N 2 for bin 1).
  const assay = { genotypes: ["WT", "mut"], binSize: 2 };
  const trial = {
    runs: [
      { genotype: "WT",  animalIndex: 1, status: "completed", eligibleForAnalysis: true, values: [1, 1, 0, 0] },
      { genotype: "WT",  animalIndex: 2, status: "completed", eligibleForAnalysis: true, values: [1, 0, 1, 1] },
      { genotype: "mut", animalIndex: 1, status: "completed", eligibleForAnalysis: true, values: [0, 0, 0, 0] }
    ]
  };

  test("reads means/sems/ns per genotype from a table with a mixed raw+summary shape", () => {
    const data2D = buildTrialBinned2D(trial, assay);
    const series = extractBinSeries(data2D);
    assert.deepEqual(series.WT.bins,  [1, 2]);
    assert.deepEqual(series.WT.means, [75, 50]);
    assert.deepEqual(series.WT.sems,  [25, 50]);
    assert.deepEqual(series.WT.ns,    [2, 2]);
    assert.deepEqual(series.mut.means, [0, 0]);
  });

  test("also works on a summary-only table (no raw rows preceding it)", () => {
    const data2D = buildTrialTouchIndexAnalysed2D(trial, assay);
    const series = extractBinSeries(data2D);
    assert.ok(series.WT.means.length > 0);
    assert.ok("mut" in series);
  });

  test("returns an empty object when no \"Bin\" summary header exists", () => {
    assert.deepEqual(extractBinSeries([["Genotype", "WT"], ["Animal", "Animal 1"]]), {});
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

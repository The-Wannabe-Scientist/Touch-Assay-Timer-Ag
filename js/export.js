/**
 * @file export.js
 * @module Export
 * @description Formats nested assay data into 2D arrays for Excel export and
 * HTML preview, plus a zero-dependency CSV fallback.
 *
 * Each "2D array" is an array of rows, where each row is an array of cell values.
 * These are passed to SheetJS (XLSX) for Excel, rendered to <table> HTML for
 * the preview modal, or serialised to comma-separated text for CSV.
 *
 * Sheet layout for every trial/pooled section:
 *   1. Raw stimulus values    (one column per run, one row per stimulus)
 *                              — includes Partial Bin Warning and Ineligible Reason rows
 *   2. Binned percentages     (% response per bin) + mean / SEM / N summary
 *   3. Touch Index (binned)   (normalised against bin 1 baseline)
 *   4. Touch Index (analysed) (mean / SEM / N across animals per genotype)
 *
 * All three master export functions (Excel, CSV, HTML preview) share a single
 * data-building pass via buildAllSections(). For pooled configs a shared
 * run-binning cache avoids redundant computation.
 *
 * Depends on SheetJS (XLSX) being loaded globally for Excel export.
 * The CSV fallback has no external dependencies.
 */

import {
  binRunValues,
  computeTouchIndexBins,
  collectPooledRuns,
  collectTouchIndexExclusions,
  escapeHTML,
  formatDateTime
} from "./utils.js";

/**
 * @typedef {import('./utils.js').Assay} Assay
 * @typedef {import('./utils.js').Trial} Trial
 * @typedef {import('./utils.js').Run} Run
 */


/* ==========================================================================
   Constants
   ========================================================================== */

/**
 * Human-readable labels for run status values.
 * Used in the "Run Status" header row of every raw data table.
 * @type {Object.<string, string>}
 */
export const RUN_STATUS_LABELS = {
  completed:    "Completed",
  stoppedEarly: "Stopped Early",
  abandoned:    "Abandoned"
};


/* ==========================================================================
   XSS Guard
   ========================================================================== */

// escapeHTML is imported from utils.js — single shared implementation.


/* ==========================================================================
   Internal Helpers
   ========================================================================== */

/**
 * Groups a flat list of run objects by genotype and sorts them for consistent
 * column ordering across all exported tables.
 *
 * For pooled (cross-trial) views, runs are sorted by trial index first, then
 * animal index, and each run is assigned a `globalAnimalIndex` for labelling.
 *
 * For per-trial views, runs are sorted by animal index only.
 *
 * @param {Object[]} runs      - Flat array of run objects.
 * @param {string[]} genotypes - Ordered list of genotype labels (defines column order).
 * @param {boolean}  isPooled  - Whether this is a pooled cross-trial view.
 * @returns {Object.<string, Object[]>} Map of genotype → sorted run array.
 */
function groupAndSortRuns(runs, genotypes, isPooled = false) {
  // Initialise empty arrays for every declared genotype.
  const runsByGenotype = {};
  genotypes.forEach(g => { runsByGenotype[g] = []; });

  // Assign each run to its genotype bucket. A run whose genotype doesn't
  // exactly match a current entry in `genotypes` (stale/renamed label from
  // an imported backup, since there's no in-app genotype-rename feature)
  // would otherwise vanish from every export table with zero indication —
  // warn once per unmatched label so the omission is at least visible.
  const warnedUnmatchedGenotypes = new Set();
  runs.forEach(run => {
    if (runsByGenotype[run.genotype]) {
      runsByGenotype[run.genotype].push(run);
    } else if (!warnedUnmatchedGenotypes.has(run.genotype)) {
      warnedUnmatchedGenotypes.add(run.genotype);
      console.warn(
        `[export] Run genotype "${run.genotype}" does not match any of this assay's ` +
        `declared genotypes (${genotypes.join(", ")}) — its data is omitted from this export.`
      );
    }
  });

  // Sort and (for pooled views) assign a sequential global animal index.
  genotypes.forEach(g => {
    if (isPooled) {
      runsByGenotype[g].sort((a, b) =>
        a.trialIndex - b.trialIndex || a.animalIndex - b.animalIndex
      );
      runsByGenotype[g].forEach((run, i) => { run.globalAnimalIndex = i + 1; });
    } else {
      runsByGenotype[g].sort((a, b) => a.animalIndex - b.animalIndex);
      // A failed attempt and its successful retry share the same animalIndex
      // by design (see startRun() — only completed && eligibleForAnalysis
      // runs advance the counter), so both would otherwise render as
      // identical "Animal N" columns in the per-trial raw/binned exports,
      // distinguishable only by cross-referencing the Run Status row.
      // Tag every run after the first with the same index so callers can
      // append a disambiguating "(retry N)" suffix to the label.
      const seenCount = new Map();
      runsByGenotype[g].forEach(run => {
        const count = (seenCount.get(run.animalIndex) ?? 0) + 1;
        seenCount.set(run.animalIndex, count);
        run.animalLabelSuffix = count > 1 ? ` (retry ${count - 1})` : "";
      });
    }
  });

  return runsByGenotype;
}

/**
 * Formats the "Manual Override" cell for a run — empty string if the run's
 * eligibility was never manually overridden, otherwise a note documenting
 * the effective decision, the original automatic determination, and any
 * free-text reason the user entered.
 *
 * @param {Object} run - A run object (may have manuallyOverridden/overrideReason/
 *   autoEligibleForAnalysis/autoIneligibleReason fields).
 * @returns {string}
 */
function formatOverrideNote(run) {
  if (!run.manuallyOverridden) return "";
  const autoPart = run.autoEligibleForAnalysis
    ? "auto: eligible"
    : `auto: ${run.autoIneligibleReason ?? "ineligible"}`;
  const notePart = run.overrideReason ? ` — ${run.overrideReason}` : "";
  return `Manually marked ${run.eligibleForAnalysis ? "ELIGIBLE" : "INELIGIBLE"} (${autoPart})${notePart}`;
}

/**
 * True if every cell after the row label is blank. Used to drop optional QC
 * descriptor rows (Partial Bin Warning / Ineligible Reason / Manual Override)
 * entirely when nothing in the trial/pool actually has one — otherwise they
 * render as full header-styled rows with nothing in them in the common
 * (no-issues) case, in every raw/binned/TI sheet and the preview modal.
 *
 * @param {any[]} row - A header/descriptor row, e.g. ["Manual Override", "", "", ...].
 * @returns {boolean}
 */
function isDescriptorRowEmpty(row) {
  return row.slice(1).every(cell => cell === "" || cell == null);
}

/**
 * Calculates the arithmetic mean and Standard Error of the Mean (SEM)
 * for an array of numbers.
 *
 * Returns empty strings when the input is empty or undefined, so that
 * spreadsheet cells show blank rather than NaN.
 *
 * @param {number[]} values - Numeric values (e.g. binned percentages for one genotype).
 * @returns {{ mean: number|string, sem: number|string }}
 */
function calculateStats(values) {
  if (!values || values.length === 0) return { mean: "", sem: "" };

  const n    = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;

  // SEM is undefined for a single observation — return blank so the
  // exported cell shows nothing rather than 0 (which implies zero spread).
  if (n === 1) return { mean, sem: "" };

  // Use sample variance (Bessel's correction, divide by n-1) instead of
  // population variance (divide by n). Population variance systematically underestimates
  // SEM for small n, which is the typical case in biological experiments.
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1);
  const sem      = Math.sqrt(variance) / Math.sqrt(n);

  return { mean, sem };
}

/**
 * Pre-computes binned percentages and Touch Index arrays for a flat list of
 * runs, storing results in a Map keyed by run object.
 *
 * Used by buildAllSections() to share a single binning pass across all pooled
 * sub-tables for the same config, avoiding redundant computation.
 *
 * @param {Object[]} runs    - Flat array of run objects.
 * @param {number}   binSize - Number of stimuli per bin.
 * @returns {Map<Object, { binned: number[], ti: number[]|null }>}
 */
function buildRunCache(runs, binSize) {
  const cache = new Map();
  runs.forEach(run => {
    const binned = binRunValues(run.values, binSize);
    cache.set(run, { binned, ti: computeTouchIndexBins(binned) });
  });
  return cache;
}


/* ==========================================================================
   Layout & Formatting Helpers
   ========================================================================== */

/**
 * Applies column widths and text-wrap cell styles to a SheetJS worksheet.
 * The first column (labels) gets extra width; all others get equal narrower width.
 *
 * @param {Object}  sheet - A SheetJS worksheet object (mutated in place).
 * @param {any[][]} data  - The 2D array that was used to create the sheet.
 */
export function applySheetLayout(sheet, data) {
  // Data may be empty (e.g. a trial with no runs). Guard before
  // accessing data[0] to avoid "Cannot read properties of undefined (reading 'map')".
  if (!data || data.length === 0) return;

  // Set column widths
  sheet["!cols"] = data[0].map((_, colIndex) => (
    colIndex === 0 ? { wch: 22 } : { wch: 10 }
  ));

  // Enable word-wrap on every cell
  Object.keys(sheet).forEach(addr => {
    if (addr[0] === "!") return;  // Skip SheetJS metadata keys
    const cell = sheet[addr];
    cell.s = cell.s || {};
    cell.s.alignment = { wrapText: true };
  });
}

/**
 * Builds the assay-level metadata 2D array (shown on the first Excel sheet
 * and at the top of the HTML preview).
 *
 * Includes both createdAt and lastModifiedAt.
 *
 * @param {Assay} assay - The assay configuration object.
 * @returns {any[][]} Two-column table: [parameter, value].
 */
export function buildMetadata2D(assay) {
  return [
    ["Parameter",                    "Value"],
    ["Experiment ID",                assay.assayName],
    ["Date Created",                 formatDateTime(assay.createdAt)],
    ["Last Modified",                assay.lastModifiedAt ? formatDateTime(assay.lastModifiedAt) : "N/A"],
    ["Genotypes",                    Array.isArray(assay.genotypes) ? assay.genotypes.join(", ") : "N/A"],
    ["Temperature",                  assay.temperature !== undefined ? `${assay.temperature} °C` : "N/A"],
    ["Humidity",                     assay.humidity    !== undefined ? `${assay.humidity} % RH`  : "N/A"],
    ["Inter-stimulus Interval (s)",  assay.isi],
    ["Number of Stimulations",       assay.stimCount],
    ["Bin Size",                     assay.binSize]
  ];
}

// First-cell labels that mark a row as a header/descriptor row in the preview
// table — covers every row type produced by buildTrialRaw2D/buildTrialBinned2D
// /buildTrialTouchIndexBinned2D and their pooled equivalents.
//
// Also doubles as the "known header row" vocabulary injectLiveFormulas() uses
// to walk a finished table and find the raw-value rows sandwiched between
// them — every label added here must stay a single fixed row, since a
// "Bin N (...)" per-bin row (deliberately NOT in this set) is what the
// scanner treats as raw data to reference from a formula.
const HTML_PREVIEW_HEADER_LABELS = new Set([
  "Bin", "Genotype", "Animal", "Trial", "Trial Animal", "Run Status",
  "Eligible", "Partial Bin Warning", "Ineligible Reason", "Manual Override"
]);

/**
 * Renders a 2D data array as an HTML table for the preview modal.
 * The first row and any row whose first cell is a known header/descriptor
 * label (see HTML_PREVIEW_HEADER_LABELS) are rendered as <th> header cells.
 *
 * Eligibility gets one extra treatment on top of that generic rule: the
 * positive ("Yes" / `true`) state — whether expressed as a whole wide-format
 * "Eligible" row or a single tidy-format "Eligible" column — renders as a
 * green pill (reusing .status-pill--good, the same visual language as the
 * live progress table), so a QC pass is a visual scan rather than reading
 * every cell. Every other state (blank, `false`, or an unrelated spacer
 * column between genotypes) is deliberately left as plain text/blank —
 * a wide table's blank Eligible cell is ambiguous with a spacer column, so
 * only the unambiguous positive signal gets highlighted.
 *
 * @param {string}  [title]  - Section heading displayed above the table. Omit
 *   to render the table alone with no <h3> — used when the caller (an
 *   accordion <summary>) already shows the section name.
 * @param {any[][]} data2D - The 2D array to render.
 * @returns {string} HTML string for this section. Empty string if data is empty.
 */
export function buildHtmlTableFrom2D(title, data2D) {
  if (!data2D || data2D.length === 0) return "";

  // Use the imported escapeHTML() — previously a hand-rolled replacement
  // only covered &, <, > — omitting " and ' which escapeHTML handles correctly.
  const titleHtml = title ? `<h3>${escapeHTML(title)}</h3>` : "";

  // Column index of a tidy-format "Eligible" column, if this table has one —
  // its header row literally lists "Eligible" among several column names.
  // Always -1 (no match, never a false positive) for wide-format tables,
  // whose row 0 is always a Genotype/Trial header with no such column.
  const eligibleColIndex = data2D[0]?.indexOf("Eligible") ?? -1;

  let html = `<div class="preview-section">${titleHtml}` +
             `<div class="preview-table-wrapper"><table><tbody>`;

  data2D.forEach((row, rowIndex) => {
    // Render empty rows as spacer rows
    if (!row || row.length === 0) {
      html += `<tr><td colspan="100%" style="height:1.5rem;border:none;"></td></tr>`;
      return;
    }

    const isEligibleRow = row[0] === "Eligible";  // wide-format case
    const isHeaderRow    = rowIndex === 0 || HTML_PREVIEW_HEADER_LABELS.has(row[0]);
    const tag            = isHeaderRow ? "th" : "td";

    html += "<tr>";
    row.forEach((cell, colIndex) => {
      const content  = (cell === null || cell === undefined || cell === "") ? "" : cell;
      const isNumeric = typeof content === "number";

      const isEligibleCell = (isEligibleRow && colIndex > 0) || colIndex === eligibleColIndex;
      let displayValue;
      if (isEligibleCell && (content === "Yes" || content === true)) {
        displayValue = `<span class="status-pill status-pill--good">✓ Yes</span>`;
      } else if (isNumeric) {
        // Numeric values are converted via String() before being placed
        // in innerHTML. Number-derived strings cannot contain HTML-injectable characters
        // (only digits, '.', '-', 'e') so this path is safe. The String() wrapper is
        // explicit to document the assumption and catch exotic Number subclasses.
        displayValue = String(Number.isInteger(content) ? content : content.toFixed(2));
      } else if (content === true) {
        displayValue = "Yes";
      } else if (content === false) {
        displayValue = "No";
      } else {
        displayValue = escapeHTML(content);  // Escape user-supplied strings to prevent XSS
      }

      // Numeric data (raw 0/1 grid, bin %, mean/SEM/N) gets the mono/tabular
      // treatment and stays centered; text values (genotype names, dates,
      // reasons) are left-aligned instead of centered — long strings like
      // "N2, mec-4(u253), unc-13" or a full timestamp read oddly centered.
      html += isHeaderRow
        ? `<${tag}>${displayValue}</${tag}>`
        : `<${tag} class="${isNumeric ? "cell-numeric" : "cell-text"}">${displayValue}</${tag}>`;
    });
    html += "</tr>";
  });

  html += "</tbody></table></div></div>";
  return html;
}

/**
 * Combines the three "analysed" sub-tables (percent binned, TI binned,
 * TI summary) into a single contiguous 2D array for one Excel sheet.
 * Tables are separated by two blank rows for readability.
 *
 * @param {{ percentAnalysed2D: any[][], tiBinned2D: any[][], tiAnalysed2D: any[][] }} tables
 * @returns {any[][]} Combined 2D array.
 */
export function buildTouchAnalysedSheet2D({ percentAnalysed2D, tiBinned2D, tiAnalysed2D }) {
  const out = [];

  function append(table) {
    if (!table || table.length === 0) return;
    if (out.length > 0) out.push([], []);  // Two blank separator rows
    table.forEach(row => out.push(row));
  }

  append(percentAnalysed2D);
  append(tiBinned2D);
  append(tiAnalysed2D);

  return out;
}

/**
 * Extracts per-genotype {bins, means, sems, ns} series from a table
 * containing a Mean/SEM/N summary block — a row whose first cell is
 * exactly "Bin", followed by `${genotype}_Mean`/`_SEM`/`_N` columns and one
 * row per bin after it. This is the shape every *Binned2D and
 * *TouchIndexAnalysed2D builder in this file produces (buildTrialBinned2D's
 * tail, buildPooledBinned2D's tail, buildTrialTouchIndexAnalysed2D,
 * buildPooledTouchIndexAnalysed2D) — the function only looks for that block
 * and reads forward from it, so it works whether `data2D` is one of those
 * standalone summary tables or a larger table with a summary block
 * somewhere inside it.
 *
 * Used to feed the preview modal's sparkline charts (see renderPreviewModal
 * in main.js) — never touches the Excel/CSV/HTML export paths.
 *
 * @param {any[][]} data2D
 * @returns {Object.<string, {bins:number[], means:(number|null)[], sems:number[], ns:number[]}>}
 *   Empty object if no "Bin" summary header row is found.
 */
export function extractBinSeries(data2D) {
  const headerRowIndex = data2D.findIndex(row => row && row[0] === "Bin");
  if (headerRowIndex === -1) return {};

  const header = data2D[headerRowIndex];
  const genotypeCols = [];  // [{ genotype, meanCol }]
  for (let col = 1; col < header.length; col += 3) {
    const meanLabel = header[col];
    if (typeof meanLabel === "string" && meanLabel.endsWith("_Mean")) {
      genotypeCols.push({ genotype: meanLabel.slice(0, -"_Mean".length), meanCol: col });
    }
  }

  const series = {};
  genotypeCols.forEach(({ genotype }) => { series[genotype] = { bins: [], means: [], sems: [], ns: [] }; });

  let binIndex = 0;
  for (let r = headerRowIndex + 1; r < data2D.length; r++) {
    const row = data2D[r];
    if (!row || row.length === 0 || row.every(c => c === "" || c == null)) break;  // end of this summary block

    binIndex++;
    genotypeCols.forEach(({ genotype, meanCol }) => {
      const s = series[genotype];
      s.bins.push(binIndex);
      s.means.push(typeof row[meanCol]   === "number" ? row[meanCol]   : null);
      s.sems.push(typeof row[meanCol+1]  === "number" ? row[meanCol+1] : 0);
      s.ns.push(typeof row[meanCol+2]    === "number" ? row[meanCol+2] : 0);
    });
  }

  return series;
}


/* ==========================================================================
   Trial-Level 2D Builders
   ========================================================================== */

/**
 * Builds the raw stimulus-by-stimulus table for a single trial.
 * Each column is one run; each row is one stimulus interval.
 *
 * Values: 1 = animal responded, 0 = did not respond (tap recorded).
 * Runs that did not complete the full protocol show empty cells for
 * stimulus indices beyond their recorded values.
 *
 * Includes Partial Bin Warning and Ineligible Reason header rows
 * so QC information is preserved in every raw export.
 *
 * @param {Trial} trial - A single trial object with a `runs` array.
 * @param {Assay} assay - The parent assay (provides stimCount and genotypes).
 * @returns {any[][]} 2D array: [genotypeRow, animalRow, statusRow, partialBinRow, ineligibleRow, ...stimulusRows]
 */
export function buildTrialRaw2D(trial, assay) {
  const { stimCount, genotypes } = assay;
  const runsByGenotype = groupAndSortRuns(trial.runs, genotypes, false);

  // Build the six header rows
  const headerGenotype   = ["Genotype"];
  const headerAnimal     = ["Animal"];
  const headerStatus     = ["Run Status"];
  const headerPartialBin = ["Partial Bin Warning"];
  const headerIneligible = ["Ineligible Reason"];
  const headerOverride   = ["Manual Override"];

  genotypes.forEach((g, gi) => {
    runsByGenotype[g].forEach(run => {
      headerGenotype.push(g);
      headerAnimal.push(`Animal ${run.animalIndex}${run.animalLabelSuffix ?? ""}`);
      headerStatus.push(RUN_STATUS_LABELS[run.status] ?? run.status);
      headerPartialBin.push(run.partialBinWarning ?? "");
      headerIneligible.push(run.ineligibleReason  ?? "");
      headerOverride.push(formatOverrideNote(run));
    });
    // Blank spacer column between genotypes (not after the last one)
    if (gi < genotypes.length - 1) {
      headerGenotype.push(""); headerAnimal.push(""); headerStatus.push("");
      headerPartialBin.push(""); headerIneligible.push(""); headerOverride.push("");
    }
  });

  // Build one row per stimulus
  const rows = [];
  for (let i = 0; i < stimCount; i++) {
    const row = [`Stimulus ${i + 1}`];
    genotypes.forEach((g, gi) => {
      runsByGenotype[g].forEach(run => {
        // Show blank if this run ended before reaching this stimulus
        // Guard against null/undefined values array (e.g. partial DB write)
        const vals = run.values ?? [];
        row.push(i < vals.length ? vals[i] : "");
      });
      if (gi < genotypes.length - 1) row.push("");
    });
    rows.push(row);
  }

  // Drop the optional QC rows entirely when nothing in this trial actually
  // has one — the common case — instead of rendering empty header-styled rows.
  const optionalHeaders = [headerPartialBin, headerIneligible, headerOverride]
    .filter(row => !isDescriptorRowEmpty(row));

  return [headerGenotype, headerAnimal, headerStatus, ...optionalHeaders, ...rows];
}

/**
 * Builds the binned percentage table for a single trial, with a summary
 * section showing mean ± SEM ± N per genotype per bin.
 *
 * @param {Trial} trial - A single trial object with a `runs` array.
 * @param {Assay} assay - The parent assay (provides genotypes and binSize).
 * @returns {any[][]} 2D array with raw bins then mean/SEM/N summary rows.
 */
export function buildTrialBinned2D(trial, assay) {
  const { genotypes, binSize } = assay;
  const runsByGenotype = groupAndSortRuns(trial.runs, genotypes, false);

  // Header rows. Unlike the optional QC rows below, "Eligible" is always
  // present (never dropped even when every run is eligible) — the live
  // Excel formulas injected by injectLiveFormulas() key off its row
  // position to filter the summary stats, so its presence/position must be
  // unconditional and predictable rather than data-dependent.
  const headerGenotype = ["Genotype"];
  const headerAnimal   = ["Animal"];
  const headerStatus   = ["Run Status"];
  const headerEligible = ["Eligible"];
  const headerOverride = ["Manual Override"];

  genotypes.forEach((g, gi) => {
    runsByGenotype[g].forEach(run => {
      headerGenotype.push(g);
      headerAnimal.push(`Animal ${run.animalIndex}${run.animalLabelSuffix ?? ""}`);
      headerStatus.push(RUN_STATUS_LABELS[run.status] ?? run.status);
      headerEligible.push(run.eligibleForAnalysis ? "Yes" : "");
      headerOverride.push(formatOverrideNote(run));
    });
    if (gi < genotypes.length - 1) {
      headerGenotype.push(""); headerAnimal.push(""); headerStatus.push("");
      headerEligible.push(""); headerOverride.push("");
    }
  });

  // Pre-compute binned values for every run
  const binnedByRun = new Map();
  let maxBinCount   = 0;
  trial.runs.forEach(run => {
    const bins = binRunValues(run.values, binSize);
    binnedByRun.set(run, bins);
    maxBinCount = Math.max(maxBinCount, bins.length);
  });

  // Build one raw row and one summary row per bin
  const rawRows     = [];
  const summaryRows = [];
  const summaryHeader = ["Bin"];
  genotypes.forEach(g => summaryHeader.push(`${g}_Mean`, `${g}_SEM`, `${g}_N`));

  for (let binIndex = 0; binIndex < maxBinCount; binIndex++) {
    const start    = binIndex * binSize + 1;
    const end      = start + binSize - 1;
    const binLabel = `Bin ${binIndex + 1} (${start}–${end})`;

    // Raw values row
    const rawRow = [binLabel];
    genotypes.forEach((g, gi) => {
      runsByGenotype[g].forEach(run => {
        const bins = binnedByRun.get(run);
        // Guard bins being undefined; consistent with optional chain in summary row
        rawRow.push(bins && binIndex < bins.length ? bins[binIndex] : "");
      });
      if (gi < genotypes.length - 1) rawRow.push("");
    });
    rawRows.push(rawRow);

    // Summary (mean ± SEM ± N) row
    /** @type {(string|number)[]} */
    const sumRow = [binLabel];
    genotypes.forEach(g => {
      const values = runsByGenotype[g]
        .filter(run => run.eligibleForAnalysis)  // Exclude ineligible runs from summary stats
        .map(run => binnedByRun.get(run)?.[binIndex])  // Optional chain: run may not be in map
        .filter(v => v !== undefined);
      const { mean, sem } = calculateStats(values);
      sumRow.push(mean, sem, values.length);
    });
    summaryRows.push(sumRow);
  }

  // Separator rows span the full header width so SheetJS column-width
  // detection sees a consistent row length.
  const _sep = Array(headerGenotype.length).fill("");

  // Drop the Manual Override row entirely when nothing in this trial was
  // overridden — the common case — instead of an empty header-styled row.
  const optionalHeaders = [headerOverride].filter(row => !isDescriptorRowEmpty(row));

  return [
    headerGenotype, headerAnimal, headerStatus, headerEligible, ...optionalHeaders,
    ...rawRows,
    _sep, _sep, _sep,
    summaryHeader,
    ...summaryRows
  ];
}

/**
 * Builds the Touch Index (binned, raw per-run values) table for a single trial.
 * Runs whose first bin is zero are excluded from TI analysis and flagged.
 *
 * @param {Trial} trial - A single trial object with a `runs` array.
 * @param {Assay} assay - The parent assay (provides genotypes and binSize).
 * @returns {any[][]} 2D array: [genotypeRow, animalRow, ...binRows]
 */
export function buildTrialTouchIndexBinned2D(trial, assay) {
  const { genotypes, binSize } = assay;
  const runsByGenotype = groupAndSortRuns(trial.runs, genotypes, false);

  const headerGenotype = ["Genotype"];
  const headerAnimal   = ["Animal"];
  const headerOverride = ["Manual Override"];

  genotypes.forEach((g, gi) => {
    runsByGenotype[g].forEach(run => {
      headerGenotype.push(g);
      headerAnimal.push(`Animal ${run.animalIndex}${run.animalLabelSuffix ?? ""}`);
      headerOverride.push(formatOverrideNote(run));
    });
    if (gi < genotypes.length - 1) {
      headerGenotype.push(""); headerAnimal.push(""); headerOverride.push("");
    }
  });

  // Compute Touch Index for each run; exclude those with a zero baseline
  const binnedByRun = new Map();
  let maxBinCount   = 0;

  trial.runs.filter(run => run.eligibleForAnalysis).forEach(run => {
    const binned = binRunValues(run.values, binSize);
    const ti     = computeTouchIndexBins(binned);
    // Runs where computeTouchIndexBins returns null (zero baseline) are
    // excluded from the TI map even though eligibleForAnalysis is true. This means
    // their column in the header will show all-blank cells in the body. The reason is
    // documented on the separate "Touch Index Exclusions" sheet generated by
    // collectTouchIndexExclusions().
    if (ti) {
      binnedByRun.set(run, ti);
      maxBinCount = Math.max(maxBinCount, ti.length);
    }
  });

  const rows = [];
  for (let binIndex = 0; binIndex < maxBinCount; binIndex++) {
    const start = binIndex * binSize + 1;
    const end   = start + binSize - 1;
    const row   = [`Bin ${binIndex + 1} (${start}–${end})`];

    genotypes.forEach((g, gi) => {
      runsByGenotype[g].forEach(run => {
        const bins = binnedByRun.get(run);
        row.push(bins && binIndex < bins.length ? bins[binIndex] : "");
      });
      if (gi < genotypes.length - 1) row.push("");
    });
    rows.push(row);
  }

  const optionalHeaders = [headerOverride].filter(row => !isDescriptorRowEmpty(row));
  return [headerGenotype, headerAnimal, ...optionalHeaders, ...rows];
}

/**
 * Builds the Touch Index summary (mean ± SEM ± N per genotype per bin) for a single trial.
 *
 * @param {Trial} trial - A single trial object with a `runs` array.
 * @param {Assay} assay - The parent assay (provides genotypes and binSize).
 * @returns {any[][]} 2D array: [header, ...summaryRows]
 */
export function buildTrialTouchIndexAnalysed2D(trial, assay) {
  const { genotypes, binSize } = assay;

  // Group Touch Index arrays by genotype (only non-excluded runs)
  const runsByGenotype = {};
  genotypes.forEach(g => (runsByGenotype[g] = []));

  trial.runs.filter(run => run.eligibleForAnalysis).forEach(run => {
    const binned = binRunValues(run.values, binSize);
    const ti     = computeTouchIndexBins(binned);
    // Excluded runs (null TI) are silently omitted; collectTouchIndexExclusions handles them.
    if (ti && runsByGenotype[run.genotype]) {
      runsByGenotype[run.genotype].push(ti);
    }
  });

  // Filter out undefined/null entries before spreading into Math.max.
  // If runsByGenotype has an empty genotype bucket, the flat() produces no elements
  // and Math.max(0) = 0, which is correct. However, if any element of the flat
  // array is undefined (e.g. from a corrupted TI array), Math.max propagates NaN,
  // silently producing a zero-row table. The .filter(Boolean) (equivalent to
  // .filter(n => n != null)) makes the fallback-to-0 explicit and robust.
  const maxBinCount = Math.max(
    ...Object.values(runsByGenotype).flat().map(r => r.length).filter(n => n != null),
    0
  );

  const header = ["Bin"];
  genotypes.forEach(g => header.push(`${g}_Mean`, `${g}_SEM`, `${g}_N`));

  const rows = [];
  for (let binIndex = 0; binIndex < maxBinCount; binIndex++) {
    const start = binIndex * binSize + 1;
    const end   = start + binSize - 1;
    /** @type {(string|number)[]} */
    const row   = [`Bin ${binIndex + 1} (${start}–${end})`];

    genotypes.forEach(g => {
      // Filter out undefined entries (from runs with fewer bins)
      const values        = runsByGenotype[g].map(r => r[binIndex]).filter(v => v != null);
      const { mean, sem } = calculateStats(values);
      row.push(mean, sem, values.length);
    });
    rows.push(row);
  }

  return [header, ...rows];
}


/* ==========================================================================
   Trial-Level Tidy (Long-Format) Builders

   One row per (run, observation) instead of one column per run — the shape
   R (ggplot2/lme4), Python (pandas/statsmodels), and similar tools expect
   natively, letting the analysis tool itself group/filter/pivot instead of
   needing to un-pivot the wide grid above first. Additive: included
   alongside the wide-format sections above when requested (see the
   includeTidy option on buildAllSections), never replacing them.

   Every run is included regardless of eligibility, matching the raw wide
   tables' QC-transparency rationale — filter on the Eligible column
   downstream for an eligible-only analysis. Rows stop at each run's own
   recorded length rather than padding to assay.stimCount with blanks, since
   there is no column alignment to preserve in a long table.
   ========================================================================== */

/**
 * Builds a tidy raw-observation table for a single trial: one row per
 * (run, stimulus).
 *
 * @param {Trial} trial
 * @param {Assay} assay
 * @returns {any[][]} [header, ...rows], each row one recorded stimulus.
 */
export function buildTrialRawTidy2D(trial, assay) {
  const { genotypes } = assay;
  const runsByGenotype = groupAndSortRuns(trial.runs, genotypes, false);
  const rows = [["Trial", "Genotype", "Animal", "RunID", "RunStatus", "Eligible", "StimulusIndex", "Value"]];

  genotypes.forEach(g => {
    runsByGenotype[g].forEach(run => {
      (run.values ?? []).forEach((v, i) => {
        rows.push([
          trial.trialIndex, g, `Animal ${run.animalIndex}${run.animalLabelSuffix ?? ""}`, run.runId,
          RUN_STATUS_LABELS[run.status] ?? run.status, !!run.eligibleForAnalysis, i + 1, v
        ]);
      });
    });
  });

  return rows;
}

/**
 * Builds a tidy binned-observation table for a single trial: one row per
 * (run, bin), combining binned response percentage and Touch Index in the
 * same row since both are bin-level and computed together.
 *
 * TouchIndex is blank for ineligible runs and for runs excluded from Touch
 * Index analysis (zero baseline bin) — mirrors buildTrialTouchIndexBinned2D
 * exactly. BinnedPercent has no such exclusion; it's populated for every
 * run regardless of eligibility, same as the raw wide grid.
 *
 * @param {Trial} trial
 * @param {Assay} assay
 * @returns {any[][]} [header, ...rows], each row one bin of one run.
 */
export function buildTrialBinnedTidy2D(trial, assay) {
  const { genotypes, binSize } = assay;
  const runsByGenotype = groupAndSortRuns(trial.runs, genotypes, false);
  const rows = [[
    "Trial", "Genotype", "Animal", "RunID", "RunStatus", "Eligible",
    "BinIndex", "BinStart", "BinEnd", "BinnedPercent", "TouchIndex"
  ]];

  genotypes.forEach(g => {
    runsByGenotype[g].forEach(run => {
      const binned = binRunValues(run.values, binSize);
      const ti     = run.eligibleForAnalysis ? computeTouchIndexBins(binned) : null;

      binned.forEach((pct, i) => {
        const start = i * binSize + 1;
        const end   = start + binSize - 1;
        rows.push([
          trial.trialIndex, g, `Animal ${run.animalIndex}${run.animalLabelSuffix ?? ""}`, run.runId,
          RUN_STATUS_LABELS[run.status] ?? run.status, !!run.eligibleForAnalysis,
          i + 1, start, end, pct, ti ? ti[i] : ""
        ]);
      });
    });
  });

  return rows;
}


/* ==========================================================================
   Pooled (Cross-Trial) 2D Builders
   ========================================================================== */

/**
 * Builds the raw stimulus-by-stimulus table across all selected trials (pooled).
 * Identical structure to buildTrialRaw2D but spans multiple trials, adding
 * Trial and Trial Animal header rows.
 *
 * Includes Partial Bin Warning and Ineligible Reason header rows.
 * Accepts pre-collected runs via optional _runs parameter to avoid re-querying
 * when called from buildAllSections.
 *
 * @param {Assay}    assay    - The full assay object.
 * @param {Object}   [options]- Filter options passed to collectPooledRuns.
 * @param {Run[]}    [_runs]  - Pre-collected runs (optional, avoids re-querying).
 * @returns {any[][]} 2D array with seven header rows then stimulus rows.
 */
export function buildPooledRaw2D(assay, options = {}, _runs = null) {
  const { stimCount, genotypes } = assay;
  const runs           = _runs || collectPooledRuns(assay, options);
  const runsByGenotype = groupAndSortRuns(runs, genotypes, true);

  // Eight header rows for pooled view
  const hGenotype    = ["Genotype"];
  const hAnimal      = ["Animal"];
  const hTrial       = ["Trial"];
  const hTrialAnimal = ["Trial Animal"];
  const hStatus      = ["Run Status"];
  const hPartialBin  = ["Partial Bin Warning"];
  const hIneligible  = ["Ineligible Reason"];
  const hOverride    = ["Manual Override"];

  genotypes.forEach((g, gi) => {
    runsByGenotype[g].forEach(run => {
      hGenotype.push(g);
      hAnimal.push(`Animal ${run.globalAnimalIndex}`);
      hTrial.push(`Trial ${run.trialIndex}`);
      hTrialAnimal.push(`Animal ${run.animalIndex}`);
      hStatus.push(RUN_STATUS_LABELS[run.status] ?? run.status);
      hPartialBin.push(run.partialBinWarning ?? "");
      hIneligible.push(run.ineligibleReason  ?? "");
      hOverride.push(formatOverrideNote(run));
    });
    if (gi < genotypes.length - 1) {
      [hGenotype, hAnimal, hTrial, hTrialAnimal, hStatus, hPartialBin, hIneligible, hOverride]
        .forEach(h => h.push(""));
    }
  });

  const rows = [];
  for (let i = 0; i < stimCount; i++) {
    const row = [`Stimulus ${i + 1}`];
    genotypes.forEach((g, gi) => {
      runsByGenotype[g].forEach(run => {
        // Guard against null/undefined values array (e.g. partial DB write)
        const vals = run.values ?? [];
        row.push(i < vals.length ? vals[i] : "");
      });
      if (gi < genotypes.length - 1) row.push("");
    });
    rows.push(row);
  }

  const optionalHeaders = [hPartialBin, hIneligible, hOverride].filter(row => !isDescriptorRowEmpty(row));
  return [hGenotype, hAnimal, hTrial, hTrialAnimal, hStatus, ...optionalHeaders, ...rows];
}

/**
 * Builds the pooled binned percentage table with mean ± SEM ± N summary rows.
 *
 * Accepts pre-collected runs and a pre-built binning cache to avoid redundant
 * computation when called from buildAllSections.
 *
 * @param {Assay}    assay    - The full assay object.
 * @param {Object}   [options]- Filter options.
 * @param {Run[]}    [_runs]  - Pre-collected runs (optional).
 * @param {Map}      [_cache] - Pre-built run cache from buildRunCache (optional).
 * @returns {any[][]} 2D array with header rows, raw bin rows, and summary rows.
 */
export function buildPooledBinned2D(assay, options = {}, _runs = null, _cache = null) {
  const { genotypes, binSize } = assay;
  const runs           = _runs || collectPooledRuns(assay, options);
  const runsByGenotype = groupAndSortRuns(runs, genotypes, true);

  const hGenotype    = ["Genotype"];
  const hAnimal      = ["Animal"];
  const hTrial       = ["Trial"];
  const hTrialAnimal = ["Trial Animal"];
  const hStatus      = ["Run Status"];
  // Always present (see the comment in buildTrialBinned2D) — the live Excel
  // formulas injected by injectLiveFormulas() key off this row's position.
  const hEligible    = ["Eligible"];
  const hOverride    = ["Manual Override"];

  genotypes.forEach((g, gi) => {
    runsByGenotype[g].forEach(run => {
      hGenotype.push(g);
      hAnimal.push(`Animal ${run.globalAnimalIndex}`);
      hTrial.push(`Trial ${run.trialIndex}`);
      hTrialAnimal.push(`Animal ${run.animalIndex}`);
      hStatus.push(RUN_STATUS_LABELS[run.status] ?? run.status);
      hEligible.push(run.eligibleForAnalysis ? "Yes" : "");
      hOverride.push(formatOverrideNote(run));
    });
    if (gi < genotypes.length - 1) {
      [hGenotype, hAnimal, hTrial, hTrialAnimal, hStatus, hEligible, hOverride].forEach(h => h.push(""));
    }
  });

  // Use provided cache or build one locally
  const binnedByRun = new Map();
  let maxBinCount   = 0;

  if (_cache) {
    _cache.forEach(({ binned }, run) => {
      binnedByRun.set(run, binned);
      maxBinCount = Math.max(maxBinCount, binned.length);
    });
  } else {
    runs.forEach(run => {
      const bins = binRunValues(run.values, binSize);
      binnedByRun.set(run, bins);
      maxBinCount = Math.max(maxBinCount, bins.length);
    });
  }

  const rawRows     = [];
  const summaryRows = [];
  const summaryHeader = ["Bin"];
  genotypes.forEach(g => summaryHeader.push(`${g}_Mean`, `${g}_SEM`, `${g}_N`));

  for (let binIndex = 0; binIndex < maxBinCount; binIndex++) {
    const start    = binIndex * binSize + 1;
    const end      = start + binSize - 1;
    const binLabel = `Bin ${binIndex + 1} (${start}–${end})`;

    // Raw row
    const rawRow = [binLabel];
    genotypes.forEach((g, gi) => {
      runsByGenotype[g].forEach(run => {
        const bins = binnedByRun.get(run);
        rawRow.push(bins && binIndex < bins.length ? bins[binIndex] : "");
      });
      if (gi < genotypes.length - 1) rawRow.push("");
    });
    rawRows.push(rawRow);

    // Summary row
    /** @type {(string|number)[]} */
    const sumRow = [binLabel];
    genotypes.forEach(g => {
      const values = runsByGenotype[g]
        .filter(run => run.eligibleForAnalysis)  // Exclude ineligible runs from summary stats
        .map(run => binnedByRun.get(run)?.[binIndex])
        .filter(v => v !== undefined);
      const { mean, sem } = calculateStats(values);
      sumRow.push(mean, sem, values.length);
    });
    summaryRows.push(sumRow);
  }

  const optionalHeaders = [hOverride].filter(row => !isDescriptorRowEmpty(row));

  return [
    hGenotype, hAnimal, hTrial, hTrialAnimal, hStatus, hEligible, ...optionalHeaders,
    ...rawRows,
    // Separator rows must span the FULL header width (all run columns
    // plus the spacer columns between genotypes), not just the static header fields.
    // The old hardcoded fixed-width arrays caused SheetJS to detect fewer columns than the
    // data rows had, producing inconsistent column widths in the Excel preview for any
    // experiment with more than one run per genotype.
    ...Array(3).fill(Array(hGenotype.length).fill("")),
    summaryHeader,
    ...summaryRows
  ];
}

/**
 * Builds the pooled Touch Index (raw per-run) table across all selected trials.
 *
 * Accepts pre-collected runs and a pre-built cache to avoid redundant
 * computation when called from buildAllSections.
 *
 * @param {Assay}    assay    - The full assay object.
 * @param {Object}   [options]- Filter options passed to collectPooledRuns.
 * @param {Run[]}    [_runs]  - Pre-collected runs (optional).
 * @param {Map}      [_cache] - Pre-built run cache (optional).
 * @returns {any[][]} 2D array: [genotypeRow, animalRow, ...binRows]
 */
export function buildPooledTouchIndexBinned2D(assay, options = {}, _runs = null, _cache = null) {
  const { genotypes, binSize } = assay;
  const runs           = _runs || collectPooledRuns(assay, options);
  const runsByGenotype = groupAndSortRuns(runs, genotypes, true);

  const headerGenotype = ["Genotype"];
  const headerAnimal   = ["Animal"];
  const headerOverride = ["Manual Override"];

  genotypes.forEach((g, gi) => {
    runsByGenotype[g].forEach(run => {
      headerGenotype.push(g);
      headerAnimal.push(`Animal ${run.globalAnimalIndex}`);
      headerOverride.push(formatOverrideNote(run));
    });
    if (gi < genotypes.length - 1) {
      headerGenotype.push(""); headerAnimal.push(""); headerOverride.push("");
    }
  });

  // Use provided cache or compute locally
  const tiBinnedByRun = new Map();
  let maxBinCount     = 0;

  if (_cache) {
    _cache.forEach(({ ti }, run) => {
      if (ti && run.eligibleForAnalysis) {  // Exclude ineligible runs from TI analysis
        tiBinnedByRun.set(run, ti);
        maxBinCount = Math.max(maxBinCount, ti.length);
      }
    });
  } else {
    runs.filter(run => run.eligibleForAnalysis).forEach(run => {
      const binned = binRunValues(run.values, binSize);
      const ti     = computeTouchIndexBins(binned);
      // Runs with a null TI (zero baseline) are excluded from the map.
      if (ti) {
        tiBinnedByRun.set(run, ti);
        maxBinCount = Math.max(maxBinCount, ti.length);
      }
    });
  }

  const rows = [];
  for (let binIndex = 0; binIndex < maxBinCount; binIndex++) {
    const start = binIndex * binSize + 1;
    const end   = start + binSize - 1;
    const row   = [`Bin ${binIndex + 1} (${start}–${end})`];

    genotypes.forEach((g, gi) => {
      runsByGenotype[g].forEach(run => {
        const bins = tiBinnedByRun.get(run);
        row.push(bins && binIndex < bins.length ? bins[binIndex] : "");
      });
      if (gi < genotypes.length - 1) row.push("");
    });
    rows.push(row);
  }

  const optionalHeaders = [headerOverride].filter(row => !isDescriptorRowEmpty(row));
  return [headerGenotype, headerAnimal, ...optionalHeaders, ...rows];
}

/**
 * Builds the pooled Touch Index summary (mean ± SEM ± N per genotype per bin).
 *
 * Accepts pre-collected runs and a pre-built cache to avoid redundant
 * computation when called from buildAllSections.
 *
 * @param {Assay}    assay    - The full assay object.
 * @param {Object}   [options]- Filter options passed to collectPooledRuns.
 * @param {Run[]}    [_runs]  - Pre-collected runs (optional).
 * @param {Map}      [_cache] - Pre-built run cache (optional).
 * @returns {any[][]} 2D array: [header, ...summaryRows]
 */
export function buildPooledTouchIndexAnalysed2D(assay, options = {}, _runs = null, _cache = null) {
  const { genotypes, binSize } = assay;
  const runs = _runs || collectPooledRuns(assay, options);

  // Group TI arrays by genotype (only non-excluded runs contribute)
  const tiByGenotype = {};
  genotypes.forEach(g => (tiByGenotype[g] = []));

  if (_cache) {
    runs.filter(run => run.eligibleForAnalysis).forEach(run => {
      const entry = _cache.get(run);
      if (entry?.ti && tiByGenotype[run.genotype]) {
        tiByGenotype[run.genotype].push(entry.ti);
      }
    });
  } else {
    runs.filter(run => run.eligibleForAnalysis).forEach(run => {
      const binned = binRunValues(run.values, binSize);
      const ti     = computeTouchIndexBins(binned);
      // Excluded runs (null TI) are silently omitted.
      if (ti && tiByGenotype[run.genotype]) {
        tiByGenotype[run.genotype].push(ti);
      }
    });
  }

  // Same pattern as buildTrialTouchIndexAnalysed2D: filter out
  // undefined/null lengths before spreading so NaN cannot silently produce zero rows.
  const maxBinCount = Math.max(
    ...Object.values(tiByGenotype).flat().map(r => r.length).filter(n => n != null),
    0
  );

  const header = ["Bin"];
  genotypes.forEach(g => header.push(`${g}_Mean`, `${g}_SEM`, `${g}_N`));

  const rows = [];
  for (let binIndex = 0; binIndex < maxBinCount; binIndex++) {
    const start = binIndex * binSize + 1;
    const end   = start + binSize - 1;
    /** @type {(string|number)[]} */
    const row   = [`Bin ${binIndex + 1} (${start}–${end})`];

    genotypes.forEach(g => {
      const values        = tiByGenotype[g].map(r => r[binIndex]).filter(v => v != null);
      const { mean, sem } = calculateStats(values);
      row.push(mean, sem, values.length);
    });
    rows.push(row);
  }

  return [header, ...rows];
}


/* ==========================================================================
   Pooled Tidy (Long-Format) Builders

   Same rationale and conventions as the Trial-Level Tidy builders above —
   see that section's banner comment. The only structural difference is an
   extra TrialAnimal column: "Animal" here is the pooled globalAnimalIndex
   (unique across the whole pool), while TrialAnimal is the original
   per-trial animalIndex, mirroring how buildPooledRaw2D distinguishes
   "Animal" from "Trial Animal".
   ========================================================================== */

/**
 * Builds a tidy raw-observation table across all selected trials (pooled):
 * one row per (run, stimulus).
 *
 * @param {Assay}  assay
 * @param {Object} [options]  - Filter options passed to collectPooledRuns.
 * @param {Run[]}  [_runs]    - Pre-collected runs (optional, avoids re-querying).
 * @returns {any[][]} [header, ...rows], each row one recorded stimulus.
 */
export function buildPooledRawTidy2D(assay, options = {}, _runs = null) {
  const { genotypes } = assay;
  const runs           = _runs || collectPooledRuns(assay, options);
  const runsByGenotype = groupAndSortRuns(runs, genotypes, true);
  const rows = [[
    "Trial", "Genotype", "Animal", "TrialAnimal", "RunID", "RunStatus", "Eligible", "StimulusIndex", "Value"
  ]];

  genotypes.forEach(g => {
    runsByGenotype[g].forEach(run => {
      (run.values ?? []).forEach((v, i) => {
        rows.push([
          run.trialIndex, g, `Animal ${run.globalAnimalIndex}`, `Animal ${run.animalIndex}`, run.runId,
          RUN_STATUS_LABELS[run.status] ?? run.status, !!run.eligibleForAnalysis, i + 1, v
        ]);
      });
    });
  });

  return rows;
}

/**
 * Builds a tidy binned-observation table across all selected trials
 * (pooled): one row per (run, bin), combining binned response percentage
 * and Touch Index in the same row.
 *
 * Accepts a pre-built run cache (see buildRunCache) to avoid redundant
 * binning when called from buildAllSections alongside the wide pooled
 * builders, which already compute the same cache.
 *
 * @param {Assay}  assay
 * @param {Object} [options]  - Filter options passed to collectPooledRuns.
 * @param {Run[]}  [_runs]    - Pre-collected runs (optional).
 * @param {Map}    [_cache]   - Pre-built run cache from buildRunCache (optional).
 * @returns {any[][]} [header, ...rows], each row one bin of one run.
 */
export function buildPooledBinnedTidy2D(assay, options = {}, _runs = null, _cache = null) {
  const { genotypes, binSize } = assay;
  const runs           = _runs || collectPooledRuns(assay, options);
  const runsByGenotype = groupAndSortRuns(runs, genotypes, true);
  const rows = [[
    "Trial", "Genotype", "Animal", "TrialAnimal", "RunID", "RunStatus", "Eligible",
    "BinIndex", "BinStart", "BinEnd", "BinnedPercent", "TouchIndex"
  ]];

  genotypes.forEach(g => {
    runsByGenotype[g].forEach(run => {
      const cached = _cache?.get(run);
      const binned = cached ? cached.binned : binRunValues(run.values, binSize);
      const ti     = run.eligibleForAnalysis ? (cached ? cached.ti : computeTouchIndexBins(binned)) : null;

      binned.forEach((pct, i) => {
        const start = i * binSize + 1;
        const end   = start + binSize - 1;
        rows.push([
          run.trialIndex, g, `Animal ${run.globalAnimalIndex}`, `Animal ${run.animalIndex}`, run.runId,
          RUN_STATUS_LABELS[run.status] ?? run.status, !!run.eligibleForAnalysis,
          i + 1, start, end, pct, ti ? ti[i] : ""
        ]);
      });
    });
  });

  return rows;
}


/* ==========================================================================
   Master Section Builder
   ========================================================================== */

/**
 * Builds a flat, ordered array of export sections for every selected dataset.
 * Always produces: Assay Metadata first, then trial/pooled sections in config
 * order, then Touch Index Exclusions (if any excluded runs exist).
 *
 * This is the single source of truth consumed by performExcelExport and
 * performCSVExport, eliminating ~100 lines of duplicated looping logic. The
 * preview modal (see renderPreviewModal in main.js) also builds directly off
 * this array, rendering each section's HTML itself via buildHtmlTableFrom2D
 * rather than through a single pre-concatenated string, so it can lazily
 * render/collapse/cap individual sections instead of injecting everything
 * into the DOM at once.
 *
 * For pooled configs, collectPooledRuns is called once per config and a shared
 * binning cache is passed to all three pooled sub-table builders, avoiding
 * redundant binRunValues calls.
 *
 * @param {Object}   assay             - The full assay object.
 * @param {Object[]} exportConfigs     - Array of dataset selection configs from getExportConfigs().
 * @param {Object}   [options]
 * @param {boolean}  [options.includeTidy=false] - Also append a long/tidy-format
 *   pair of sections (Raw, Binned) after each trial/pooled config's existing
 *   wide-format sections — additive, never replaces them. Off by default so
 *   the existing Excel-first workflow is unaffected unless requested.
 * @returns {Array<{ name: string, excelSheetName: string, data2D: any[][], large?: boolean, charts?: Object }>}
 *   `large` marks Raw/Raw(Tidy)/Binned(Tidy) sections — one row per
 *   stimulus or per observation, potentially thousands of rows for a big
 *   pooled dataset — as opposed to the small, always-fully-shown
 *   Metadata/Analysed/Exclusions sections. Consumed only by the preview
 *   modal's default-collapse/row-cap behavior; the actual Excel/CSV export
 *   is never capped regardless of this flag.
 *   `charts` (Analysed sections only) is `{ percentResponse, touchIndex }`,
 *   each an extractBinSeries() result — feeds the preview modal's sparkline
 *   charts and is otherwise unused by the Excel/CSV/HTML export paths.
 */
export function buildAllSections(assay, exportConfigs, options = {}) {
  const { includeTidy = false } = options;
  const sections = [];

  // ── Metadata (always first) ──────────────────────────────────────────────
  sections.push({
    name:           "Assay Metadata",
    excelSheetName: "Assay_Metadata",
    data2D:         buildMetadata2D(assay)
  });

  exportConfigs.forEach(config => {

    // ── Per-trial sections ─────────────────────────────────────────────────
    if (config.type === "trial") {
      const trial = assay.trials.find(t => String(t.trialId) === String(config.trialId));
      if (!trial) return;

      sections.push({
        name:           `Trial ${trial.trialIndex} - Raw`,
        excelSheetName: `Trial_${trial.trialIndex}_Raw`,
        data2D:         buildTrialRaw2D(trial, assay),
        large:          true
      });
      {
        const percentBinned2D = buildTrialBinned2D(trial, assay);
        const tiAnalysed2D    = buildTrialTouchIndexAnalysed2D(trial, assay);
        sections.push({
          name:           `Trial ${trial.trialIndex} - Analysed`,
          excelSheetName: `Trial_${trial.trialIndex}_Analysed`,
          data2D:         buildTouchAnalysedSheet2D({
            percentAnalysed2D: percentBinned2D,
            tiBinned2D:        buildTrialTouchIndexBinned2D(trial, assay),
            tiAnalysed2D
          }),
          // Feeds the preview modal's sparkline charts (see renderPreviewModal
          // in main.js) — extracted from the same builder output used above,
          // before it's flattened into the HTML-oriented combined sheet.
          charts: {
            percentResponse: extractBinSeries(percentBinned2D),
            touchIndex:      extractBinSeries(tiAnalysed2D)
          }
        });
      }

      if (includeTidy) {
        sections.push({
          name:           `Trial ${trial.trialIndex} - Raw (Tidy)`,
          excelSheetName: `Trial_${trial.trialIndex}_RawTidy`,
          data2D:         buildTrialRawTidy2D(trial, assay),
          large:          true
        });
        sections.push({
          name:           `Trial ${trial.trialIndex} - Binned (Tidy)`,
          excelSheetName: `Trial_${trial.trialIndex}_BinnedTidy`,
          data2D:         buildTrialBinnedTidy2D(trial, assay),
          large:          true
        });
      }
    }

    // ── Pooled (cross-trial) sections ──────────────────────────────────────
    if (config.type === "pooled") {
      const suffix   = config.includeAbandoned ? "All Trials"  : "Completed Trials";
      const xlSuffix = config.includeAbandoned ? "AllTrials"   : "CompletedTrials";
      const poolOpt  = { includeAbandoned: config.includeAbandoned };

      // Collect runs once and build a shared binning cache for this config.
      const runs  = collectPooledRuns(assay, poolOpt);
      const cache = buildRunCache(runs, assay.binSize);

      sections.push({
        name:           `Pooled (${suffix}) - Raw`,
        excelSheetName: `Pooled_${xlSuffix}_Raw`,
        data2D:         buildPooledRaw2D(assay, poolOpt, runs),
        large:          true
      });
      {
        const percentBinned2D = buildPooledBinned2D(assay, poolOpt, runs, cache);
        const tiAnalysed2D    = buildPooledTouchIndexAnalysed2D(assay, poolOpt, runs, cache);
        sections.push({
          name:           `Pooled (${suffix}) - Analysed`,
          excelSheetName: `Pooled_${xlSuffix}_Analysed`,
          data2D:         buildTouchAnalysedSheet2D({
            percentAnalysed2D: percentBinned2D,
            tiBinned2D:        buildPooledTouchIndexBinned2D(assay, poolOpt, runs, cache),
            tiAnalysed2D
          }),
          charts: {
            percentResponse: extractBinSeries(percentBinned2D),
            touchIndex:      extractBinSeries(tiAnalysed2D)
          }
        });
      }

      if (includeTidy) {
        sections.push({
          name:           `Pooled (${suffix}) - Raw (Tidy)`,
          excelSheetName: `Pooled_${xlSuffix}_RawTidy`,
          data2D:         buildPooledRawTidy2D(assay, poolOpt, runs),
          large:          true
        });
        sections.push({
          name:           `Pooled (${suffix}) - Binned (Tidy)`,
          excelSheetName: `Pooled_${xlSuffix}_BinnedTidy`,
          data2D:         buildPooledBinnedTidy2D(assay, poolOpt, runs, cache),
          large:          true
        });
      }
    }
  });

  // ── Touch Index exclusions (appended only if any runs were excluded) ──────
  const tiExclusions = collectTouchIndexExclusions(assay);
  if (tiExclusions.length > 0) {
    sections.push({
      name:           "Touch Index Exclusions",
      excelSheetName: "TouchIndex_Exclusions",
      data2D:         [["Trial", "Genotype", "Animal", "Reason"], ...tiExclusions]
    });
  }

  return sections;
}


/* ==========================================================================
   Live Formulas (Excel only)

   Every Mean/SEM/N summary cell in a finished data2D currently holds a
   static number computed once in JS by calculateStats(). This section
   replaces those numbers with live Excel formulas referencing the raw
   values above them, so the workbook stays correct if a run is later
   excluded/included by editing a cell directly in Excel.

   This works by re-scanning a table's own row labels rather than by
   threading row/column bookkeeping out of every builder above — the raw
   header vocabulary (HTML_PREVIEW_HEADER_LABELS) and the "Genotype +
   spacer" column layout are already consistent conventions used throughout
   this file, so a table is fully self-describing. CSV export and the HTML
   preview are untouched: this only ever mutates a SheetJS sheet object
   built from data2D, never data2D itself.
   ========================================================================== */

/**
 * Scans a "Genotype" header row (built by the genotype+spacer pattern used
 * throughout this file — a genotype's name repeated once per run column,
 * with a single blank spacer column between genotypes) and groups
 * consecutive matching cells into 0-indexed, inclusive column ranges.
 * Column 0 (the row label) is always skipped.
 *
 * A genotype with zero runs never appears in the row at all (the
 * header-building loops simply push nothing for it), so it is absent from
 * the returned map entirely rather than mapping to an empty range.
 *
 * @param {any[]} headerGenotypeRow - A row whose first cell is "Genotype".
 * @returns {Object.<string, {start: number, end: number}>}
 */
function scanGenotypeColumnRanges(headerGenotypeRow) {
  const ranges = {};
  let col = 1;
  while (col < headerGenotypeRow.length) {
    const g = headerGenotypeRow[col];
    if (!g) { col++; continue; }  // Spacer column between genotypes.
    let end = col;
    while (end + 1 < headerGenotypeRow.length && headerGenotypeRow[end + 1] === g) end++;
    ranges[g] = { start: col, end };
    col = end + 1;
  }
  return ranges;
}

/**
 * True if every cell in a row is blank — used to distinguish the fixed-width
 * blank separator rows this file uses (both true zero-length rows and the
 * `Array(n).fill("")` rows inserted before a summary section) from an
 * ordinary data row.
 *
 * @param {any[]} row
 * @returns {boolean}
 */
function isBlankRow(row) {
  return !row || row.length === 0 || row.every(c => c === "" || c == null);
}

/**
 * Converts a 0-indexed column number to an Excel column letter
 * (0 -> "A", 25 -> "Z", 26 -> "AA", ...).
 *
 * A tiny local implementation rather than reaching for XLSX.utils.encode_col
 * so this whole live-formula module stays unit-testable in Node without the
 * SheetJS package — XLSX only ever exists as a browser global loaded from
 * the CDN <script> tag (see the typeof guard in performExcelExport), never
 * as a project dependency.
 *
 * @param {number} col - 0-indexed column number.
 * @returns {string}
 */
function encodeColumnLetter(col) {
  let letters = "";
  let n = col;
  while (n >= 0) {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  }
  return letters;
}

/**
 * Builds an "A1"-style cell address from 0-indexed row/column numbers.
 * @param {number} row
 * @param {number} col
 * @returns {string}
 */
function encodeCellAddress(row, col) {
  return `${encodeColumnLetter(col)}${row + 1}`;
}

/**
 * Writes live Mean/SEM/N formulas for one summary block (the rows
 * immediately following a "Bin" summary header) onto an already-built
 * SheetJS sheet, referencing the raw value rows recorded in `block`.
 *
 * Two formula shapes, chosen per genotype column range:
 *   - `block.eligibleRow` present (percent-response tables): ineligible
 *     runs' raw cells are still shown for QC, so the formula must filter by
 *     both the Eligible marker row AND non-blank value cells. Built from
 *     COUNTIFS/AVERAGEIFS (parallel-range conditional functions, not array
 *     formulas) plus a SUMPRODUCT-based conditional SEM, since Excel has no
 *     built-in STDEVIFS.
 *   - `block.eligibleRow` absent (Touch Index tables): exclusion is already
 *     blank-cell-encoded in the raw grid (see buildTrialTouchIndexBinned2D),
 *     so plain COUNT/AVERAGE/STDEV — which already ignore blanks — suffice.
 *
 * Every formula is guarded against N=0 (blank instead of #DIV/0!) and N=1
 * (blank SEM), mirroring calculateStats()'s own edge-case handling exactly.
 *
 * @param {Object}   sheet             - SheetJS worksheet (mutated in place).
 * @param {any[][]}  data2D            - The full table this block belongs to.
 * @param {number}   summaryHeaderRow  - Row index of the "Bin"/`_Mean`/... header.
 * @param {Object}   block             - { genotypeCols, eligibleRow, rawRowStart, rawRowEnd }.
 */
function applySummaryFormulas(sheet, data2D, summaryHeaderRow, block) {
  const { genotypeCols, eligibleRow, rawRowStart, rawRowEnd } = block;
  if (rawRowStart === null) return;  // No raw rows were seen for this block — nothing to reference.

  const summaryHeaderCells = data2D[summaryHeaderRow];

  for (let r = summaryHeaderRow + 1; r < data2D.length; r++) {
    if (isBlankRow(data2D[r])) break;  // End of this summary block.

    const rawRow = rawRowStart + (r - (summaryHeaderRow + 1));
    if (rawRow > rawRowEnd) break;  // No corresponding raw row left to reference.

    for (let col = 1; col < summaryHeaderCells.length; col += 3) {
      const meanLabel = summaryHeaderCells[col];
      if (typeof meanLabel !== "string" || !meanLabel.endsWith("_Mean")) continue;
      const genotype = meanLabel.slice(0, -"_Mean".length);
      const range    = genotypeCols[genotype];
      if (!range) continue;  // Genotype has zero runs in this table — leave the static "" as-is.

      const colStart = encodeColumnLetter(range.start);
      const colEnd   = encodeColumnLetter(range.end);
      const valRange = `${colStart}${rawRow + 1}:${colEnd}${rawRow + 1}`;  // +1: 0-indexed row -> 1-indexed Excel row.

      const meanAddr = encodeCellAddress(r, col);
      const semAddr  = encodeCellAddress(r, col + 1);
      const nAddr    = encodeCellAddress(r, col + 2);

      let nFormula, meanFormula, semFormula;

      if (eligibleRow !== null) {
        const elRange = `${colStart}${eligibleRow + 1}:${colEnd}${eligibleRow + 1}`;
        nFormula    = `COUNTIFS(${elRange},"Yes",${valRange},"<>")`;
        meanFormula = `IF(${nAddr}=0,"",AVERAGEIFS(${valRange},${elRange},"Yes"))`;
        semFormula  = `IF(${nAddr}<=1,"",SQRT(SUMPRODUCT((${elRange}="Yes")*(${valRange}<>"")*` +
                      `(${valRange}-${meanAddr})^2)/(${nAddr}-1))/SQRT(${nAddr}))`;
      } else {
        nFormula    = `COUNT(${valRange})`;
        meanFormula = `IF(${nAddr}=0,"",AVERAGE(${valRange}))`;
        semFormula  = `IF(${nAddr}<=1,"",STDEV(${valRange})/SQRT(${nAddr}))`;
      }

      // Cells already exist (aoa_to_sheet built them from the static JS
      // values) — .f is added alongside the existing cached .v so a viewer
      // that doesn't recalculate on open still shows the correct number.
      if (sheet[meanAddr]) sheet[meanAddr].f = meanFormula;
      if (sheet[semAddr])  sheet[semAddr].f  = semFormula;
      if (sheet[nAddr])    sheet[nAddr].f    = nFormula;
    }
  }
}

/**
 * Walks a finished data2D top-to-bottom, tracking the most recently seen
 * genotype-columned raw block, and calls applySummaryFormulas() every time
 * a "Bin" summary header row is found — wiring each summary section to the
 * raw rows that immediately precede it (across the blank separator rows
 * this file always inserts between a raw block and its summary).
 *
 * Safe to call on any sheet, including ones with no genotype/summary rows
 * at all (Assay Metadata, Touch Index Exclusions) — it simply does nothing
 * in that case.
 *
 * @param {Object}  sheet  - SheetJS worksheet (mutated in place).
 * @param {any[][]} data2D - The full table this sheet was built from.
 */
export function injectLiveFormulas(sheet, data2D) {
  let block = null;

  data2D.forEach((row, rowIndex) => {
    if (isBlankRow(row)) return;
    const label = row[0];

    if (label === "Genotype") {
      block = { genotypeCols: scanGenotypeColumnRanges(row), eligibleRow: null, rawRowStart: null, rawRowEnd: null };
      return;
    }

    if (!block) return;  // Not currently inside a tracked raw block.

    if (label === "Eligible") {
      block.eligibleRow = rowIndex;
      return;
    }

    if (label === "Bin") {
      // Exact match only — a per-bin raw row is labelled "Bin N (start–end)".
      applySummaryFormulas(sheet, data2D, rowIndex, block);
      block = null;  // This summary consumes the block; a later one must not reuse it.
      return;
    }

    if (HTML_PREVIEW_HEADER_LABELS.has(label)) return;  // Another known header row (Animal, Run Status, ...).

    // Anything else at this point is a raw data row ("Bin N (...)" or "Stimulus N").
    if (block.rawRowStart === null) block.rawRowStart = rowIndex;
    block.rawRowEnd = rowIndex;
  });
}


/* ==========================================================================
   Master Export Functions
   ========================================================================== */

/**
 * Orchestrates the creation of a multi-sheet Excel workbook and triggers
 * a browser file download.
 *
 * All sections are built via buildAllSections(), which also applies
 * the shared run-binning cache for pooled configs.
 *
 * Requires SheetJS (XLSX) to be loaded globally. If XLSX is unavailable,
 * the caller should use performCSVExport() instead.
 *
 * @param {Object}   currentAssay  - The full assay object.
 * @param {Object[]} exportConfigs - Array of dataset selection configs from getExportConfigs().
 * @param {Object}   [options]     - Passed through to buildAllSections() (see includeTidy there).
 * @returns {{ success: boolean, error?: string }}
 */
export function performExcelExport(currentAssay, exportConfigs, options = {}) {
  // Guard against XLSX being undefined (CDN failure, CSP block, etc.)
  if (typeof XLSX === "undefined") {
    return { success: false, error: "SheetJS library not loaded. Please check your internet connection and reload." };
  }
  try {
    const wb       = XLSX.utils.book_new();
    const sections = buildAllSections(currentAssay, exportConfigs, options);

    sections.forEach(({ excelSheetName, data2D }) => {
      const sheet = XLSX.utils.aoa_to_sheet(data2D);

      if (excelSheetName === "Assay_Metadata") {
        sheet["!cols"] = [{ wch: 25 }, { wch: 40 }];
      } else {
        applySheetLayout(sheet, data2D);
        // Excel-only enhancement: replace the static Mean/SEM/N numbers with
        // live formulas. No-ops harmlessly on sheets with no genotype/summary
        // rows (Assay Metadata is already excluded above; Touch Index
        // Exclusions has neither and is left untouched by the scan itself).
        injectLiveFormulas(sheet, data2D);
      }

      XLSX.utils.book_append_sheet(wb, sheet, excelSheetName);
    });

    XLSX.writeFile(wb, `${currentAssay.assayName || "Assay"}_Export.xlsx`);
    return { success: true };

  } catch (err) {
    console.error("Excel export failed:", err);
    return { success: false, error: err.message };
  }
}


/* ==========================================================================
   CSV Fallback Export (No External Dependencies)
   ========================================================================== */

/**
 * Converts a single 2D row into a valid CSV line.
 * Cells containing commas, newlines, or quotes are wrapped in double-quotes,
 * and any existing double-quotes within those cells are escaped as "".
 *
 * @param {any[]} row - Array of cell values.
 * @returns {string} A properly escaped CSV line (no trailing newline).
 */
function arrayToCSVRow(row) {
  return row.map(cell => {
    const val = (cell === null || cell === undefined) ? "" : String(cell);
    if (val.includes(",") || val.includes("\n") || val.includes('"')) {
      return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
  }).join(",");
}

/**
 * Exports assay data as a UTF-8 CSV file.
 * Used automatically when SheetJS is unavailable (offline / CDN failure)
 * or when the Excel export fails.
 *
 * All sections are built via buildAllSections().
 * The download anchor is clicked directly without appending it to the DOM,
 * which is sufficient in all modern browsers.
 *
 * Each dataset section is preceded by a "=== Section Name ===" heading line
 * and separated by a blank line, making the file human-readable in a text
 * editor as well as importable into spreadsheet applications.
 *
 * @param {Object}   currentAssay  - The full assay object.
 * @param {Object[]} exportConfigs - Array of dataset selection configs.
 * @param {Object}   [options]     - Passed through to buildAllSections() (see includeTidy there).
 * @returns {{ success: boolean, error?: string }}
 */
export function performCSVExport(currentAssay, exportConfigs, options = {}) {
  try {
    const sections = buildAllSections(currentAssay, exportConfigs, options);

    let csv = "";
    sections.forEach((section, i) => {
      if (i > 0) csv += "\n";
      csv += `=== ${section.name} ===\n`;
      section.data2D.forEach(row => {
        csv += (row && row.length > 0) ? arrayToCSVRow(row) + "\n" : "\n";
      });
    });

    // Trigger file download — no DOM append/remove needed in modern browsers.
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `${currentAssay.assayName || "Assay"}_Export.csv`;
    a.click();
    // Revoking synchronously can race the download initiation on mobile
    // browsers where a.click() is asynchronous. Delay to give the browser time
    // to start the download before the object URL is invalidated.
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    return { success: true };

  } catch (err) {
    console.error("CSV export failed:", err);
    return { success: false, error: err.message };
  }
}


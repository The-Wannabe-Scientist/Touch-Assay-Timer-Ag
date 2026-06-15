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
 *   1. Raw stimulus values   (one column per run, one row per stimulus)
 *   2. Binned percentages    (% response per bin) + mean/SEM summary
 *   3. Touch Index (binned)  (normalised against bin 1 baseline)
 *   4. Touch Index (analysed) (mean/SEM across animals per genotype)
 *
 * Depends on SheetJS (XLSX) being loaded globally for Excel export.
 * The CSV fallback has no external dependencies.
 */

import {
  binRunValues,
  computeTouchIndexBins,
  collectPooledRuns,
  collectTouchIndexExclusions
} from "./utils.js";


/* ==========================================================================
   Constants
   ========================================================================== */

/**
 * Human-readable labels for run status values.
 * Used in the "Run Status" header row of every raw data table.
 * @type {Object.<string, string>}
 */
export const RUN_STATUS_LABELS = {
  completed:   "Completed",
  stoppedEarly: "Stopped Early",
  abandoned:   "Abandoned"
};


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
  // Initialise empty arrays for every declared genotype
  const runsByGenotype = {};
  genotypes.forEach(g => { runsByGenotype[g] = []; });

  // Assign each run to its genotype bucket
  runs.forEach(run => {
    if (runsByGenotype[run.genotype]) runsByGenotype[run.genotype].push(run);
  });

  // Sort and (for pooled views) assign a sequential global animal index
  genotypes.forEach(g => {
    if (isPooled) {
      runsByGenotype[g].sort((a, b) =>
        a.trialIndex - b.trialIndex || a.animalIndex - b.animalIndex
      );
      runsByGenotype[g].forEach((run, i) => { run.globalAnimalIndex = i + 1; });
    } else {
      runsByGenotype[g].sort((a, b) => a.animalIndex - b.animalIndex);
    }
  });

  return runsByGenotype;
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

  const n        = values.length;
  const mean     = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
  const sem      = Math.sqrt(variance) / Math.sqrt(n);

  return { mean, sem };
}


/* ==========================================================================
   Layout & Formatting Helpers
   ========================================================================== */

/**
 * Applies column widths and text-wrap cell styles to a SheetJS worksheet.
 * The first column (labels) gets extra width; all others get equal narrower width.
 *
 * @param {Object}    sheet - A SheetJS worksheet object (mutated in place).
 * @param {any[][]}   data  - The 2D array that was used to create the sheet.
 */
export function applySheetLayout(sheet, data) {
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
 * @param {Object} assay - The assay configuration object.
 * @returns {any[][]} Two-column table: [parameter, value].
 */
export function buildMetadata2D(assay) {
  return [
    ["Parameter",                    "Value"],
    ["Experiment ID",                assay.assayName],
    ["Date Created",                 new Date(assay.createdAt).toLocaleString()],
    ["Genotypes",                    assay.genotypes.join(", ")],
    ["Temperature",                  assay.temperature !== undefined ? `${assay.temperature} °C` : "N/A"],
    ["Humidity",                     assay.humidity    !== undefined ? `${assay.humidity} % RH`  : "N/A"],
    ["Inter-stimulus Interval (s)",  assay.isi],
    ["Number of Stimulations",       assay.stimCount],
    ["Bin Size",                     assay.binSize]
  ];
}

/**
 * Renders a 2D data array as an HTML table for the preview modal.
 * The first row and any row whose first cell is "Bin" or "Genotype" are
 * rendered as <th> header cells.
 *
 * @param {string}  title  - Section heading displayed above the table.
 * @param {any[][]} data2D - The 2D array to render.
 * @returns {string} HTML string for this section. Empty string if data is empty.
 */
export function buildHtmlTableFrom2D(title, data2D) {
  if (!data2D || data2D.length === 0) return "";

  // Escape the title to prevent XSS when it contains user-supplied text
  const safeTitle = title
    ? title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    : "";

  let html = `<div class="preview-section"><h3>${safeTitle}</h3>` +
             `<div class="preview-table-wrapper"><table><tbody>`;

  data2D.forEach((row, rowIndex) => {
    // Render empty rows as spacer rows
    if (!row || row.length === 0) {
      html += `<tr><td colspan="100%" style="height:1.5rem;border:none;"></td></tr>`;
      return;
    }

    html += "<tr>";
    row.forEach(cell => {
      const content      = (cell === null || cell === undefined || cell === "") ? "" : cell;
      const displayValue = typeof content === "number"
        ? (Number.isInteger(content) ? content : content.toFixed(2))
        : content;

      // Header cells: first row, or rows that start with "Bin" / "Genotype"
      const isHeaderRow = rowIndex === 0 || row[0] === "Bin" || row[0] === "Genotype";
      html += isHeaderRow
        ? `<th>${displayValue}</th>`
        : `<td>${displayValue}</td>`;
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
 * @param {Object} trial - A single trial object with a `runs` array.
 * @param {Object} assay - The parent assay (provides stimCount and genotypes).
 * @returns {any[][]} 2D array: [genotypeRow, animalRow, statusRow, ...stimulusRows]
 */
export function buildTrialRaw2D(trial, assay) {
  const { stimCount, genotypes } = assay;
  const runsByGenotype = groupAndSortRuns(trial.runs, genotypes, false);

  // Build the three header rows
  const headerGenotype = ["Genotype"];
  const headerAnimal   = ["Animal"];
  const headerStatus   = ["Run Status"];

  genotypes.forEach((g, gi) => {
    runsByGenotype[g].forEach(run => {
      headerGenotype.push(g);
      headerAnimal.push(`Animal ${run.animalIndex}`);
      headerStatus.push(RUN_STATUS_LABELS[run.status] ?? run.status);
    });
    // Blank spacer column between genotypes (not after the last one)
    if (gi < genotypes.length - 1) {
      headerGenotype.push(""); headerAnimal.push(""); headerStatus.push("");
    }
  });

  // Build one row per stimulus
  const rows = [];
  for (let i = 0; i < stimCount; i++) {
    const row = [`Stimulus ${i + 1}`];
    genotypes.forEach((g, gi) => {
      runsByGenotype[g].forEach(run => {
        // Show blank if this run ended before reaching this stimulus
        row.push(i < run.values.length ? run.values[i] : "");
      });
      if (gi < genotypes.length - 1) row.push("");
    });
    rows.push(row);
  }

  return [headerGenotype, headerAnimal, headerStatus, ...rows];
}

/**
 * Builds the binned percentage table for a single trial, with a summary
 * section showing mean ± SEM per genotype per bin.
 *
 * @param {Object} trial - A single trial object with a `runs` array.
 * @param {Object} assay - The parent assay (provides genotypes and binSize).
 * @returns {any[][]} 2D array with raw bins then mean/SEM summary rows.
 */
export function buildTrialBinned2D(trial, assay) {
  const { genotypes, binSize } = assay;
  const runsByGenotype = groupAndSortRuns(trial.runs, genotypes, false);

  // Header rows
  const headerGenotype = ["Genotype"];
  const headerAnimal   = ["Animal"];
  const headerStatus   = ["Run Status"];

  genotypes.forEach((g, gi) => {
    runsByGenotype[g].forEach(run => {
      headerGenotype.push(g);
      headerAnimal.push(`Animal ${run.animalIndex}`);
      headerStatus.push(RUN_STATUS_LABELS[run.status] ?? run.status);
    });
    if (gi < genotypes.length - 1) {
      headerGenotype.push(""); headerAnimal.push(""); headerStatus.push("");
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
  genotypes.forEach(g => summaryHeader.push(`${g}_Mean`, `${g}_SEM`));

  for (let binIndex = 0; binIndex < maxBinCount; binIndex++) {
    const start    = binIndex * binSize + 1;
    const end      = start + binSize - 1;
    const binLabel = `Bin ${binIndex + 1} (${start}–${end})`;

    // Raw values row
    const rawRow = [binLabel];
    genotypes.forEach((g, gi) => {
      runsByGenotype[g].forEach(run => {
        const bins = binnedByRun.get(run);
        rawRow.push(binIndex < bins.length ? bins[binIndex] : "");
      });
      if (gi < genotypes.length - 1) rawRow.push("");
    });
    rawRows.push(rawRow);

    // Summary (mean ± SEM) row
    const sumRow = [binLabel];
    genotypes.forEach(g => {
      const values = runsByGenotype[g]
        .map(run => binnedByRun.get(run)?.[binIndex])  // optional chain: run may not be in map
        .filter(v => v !== undefined);
      const { mean, sem } = calculateStats(values);
      sumRow.push(mean, sem);
    });
    summaryRows.push(sumRow);
  }

  return [
    headerGenotype, headerAnimal, headerStatus,
    ...rawRows,
    ["", "", ""], ["", "", ""], ["", "", ""],  // Three blank separator rows
    summaryHeader,
    ...summaryRows
  ];
}

/**
 * Builds the Touch Index (binned, raw per-run values) table for a single trial.
 * Runs whose first bin is zero are excluded from TI analysis and flagged.
 *
 * @param {Object} trial - A single trial object with a `runs` array.
 * @param {Object} assay - The parent assay (provides genotypes and binSize).
 * @returns {any[][]} 2D array: [genotypeRow, animalRow, ...binRows]
 */
export function buildTrialTouchIndexBinned2D(trial, assay) {
  const { genotypes, binSize } = assay;
  const runsByGenotype = groupAndSortRuns(trial.runs, genotypes, false);

  const headerGenotype = ["Genotype"];
  const headerAnimal   = ["Animal"];

  genotypes.forEach((g, gi) => {
    runsByGenotype[g].forEach(run => {
      headerGenotype.push(g);
      headerAnimal.push(`Animal ${run.animalIndex}`);
    });
    if (gi < genotypes.length - 1) {
      headerGenotype.push(""); headerAnimal.push("");
    }
  });

  // Compute Touch Index for each run; exclude those with a zero baseline
  const binnedByRun = new Map();
  let maxBinCount   = 0;

  trial.runs.forEach(run => {
    const binned = binRunValues(run.values, binSize);
    const ti     = computeTouchIndexBins(binned);
    // Runs with a null TI (zero baseline) are excluded from the map;
    // collectTouchIndexExclusions() detects them dynamically without needing
    // these flags to be written here.
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

  return [headerGenotype, headerAnimal, ...rows];
}

/**
 * Builds the Touch Index summary (mean ± SEM per genotype per bin) for a single trial.
 *
 * @param {Object} trial - A single trial object with a `runs` array.
 * @param {Object} assay - The parent assay (provides genotypes and binSize).
 * @returns {any[][]} 2D array: [header, ...summaryRows]
 */
export function buildTrialTouchIndexAnalysed2D(trial, assay) {
  const { genotypes, binSize } = assay;

  // Group Touch Index arrays by genotype (only non-excluded runs)
  const runsByGenotype = {};
  genotypes.forEach(g => (runsByGenotype[g] = []));

  trial.runs.forEach(run => {
    const binned = binRunValues(run.values, binSize);
    const ti     = computeTouchIndexBins(binned);
    // Excluded runs (null TI) are silently omitted; collectTouchIndexExclusions handles them.
    if (ti && runsByGenotype[run.genotype]) {
      runsByGenotype[run.genotype].push(ti);
    }
  });

  const maxBinCount = Math.max(
    ...Object.values(runsByGenotype).flat().map(r => r.length),
    0
  );

  const header = ["Bin"];
  genotypes.forEach(g => header.push(`${g}_Mean`, `${g}_SEM`));

  const rows = [];
  for (let binIndex = 0; binIndex < maxBinCount; binIndex++) {
    const start = binIndex * binSize + 1;
    const end   = start + binSize - 1;
    const row   = [`Bin ${binIndex + 1} (${start}–${end})`];

    genotypes.forEach(g => {
      // Filter out undefined entries (from runs with fewer bins)
      const values        = runsByGenotype[g].map(r => r[binIndex]).filter(v => v != null);
      const { mean, sem } = calculateStats(values);
      row.push(mean, sem);
    });
    rows.push(row);
  }

  return [header, ...rows];
}


/* ==========================================================================
   Pooled (Cross-Trial) 2D Builders
   ========================================================================== */

/**
 * Builds the raw stimulus-by-stimulus table across all selected trials (pooled).
 * Identical structure to buildTrialRaw2D but spans multiple trials,
 * adding Trial and Trial Animal header rows.
 *
 * @param {Object} assay      - The full assay object.
 * @param {Object} [options]  - Filter options passed to collectPooledRuns.
 * @returns {any[][]} 2D array with five header rows then stimulus rows.
 */
export function buildPooledRaw2D(assay, options = {}) {
  const { stimCount, genotypes } = assay;
  const runs           = collectPooledRuns(assay, options);
  const runsByGenotype = groupAndSortRuns(runs, genotypes, true);

  // Five header rows for pooled view (extra Trial context vs per-trial view)
  const hGenotype    = ["Genotype"];
  const hAnimal      = ["Animal"];
  const hTrial       = ["Trial"];
  const hTrialAnimal = ["Trial Animal"];
  const hStatus      = ["Run Status"];

  genotypes.forEach((g, gi) => {
    runsByGenotype[g].forEach(run => {
      hGenotype.push(g);
      hAnimal.push(`Animal ${run.globalAnimalIndex}`);
      hTrial.push(`Trial ${run.trialIndex}`);
      hTrialAnimal.push(`Animal ${run.animalIndex}`);
      hStatus.push(RUN_STATUS_LABELS[run.status] ?? run.status);
    });
    if (gi < genotypes.length - 1) {
      [hGenotype, hAnimal, hTrial, hTrialAnimal, hStatus].forEach(h => h.push(""));
    }
  });

  const rows = [];
  for (let i = 0; i < stimCount; i++) {
    const row = [`Stimulus ${i + 1}`];
    genotypes.forEach((g, gi) => {
      runsByGenotype[g].forEach(run => {
        row.push(i < run.values.length ? run.values[i] : "");
      });
      if (gi < genotypes.length - 1) row.push("");
    });
    rows.push(row);
  }

  return [hGenotype, hAnimal, hTrial, hTrialAnimal, hStatus, ...rows];
}

/**
 * Builds the pooled binned percentage table with mean ± SEM summary rows.
 *
 * @param {Object} assay     - The full assay object.
 * @param {Object} [options] - Filter options passed to collectPooledRuns.
 * @returns {any[][]} 2D array with header rows, raw bin rows, and summary rows.
 */
export function buildPooledBinned2D(assay, options = {}) {
  const { genotypes, binSize } = assay;
  const runs           = collectPooledRuns(assay, options);
  const runsByGenotype = groupAndSortRuns(runs, genotypes, true);

  const hGenotype    = ["Genotype"];
  const hAnimal      = ["Animal"];
  const hTrial       = ["Trial"];
  const hTrialAnimal = ["Trial Animal"];
  const hStatus      = ["Run Status"];

  genotypes.forEach((g, gi) => {
    runsByGenotype[g].forEach(run => {
      hGenotype.push(g);
      hAnimal.push(`Animal ${run.globalAnimalIndex}`);
      hTrial.push(`Trial ${run.trialIndex}`);
      hTrialAnimal.push(`Animal ${run.animalIndex}`);
      hStatus.push(RUN_STATUS_LABELS[run.status] ?? run.status);
    });
    if (gi < genotypes.length - 1) {
      [hGenotype, hAnimal, hTrial, hTrialAnimal, hStatus].forEach(h => h.push(""));
    }
  });

  // Pre-compute bins for all runs
  const binnedByRun = new Map();
  let maxBinCount   = 0;
  runs.forEach(run => {
    const bins = binRunValues(run.values, binSize);
    binnedByRun.set(run, bins);
    maxBinCount = Math.max(maxBinCount, bins.length);
  });

  const rawRows     = [];
  const summaryRows = [];
  const summaryHeader = ["Bin"];
  genotypes.forEach(g => summaryHeader.push(`${g}_Mean`, `${g}_SEM`));

  for (let binIndex = 0; binIndex < maxBinCount; binIndex++) {
    const start    = binIndex * binSize + 1;
    const end      = start + binSize - 1;
    const binLabel = `Bin ${binIndex + 1} (${start}–${end})`;

    // Raw row
    const rawRow = [binLabel];
    genotypes.forEach((g, gi) => {
      runsByGenotype[g].forEach(run => {
        const bins = binnedByRun.get(run);
        rawRow.push(binIndex < bins.length ? bins[binIndex] : "");
      });
      if (gi < genotypes.length - 1) rawRow.push("");
    });
    rawRows.push(rawRow);

    // Summary row
    const sumRow = [binLabel];
    genotypes.forEach(g => {
      const values = runsByGenotype[g]
        .map(run => binnedByRun.get(run)?.[binIndex])
        .filter(v => v !== undefined);
      const { mean, sem } = calculateStats(values);
      sumRow.push(mean, sem);
    });
    summaryRows.push(sumRow);
  }

  return [
    hGenotype, hAnimal, hTrial, hTrialAnimal, hStatus,
    ...rawRows,
    ["", ""], ["", ""], ["", ""],   // Blank separator rows
    summaryHeader,
    ...summaryRows
  ];
}

/**
 * Builds the pooled Touch Index (raw per-run) table across all selected trials.
 *
 * @param {Object} assay     - The full assay object.
 * @param {Object} [options] - Filter options passed to collectPooledRuns.
 * @returns {any[][]} 2D array: [genotypeRow, animalRow, ...binRows]
 */
export function buildPooledTouchIndexBinned2D(assay, options = {}) {
  const { genotypes, binSize } = assay;
  const runs           = collectPooledRuns(assay, options);
  const runsByGenotype = groupAndSortRuns(runs, genotypes, true);

  const headerGenotype = ["Genotype"];
  const headerAnimal   = ["Animal"];

  genotypes.forEach((g, gi) => {
    runsByGenotype[g].forEach(run => {
      headerGenotype.push(g);
      headerAnimal.push(`Animal ${run.globalAnimalIndex}`);
    });
    if (gi < genotypes.length - 1) {
      headerGenotype.push(""); headerAnimal.push("");
    }
  });

  const binnedByRun = new Map();
  let maxBinCount   = 0;

  runs.forEach(run => {
    const binned = binRunValues(run.values, binSize);
    const ti     = computeTouchIndexBins(binned);
    // Excluded runs (null TI) are omitted from the map; handled by collectTouchIndexExclusions.
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

  return [headerGenotype, headerAnimal, ...rows];
}

/**
 * Builds the pooled Touch Index summary (mean ± SEM per genotype per bin)
 * across all selected trials.
 *
 * @param {Object} assay     - The full assay object.
 * @param {Object} [options] - Filter options passed to collectPooledRuns.
 * @returns {any[][]} 2D array: [header, ...summaryRows]
 */
export function buildPooledTouchIndexAnalysed2D(assay, options = {}) {
  const { genotypes, binSize } = assay;
  const runs = collectPooledRuns(assay, options);

  // Group TI arrays by genotype (only non-excluded runs contribute)
  const runsByGenotype = {};
  genotypes.forEach(g => (runsByGenotype[g] = []));

  runs.forEach(run => {
    const binned = binRunValues(run.values, binSize);
    const ti     = computeTouchIndexBins(binned);
    // Excluded runs (null TI) are silently omitted; collectTouchIndexExclusions handles them.
    if (ti && runsByGenotype[run.genotype]) {
      runsByGenotype[run.genotype].push(ti);
    }
  });

  const maxBinCount = Math.max(
    ...Object.values(runsByGenotype).flat().map(r => r.length),
    0
  );

  const header = ["Bin"];
  genotypes.forEach(g => header.push(`${g}_Mean`, `${g}_SEM`));

  const rows = [];
  for (let binIndex = 0; binIndex < maxBinCount; binIndex++) {
    const start = binIndex * binSize + 1;
    const end   = start + binSize - 1;
    const row   = [`Bin ${binIndex + 1} (${start}–${end})`];

    genotypes.forEach(g => {
      const values        = runsByGenotype[g].map(r => r[binIndex]).filter(v => v != null);
      const { mean, sem } = calculateStats(values);
      row.push(mean, sem);
    });
    rows.push(row);
  }

  return [header, ...rows];
}


/* ==========================================================================
   Master Export Functions
   ========================================================================== */

/**
 * Orchestrates the creation of a multi-sheet Excel workbook and triggers
 * a browser file download.
 *
 * Sheet order:
 *   1. Assay_Metadata
 *   2. One pair of Raw / Analysed sheets per selected trial or pooled dataset
 *   3. TouchIndex_Exclusions (if any runs were excluded)
 *
 * Requires SheetJS (XLSX) to be loaded globally. If XLSX is unavailable,
 * the caller should use performCSVExport() instead.
 *
 * @param {Object}   currentAssay  - The full assay object.
 * @param {Object[]} exportConfigs - Array of dataset selection configs from getExportConfigs().
 * @returns {{ success: boolean, error?: string }}
 */
export function performExcelExport(currentAssay, exportConfigs) {
  try {
    const wb = XLSX.utils.book_new();

    // 1. Metadata sheet (always included)
    const metaSheet = XLSX.utils.aoa_to_sheet(buildMetadata2D(currentAssay));
    metaSheet["!cols"] = [{ wch: 25 }, { wch: 40 }];
    XLSX.utils.book_append_sheet(wb, metaSheet, "Assay_Metadata");

    // 2. One pair of sheets per selected dataset config
    exportConfigs.forEach(config => {

      if (config.type === "trial") {
        const trial = currentAssay.trials.find(t => String(t.trialId) === String(config.trialId));
        if (!trial) return;

        // Raw stimulus data
        const raw2D   = buildTrialRaw2D(trial, currentAssay);
        const rawSheet = XLSX.utils.aoa_to_sheet(raw2D);
        applySheetLayout(rawSheet, raw2D);
        XLSX.utils.book_append_sheet(wb, rawSheet, `Trial_${trial.trialIndex}_Raw`);

        // Binned & Touch Index analysis
        const analysed2D = buildTouchAnalysedSheet2D({
          percentAnalysed2D: buildTrialBinned2D(trial, currentAssay),
          tiBinned2D:        buildTrialTouchIndexBinned2D(trial, currentAssay),
          tiAnalysed2D:      buildTrialTouchIndexAnalysed2D(trial, currentAssay)
        });
        const analysedSheet = XLSX.utils.aoa_to_sheet(analysed2D);
        applySheetLayout(analysedSheet, analysed2D);
        XLSX.utils.book_append_sheet(wb, analysedSheet, `Trial_${trial.trialIndex}_Analysed`);
      }

      if (config.type === "pooled") {
        const suffix  = config.includeAbandoned ? "AllTrials" : "CompletedTrials";
        const poolOpt = { includeAbandoned: config.includeAbandoned };

        // Pooled raw
        const raw2D   = buildPooledRaw2D(currentAssay, poolOpt);
        const rawSheet = XLSX.utils.aoa_to_sheet(raw2D);
        applySheetLayout(rawSheet, raw2D);
        XLSX.utils.book_append_sheet(wb, rawSheet, `Pooled_${suffix}_Raw`);

        // Pooled analysis
        const analysed2D = buildTouchAnalysedSheet2D({
          percentAnalysed2D: buildPooledBinned2D(currentAssay, poolOpt),
          tiBinned2D:        buildPooledTouchIndexBinned2D(currentAssay, poolOpt),
          tiAnalysed2D:      buildPooledTouchIndexAnalysed2D(currentAssay, poolOpt)
        });
        const analysedSheet = XLSX.utils.aoa_to_sheet(analysed2D);
        applySheetLayout(analysedSheet, analysed2D);
        XLSX.utils.book_append_sheet(wb, analysedSheet, `Pooled_${suffix}_Analysed`);
      }
    });

    // 3. Exclusions sheet (only if there are excluded runs)
    const tiExclusions = collectTouchIndexExclusions(currentAssay);
    if (tiExclusions.length > 0) {
      const exclusion2D    = [["Trial", "Genotype", "Animal", "Reason"], ...tiExclusions];
      const exclusionSheet = XLSX.utils.aoa_to_sheet(exclusion2D);
      applySheetLayout(exclusionSheet, exclusion2D);
      XLSX.utils.book_append_sheet(wb, exclusionSheet, "TouchIndex_Exclusions");
    }

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
 * Each dataset section is preceded by a "=== Section Name ===" heading line
 * and separated by a blank line, making the file human-readable in a text editor
 * as well as importable into spreadsheet applications.
 *
 * @param {Object}   currentAssay  - The full assay object.
 * @param {Object[]} exportConfigs - Array of dataset selection configs.
 * @returns {{ success: boolean, error?: string }}
 */
export function performCSVExport(currentAssay, exportConfigs) {
  try {
    const sections = [];

    // Metadata is always the first section
    sections.push({ name: "Assay Metadata", data: buildMetadata2D(currentAssay) });

    exportConfigs.forEach(config => {
      if (config.type === "trial") {
        const trial = currentAssay.trials.find(t => String(t.trialId) === String(config.trialId));
        if (!trial) return;

        sections.push({
          name: `Trial ${trial.trialIndex} - Raw`,
          data: buildTrialRaw2D(trial, currentAssay)
        });
        sections.push({
          name: `Trial ${trial.trialIndex} - Analysed`,
          data: buildTouchAnalysedSheet2D({
            percentAnalysed2D: buildTrialBinned2D(trial, currentAssay),
            tiBinned2D:        buildTrialTouchIndexBinned2D(trial, currentAssay),
            tiAnalysed2D:      buildTrialTouchIndexAnalysed2D(trial, currentAssay)
          })
        });
      }

      if (config.type === "pooled") {
        const suffix  = config.includeAbandoned ? "All Trials" : "Completed Trials";
        const poolOpt = { includeAbandoned: config.includeAbandoned };

        sections.push({
          name: `Pooled (${suffix}) - Raw`,
          data: buildPooledRaw2D(currentAssay, poolOpt)
        });
        sections.push({
          name: `Pooled (${suffix}) - Analysed`,
          data: buildTouchAnalysedSheet2D({
            percentAnalysed2D: buildPooledBinned2D(currentAssay, poolOpt),
            tiBinned2D:        buildPooledTouchIndexBinned2D(currentAssay, poolOpt),
            tiAnalysed2D:      buildPooledTouchIndexAnalysed2D(currentAssay, poolOpt)
          })
        });
      }
    });

    // Append exclusions section if any runs were excluded from TI
    const tiExclusions = collectTouchIndexExclusions(currentAssay);
    if (tiExclusions.length > 0) {
      sections.push({
        name: "Touch Index Exclusions",
        data: [["Trial", "Genotype", "Animal", "Reason"], ...tiExclusions]
      });
    }

    // Serialise sections to a single CSV string
    let csv = "";
    sections.forEach((section, i) => {
      if (i > 0) csv += "\n";
      csv += `=== ${section.name} ===\n`;
      section.data.forEach(row => {
        csv += (row && row.length > 0) ? arrayToCSVRow(row) + "\n" : "\n";
      });
    });

    // Trigger file download
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `${currentAssay.assayName || "Assay"}_Export.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    return { success: true };

  } catch (err) {
    console.error("CSV export failed:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Generates the full HTML content for the data preview modal.
 * Renders every selected dataset as an HTML table, plus the metadata
 * block and any Touch Index exclusions.
 *
 * @param {Object}   currentAssay  - The full assay object.
 * @param {Object[]} exportConfigs - Array of dataset selection configs.
 * @returns {string} Complete HTML string ready to inject into the modal container.
 */
export function generatePreviewHTML(currentAssay, exportConfigs) {
  let html = buildHtmlTableFrom2D("Assay Metadata", buildMetadata2D(currentAssay));

  exportConfigs.forEach(config => {
    if (config.type === "trial") {
      const trial = currentAssay.trials.find(t => String(t.trialId) === String(config.trialId));
      if (!trial) return;

      html += buildHtmlTableFrom2D(
        `Trial ${trial.trialIndex} - Raw`,
        buildTrialRaw2D(trial, currentAssay)
      );
      html += buildHtmlTableFrom2D(
        `Trial ${trial.trialIndex} - Analysed`,
        buildTouchAnalysedSheet2D({
          percentAnalysed2D: buildTrialBinned2D(trial, currentAssay),
          tiBinned2D:        buildTrialTouchIndexBinned2D(trial, currentAssay),
          tiAnalysed2D:      buildTrialTouchIndexAnalysed2D(trial, currentAssay)
        })
      );
    }

    if (config.type === "pooled") {
      const suffix  = config.includeAbandoned ? "All Trials" : "Completed Trials";
      const poolOpt = { includeAbandoned: config.includeAbandoned };

      html += buildHtmlTableFrom2D(
        `Pooled (${suffix}) - Raw`,
        buildPooledRaw2D(currentAssay, poolOpt)
      );
      html += buildHtmlTableFrom2D(
        `Pooled (${suffix}) - Analysed`,
        buildTouchAnalysedSheet2D({
          percentAnalysed2D: buildPooledBinned2D(currentAssay, poolOpt),
          tiBinned2D:        buildPooledTouchIndexBinned2D(currentAssay, poolOpt),
          tiAnalysed2D:      buildPooledTouchIndexAnalysed2D(currentAssay, poolOpt)
        })
      );
    }
  });

  const tiExclusions = collectTouchIndexExclusions(currentAssay);
  if (tiExclusions.length > 0) {
    html += buildHtmlTableFrom2D(
      "Touch Index Exclusions",
      [["Trial", "Genotype", "Animal", "Reason"], ...tiExclusions]
    );
  }

  return html;
}
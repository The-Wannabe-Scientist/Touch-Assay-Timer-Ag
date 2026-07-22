/**
 * @file utils.js
 * @module AssayUtilities
 * @description Pure utility functions for input validation, data processing,
 * and data extraction. All functions are stateless and side-effect free.
 *
 * Sections:
 *   1. Validation & ID Generation
 *   2. Data Processing & Statistics
 *   3. Data Extraction & Aggregation
 */

/**
 * @typedef {Object} Assay
 * @property {string}   assayId        - Unique identifier.
 * @property {string}   assayName      - Human-readable experiment name.
 * @property {number}   createdAt      - Unix timestamp (ms) of creation.
 * @property {number}   lastModifiedAt - Unix timestamp (ms) of last write.
 * @property {number}   isi            - Inter-stimulus interval in seconds.
 * @property {number}   stimCount      - Total stimuli per run.
 * @property {number}   binSize        - Stimuli per analysis bin.
 * @property {number|null} temperature - Ambient temperature in °C, or null if not recorded.
 * @property {number|null} humidity    - Relative humidity 0–100 %, or null if not recorded.
 * @property {string[]} genotypes      - Ordered list of genotype labels.
 * @property {Trial[]}  trials         - All trials belonging to this assay.
 */

/**
 * @typedef {Object} Trial
 * @property {string}      trialId         - Unique identifier.
 * @property {number}      trialIndex      - 1-based sequential index within the parent assay.
 * @property {"active"|"completed"|"abandoned"} status
 * @property {string|null} abandonedReason - Human-readable reason, set when abandoned.
 * @property {number}      startedAt       - Unix timestamp (ms).
 * @property {number|null} endedAt         - Unix timestamp (ms), null while active.
 * @property {Run[]}       runs            - All runs recorded in this trial.
 */

/**
 * @typedef {Object} Run
 * @property {string}      runId                    - Unique identifier.
 * @property {string}      genotype                 - Genotype label for this animal.
 * @property {number|string} animalIndex            - 1-based sequential ID within genotype+trial.
 * @property {number}      expectedStimCount        - Target number of stimuli to record.
 * @property {number[]}    values                   - 1 = responded, 0 = did not respond (one per stimulus).
 * @property {"active"|"completed"|"stoppedEarly"|"abandoned"} status
 * @property {boolean|null} eligibleForAnalysis     - Set to true/false on run completion.
 * @property {string|null} ineligibleReason         - Human-readable reason when ineligible.
 * @property {string|null} partialBinWarning        - Set when stimulus count is not a multiple of binSize.
 * @property {number}      startedAt                - Unix timestamp (ms).
 * @property {number|null} endedAt                  - Unix timestamp (ms), null while active.
 */


/* ==========================================================================
   1. Validation & ID Generation
   ========================================================================== */

/**
 * Validates the input parameters collected from the assay setup form.
 * Returns a structured result rather than throwing, so the caller can
 * display all errors at once instead of one at a time.
 *
 * @param {Object}   values             - The raw assay configuration object.
 * @param {string}   values.assayName   - Name / ID of the experiment.
 * @param {string[]} values.genotypes   - Array of genotype labels.
 * @param {number}   values.isi         - Inter-stimulus interval in seconds (> 0).
 * @param {number}   values.stimCount   - Total number of stimuli per run (> 0).
 * @param {number}   values.binSize     - Stimuli grouped per analysis bin (> 0).
 * @param {number}   values.temperature - Room temperature in °C.
 * @param {number}   values.humidity    - Relative humidity, 0–100 %.
 * @returns {{ isValid: boolean, errors: string[], warnings: string[] }}
 *   isValid  — true only when the errors array is empty.
 *   errors   — human-readable description of each failed validation check.
 *   warnings — non-blocking advisories (e.g. very short ISI) that do not
 *              prevent submission but are surfaced to the user as toasts.
 */
/**
 * Normalises a genotype label for fuzzy duplicate comparison.
 * Strips: case, whitespace, hyphens (including Unicode dash variants),
 * underscores, and all remaining non-alphanumeric characters.
 *
 * This function is the single source of truth for normalisation — the same
 * logic is mirrored in the chip-input IIFE in index.html.
 *
 * @param {string} str - Raw genotype label.
 * @returns {string} Lower-cased alphanumeric-only key.
 */
export function normaliseGenotype(str) {
  return String(str)
    .toLowerCase()
    .replace(/[\s\-_\u2010-\u2015\u2212]+/g, '')  // whitespace + hyphens (all Unicode dash variants)
    .replace(/[^a-z0-9]/g, '');                    // strip remaining punctuation / symbols
}

export function validateInputs(values) {
  const errors   = [];
  const warnings = [];

  if (!values.assayName) {
    errors.push("Assay name is required.");
  }

  if (!values.genotypes || values.genotypes.length === 0) {
    errors.push("At least one genotype is required.");
  } else {
    // Reject blank/whitespace-only genotype labels
    if (values.genotypes.some(g => !g || !g.trim())) {
      errors.push("Genotype labels must not be empty.");
    }
    // Fuzzy duplicate check — mirrors normaliseGenotype() used in the chip-input UI.
    // Two labels that differ only in case, spacing, hyphens, or punctuation
    // (e.g. "Wild-Type" vs "wildtype") are treated as the same genotype because
    // they would produce identical export column headers after normalisation.
    const normKeys = values.genotypes.map(g => normaliseGenotype(g));
    if (new Set(normKeys).size !== values.genotypes.length) {
      errors.push("Genotype labels must be unique (ignoring case, spaces, and punctuation).");
    }
  }

  if (values.isi <= 0) {
    errors.push("Inter-stimulus interval (ISI) must be greater than zero.");
  } else if (values.isi < 0.5) {
    // Non-blocking advisory — very short ISIs may be below reliable scheduling
    // resolution on slow or throttled devices, risking silent data inaccuracy.
    warnings.push(
      `ISI of ${values.isi}s is very short — timing accuracy may be reduced on this device. ` +
      `Consider using ≥0.5s for reliable results.`
    );
  }

  if (values.stimCount <= 0) {
    errors.push("Stimulus count must be greater than zero.");
  }

  if (values.binSize <= 0) {
    errors.push("Bin size must be greater than zero.");
  }

  // If binSize > stimCount, binRunValues() produces an empty array
  // (all values are dropped as a trailing partial bin) causing completely blank
  // columns in the export with no user-facing explanation.
  if (values.binSize > 0 && values.stimCount > 0 && values.binSize > values.stimCount) {
    errors.push(`Bin size (${values.binSize}) cannot be larger than the total stimulus count (${values.stimCount}).`);
  }

  // Temperature and humidity are optional — main.js maps an empty field to null,
  // which is a valid "not recorded" state. Only validate when a value is
  // actually provided (non-null), and reject only genuinely bad values (NaN, etc.).
  if (values.temperature != null && isNaN(Number(values.temperature))) {
    errors.push("Temperature must be a valid number.");
  }

  // Same optional treatment as temperature — null means the field was left blank.
  if (values.humidity != null && (isNaN(Number(values.humidity)) || values.humidity < 0 || values.humidity > 100)) {
    errors.push("Humidity must be a valid percentage between 0 and 100.");
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Generates a unique, human-readable experiment ID based on the local clock.
 * Intended as a sensible default that avoids blank name fields.
 *
 * Format: "touch_YYYY-MM-DD_HHMM"
 *
 * @returns {string} A timestamp-based ID string.
 */
export function generateAutoID() {
  const now    = new Date();
  const year   = now.getFullYear();
  const month  = String(now.getMonth() + 1).padStart(2, "0");
  const day    = String(now.getDate()).padStart(2, "0");
  const hours  = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");

  return `touch_${year}-${month}-${day}_${hours}${minutes}`;
}


/* ==========================================================================
   2. Data Processing & Statistics
   ========================================================================== */

/**
 * Groups a flat array of binary response values into fixed-size bins and
 * converts each bin into a percentage of positive responses (1s).
 *
 * Encoding convention:
 *   1 = animal responded to the stimulus (default / no-tap event)
 *   0 = animal did not respond (experimenter tapped to record non-response)
 * Therefore, a higher bin percentage means a more responsive animal.
 *
 * If the total number of values is not an exact multiple of binSize and
 * allowPartialBin is false (the default), trailing values that do not fill
 * a complete bin are silently dropped and a console warning is emitted.
 *
 * @param {number[]} values               - Raw stimulus values (0s and 1s).
 * @param {number}   binSize              - Number of values per bin.
 * @param {Object}   [options]            - Optional behaviour overrides.
 * @param {boolean}  [options.allowPartialBin=false] - Keep the last partial bin.
 * @param {boolean}  [options.warnOnDrop=true]       - Log a warning when values are dropped.
 * @returns {number[]} Percentage per bin (0–100), ordered chronologically.
 */
export function binRunValues(values, binSize, options = {}) {
  const { allowPartialBin = false, warnOnDrop = true } = options;

  // Guard against null/undefined values (e.g. from a partially-written DB record)
  if (!values || !Array.isArray(values)) return [];

  const totalValues = values.length;
  const remainder   = totalValues % binSize;

  // Determine how many values can be cleanly binned
  let usableCount = totalValues;
  if (remainder !== 0 && !allowPartialBin) {
    usableCount = totalValues - remainder;
    if (warnOnDrop) {
      console.warn(
        `[Data Truncated] Dropped ${remainder} trailing value(s) that do not ` +
        `form a complete bin of size ${binSize}.`
      );
    }
  }

  const usableValues     = values.slice(0, usableCount);
  const binnedPercentages = [];

  for (let i = 0; i < usableValues.length; i += binSize) {
    const bin        = usableValues.slice(i, i + binSize);
    const sum        = bin.reduce((acc, v) => acc + v, 0);
    // Use bin.length (not binSize) so partial bins are handled correctly
    const percentage = (sum / bin.length) * 100;
    binnedPercentages.push(percentage);
  }

  return binnedPercentages;
}

/**
 * Normalises an array of binned percentages against the first bin (baseline).
 * The result is the "Touch Index" — each bin expressed as a fraction of baseline.
 *
 * A Touch Index of 1.0 means the animal responded at the same rate as baseline.
 * Values < 1.0 indicate habituation; values > 1.0 indicate sensitisation.
 *
 * Returns null when normalisation is impossible (zero or missing baseline),
 * which causes the run to be excluded from Touch Index analysis.
 *
 * @param {number[]} binnedPercentages - Output of binRunValues().
 * @returns {number[]|null} Normalised ratios, or null if baseline is invalid.
 */
export function computeTouchIndexBins(binnedPercentages) {
  // Explicitly guard the empty-array case before reading index 0.
  // Previously this relied on binnedPercentages[0] === undefined being == null,
  // which is correct but fragile — a future strict-equality change would break it.
  if (!binnedPercentages || binnedPercentages.length === 0) return null;

  const baseline = binnedPercentages[0];

  // Prevent division by zero (baseline = 0 means no responses in the first bin).
  // Also guard against NaN baseline — possible if upstream values[] contains
  // non-numeric entries that slipped through DB validation, causing bin.reduce()
  // to return NaN. Without this guard the function would return an all-NaN TI
  // array that silently corrupts the export instead of triggering an exclusion.
  if (baseline === 0 || baseline == null || isNaN(baseline)) {
    return null;
  }

  return binnedPercentages.map(v => v / baseline);
}


/* ==========================================================================
   3. Data Extraction & Aggregation
   ========================================================================== */

/**
 * Escapes HTML special characters to prevent XSS when rendering
 * user-supplied strings (e.g. assay names, genotype labels) into innerHTML.
 *
 * Shared between main.js and export.js as a single source of truth —
 * previously both modules had an identical private copy.
 *
 * @param {string} str - Raw user input string.
 * @returns {string} Safely escaped HTML string.
 */
export function escapeHTML(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;")
    .replace(/'/g,  "&#39;");
}



/**
 * Flattens all runs from all trials in an assay into a single array,
 * enriching each run with its parent trial's index for downstream labelling.
 *
 * By default only runs from completed trials are included; pass
 * { includeAbandoned: true } to also include abandoned trials.
 *
 * @param {Assay}   assay                        - The full assay object.
 * @param {Object}  [options]                    - Filter options.
 * @param {boolean} [options.includeAbandoned=false] - Include abandoned trials.
 * @returns {Run[]} Flat array of run objects, each with a `trialIndex` field.
 */
export function collectPooledRuns(assay, options = {}) {
  const { includeAbandoned = false } = options;

  return assay.trials
    .filter(trial => includeAbandoned || trial.status === "completed")
    .flatMap(trial =>
      trial.runs.map(run => ({
        ...run,
        trialIndex: trial.trialIndex
      }))
    );
}

/**
 * Extracts a tabular list of runs that were excluded from Touch Index
 * calculations (e.g. because their baseline bin was zero).
 * Used to populate the "Exclusions" sheet in the Excel export.
 *
 * Exclusions are computed fresh by re-running the TI derivation — they are
 * NOT read from `run.touchIndexExcluded` flags on the run object.
 * This guarantees that the exclusion list is always consistent regardless of
 * whether preview, export, or CSV functions have been called beforehand.
 *
 * @param {Assay} assay - The full assay object (needs assay.binSize).
 * @returns {Array<[number, string, number, string]>}
 *   Each row: [trialIndex, genotype, animalIndex, exclusionReason]
 */
export function collectTouchIndexExclusions(assay) {
  // Only scan completed trials — abandoned or still-active trials must not
  // produce spurious exclusion rows in the export output.
  return assay.trials
    .filter(t => t.status === "completed")
    .flatMap(trial =>
      trial.runs
        // Only eligible runs can be TI-excluded. Ineligible runs (stopped early,
        // abandoned) have empty or partial values[] — their binned result is []
        // which causes computeTouchIndexBins to return null, producing spurious
        // exclusion rows in the export sheet.
        .filter(run => run.eligibleForAnalysis)
        .filter(run => {
          // A run is excluded if its Touch Index cannot be computed —
          // i.e. computeTouchIndexBins returns null (baseline bin = 0).
          const binned = binRunValues(run.values, assay.binSize);
          return computeTouchIndexBins(binned) === null;
        })
        .map(run => [
          trial.trialIndex,
          run.genotype,
          run.animalIndex,
          "Baseline bin = 0 (animal had no responses in the first bin)"
        ])
    );
}
/**
 * @file main.js
 * @module MainController
 * @description Orchestrates the Touch Assay Timer application.
 *
 * Responsibilities:
 *   - Initialises all modules on DOMContentLoaded.
 *   - Owns the global application state machine (STATES / setState).
 *   - Drives the three-layer scheduling pipeline:
 *       Layer 1: Web Worker heartbeat → scheduler() → Web Audio hardware ticks
 *       Layer 2: UI display + optional speech, triggered at stimulus onset
 *       Layer 3: Data recording at stimulus close, batch-saved to IndexedDB
 *   - Manages run lifecycle: start → warmup → record → complete/stop.
 *   - Handles crash guards (visibilitychange, beforeunload).
 *   - Wires all DOM event listeners.
 *
 * Application State Machine:
 *
 *   SETUP ──submit──→ CONFIGURED ──tap──→ POISED ──tap──→ RUNNING
 *                         ↑                  ↑                 │
 *                         └──backToAssay─────┘←──stopRun/done──┘
 *                                            │
 *                                    finishTrial
 *                                            │
 *                                          EXPORT
 *
 * Scheduling pipeline (fires ~40×/sec via timer-worker.js):
 *
 *   Worker "tick" → scheduler() {
 *     Step 0: Gap check — auto-stop if timing gap > 2×ISI (backgrounding detected)
 *     Step 1: Speech/UI layer  — update counter, trigger voice cue at stimulus open
 *     Step 2: Data layer       — record 0/1 at stimulus close, batch-save to IDB
 *     Step 3: Audio layer      — pre-schedule hardware beep slightly in advance
 *   }
 */

import { initLogger, downloadLogs, clearLogs }       from "./logger.js";
import { validateInputs, generateAutoID, binRunValues } from "./utils.js";
import {
  createAssay, createTrial, createRun,
  getActiveTrial, completeRun
}                                                      from "./models.js";
import {
  saveAssay, loadAllAssays, hydrateAssay, deleteAssay,
  saveTrial, markTrialCompleted, markTrialAbandoned,
  saveRun, abandonAllActiveTrialsInDB
}                                                      from "./db.js";
import {
  isAudioReady, setVoiceMode, loadVoices, speak, stopSpeech,
  warmUpAudio, playWarmupTone, scheduleWebAudioTick,
  triggerImmediateSpeech, getAudioTime, playCompletionTone
}                                                      from "./audio.js";
import {
  performExcelExport, performCSVExport, generatePreviewHTML
}                                                      from "./export.js";


/* ==========================================================================
   Module Initialisation
   ========================================================================== */

// Start the persistent logger before anything else so startup errors are captured
initLogger();


/* ==========================================================================
   Global Application State
   ========================================================================== */

/**
 * All valid application states.
 * The body class is set to `state-<value>` so CSS can show/hide sections.
 * @enum {string}
 */
const STATES = {
  SETUP:      "setup",
  CONFIGURED: "configured",
  POISED:     "poised",
  RUNNING:    "running",
  EXPORT:     "export"
};

/** @type {string} The current application state (one of STATES). */
let currentState = STATES.SETUP;

/** @type {Object|null} The currently active assay, fully hydrated from DB. */
let currentAssay = null;

/**
 * Double-tap confirmation guard.
 * The first tap sets pendingStart = true and shows a confirmation prompt.
 * The second tap within 2 seconds proceeds to start the run.
 * @type {boolean}
 */
let pendingStart = false;

/** @type {number|null} setTimeout handle for the pendingStart reset timer. */
let startTimeout = null;


/* ==========================================================================
   Timing & Scheduling State
   ========================================================================== */

/**
 * Tracks how many stimulus intervals have been closed (data recorded).
 * This is the authoritative "how many stimuli done" counter.
 * @type {number}
 */
let currentStimulusIndex = 0;

/**
 * Tracks how many stimulus windows have been opened for speech/UI updates.
 * Advances one step ahead of currentStimulusIndex.
 * @type {number}
 */
let nextSpeechIndex = 0;

/**
 * Tracks how many hardware audio ticks have been pre-scheduled.
 * Advances further ahead (by scheduleAheadTime) than speech/data.
 * @type {number}
 */
let nextAudioStimulusIndex = 0;

/**
 * Array of AudioContext timestamps for every tap recorded in the current run.
 * Taps outside the current interval window are pruned after each data step.
 * @type {number[]}
 */
let tapTimestamps = [];

/** @type {number} AudioContext time when the next speech/UI update should fire. */
let nextSpeechTime = 0.0;

/** @type {number} AudioContext time when the next data recording window closes. */
let nextDataIntervalTime = 0.0;

/** @type {number} AudioContext time when the next hardware tick should be scheduled. */
let nextAudioScheduleTime = 0.0;

/**
 * How far ahead (in seconds) the audio scheduler pre-books hardware ticks.
 * 100ms gives enough headroom without causing audible stutters on devices
 * that have main-thread pauses up to ~80ms.
 * @type {number}
 */
const SCHEDULE_AHEAD_TIME = 0.1;

/**
 * AudioContext timestamp of the last scheduler() invocation.
 * Used to detect timing gaps caused by backgrounding / throttling.
 * @type {number}
 */
let lastSchedulerTime = 0;

/**
 * How many stimuli were recorded at the time of the last IDB batch save.
 * Used to decide when to flush: save when (currentIndex - lastSave) >= BATCH_SIZE.
 * @type {number}
 */
let lastBatchSaveIndex = 0;

/**
 * Number of stimuli between periodic IDB saves during a run.
 * Reduces write frequency from every tick to every N stimuli (~90% fewer writes).
 * @type {number}
 */
const BATCH_SAVE_INTERVAL = 10;

/** @type {number|null} requestAnimationFrame handle for the visual metronome bar. */
let visualAnimationFrame = null;

/** @type {number|null} Timestamp (Date.now()) of the last processed tap. */
let lastTapTime = 0;

/**
 * Minimum milliseconds between accepted taps (hardware debounce).
 * Prevents a single physical press from registering as two taps on slow devices.
 * @type {number}
 */
const TAP_COOLDOWN_MS = 80;

/** @type {number} Unix timestamp of when the current run started (for elapsed time). */
let runStartTime = null;


/* ==========================================================================
   Hardware & Settings State
   ========================================================================== */

/** @type {WakeLockSentinel|null} Active screen Wake Lock, or null if not held. */
let wakeLock = null;

/**
 * Whether the countdown warmup is enabled before each run.
 * Persisted in localStorage so the setting survives page refreshes.
 * @type {boolean}
 */
let isWarmupEnabled = localStorage.getItem("touchAssayWarmupEnabled") !== "false";

/**
 * Duration of the warmup countdown in seconds.
 * @type {number}
 */
let warmupDuration = parseInt(localStorage.getItem("touchAssayWarmupDuration"), 10) || 3;

/**
 * True while the warmup countdown is actively ticking.
 * Prevents re-entry if the tap button is pressed twice during warmup.
 * @type {boolean}
 */
let isWarmingUp = false;

/**
 * The Web Worker instance that drives the scheduling heartbeat.
 * Isolated off the main thread so browser timer throttling doesn't affect timing.
 */
const timerWorker = new Worker("js/timer-worker.js");


/* ==========================================================================
   DOMContentLoaded — Main Entry Point
   ========================================================================== */

document.addEventListener("DOMContentLoaded", async () => {

  /* -----------------------------------------------------------------------
     DOM Element Cache (UI)
     Centralised here so element lookups happen once at init, not on every event.
  ----------------------------------------------------------------------- */
  const UI = {
    Inputs: {
      assayName:       document.getElementById("assayName"),
      genotypes:       document.getElementById("genotypes"),
      isi:             document.getElementById("ISI"),
      stimCount:       document.getElementById("stimCount"),
      binSize:         document.getElementById("binSize"),
      temperature:     document.getElementById("temperature"),
      humidity:        document.getElementById("humidity"),
      genotypeSelect:  document.getElementById("genotypeSelect"),
      selectAllAssays: document.getElementById("selectAllAssays"),
    },
    Screens: {
      setup:       document.getElementById("setupScreen"),
      assay:       document.getElementById("assayScreen"),
      export:      document.getElementById("exportScreen"),
      settings:    document.getElementById("settingsScreen"),
      guidelines:  document.getElementById("guidelinesScreen"),
      savedAssays: document.getElementById("savedAssaysScreen"),
    },
    Buttons: {
      tap:                  document.getElementById("tapButton"),
      stopRun:              document.getElementById("stopRun"),
      finishTrial:          document.getElementById("finishTrial"),
      backToAssay:          document.getElementById("backToAssay"),
      newAssay:             document.getElementById("newAssay"),
      progress:             document.getElementById("toggleProgress"),
      exportExcel:          document.getElementById("exportExcel"),
      previewExcel:         document.getElementById("previewExcel"),
      exportFromPreview:    document.getElementById("exportFromPreview"),
      openSettings:         document.getElementById("openSettings"),
      closeSettings:        document.getElementById("closeSettings"),
      openGuidelines:       document.getElementById("openGuidelines"),
      closeGuidelines:      document.getElementById("closeGuidelines"),
      openSavedAssays:      document.getElementById("openSavedAssays"),
      closeSavedAssays:     document.getElementById("closeSavedAssays"),
      overflowMenu:         document.getElementById("overflowMenuButton"),
      downloadLogs:         document.getElementById("downloadLogsBtn"),
      clearLogs:            document.getElementById("clearLogsBtn"),
      deleteSelectedAssays: document.getElementById("deleteSelectedAssays"),
    },
    Displays: {
      liveProgress:     document.getElementById("liveProgress"),
      currentStim:      document.getElementById("currentStimDisplay"),
      totalStim:        document.getElementById("totalStimDisplay"),
      warmup:           document.getElementById("warmupDisplay"),
      binWarning:       document.getElementById("binWarning"),
      savedAssaysList:  document.getElementById("savedAssaysList"),
      previewModal:     document.getElementById("previewModal"),
      previewContainer: document.getElementById("previewContainer"),
      closePreview:     document.getElementById("closePreview"),
      overflowMenu:     document.getElementById("overflowMenu"),
    },
    Forms: {
      setup: document.getElementById("setupForm"),
    },
    Settings: {
      warmupToggle:           document.getElementById("warmupToggle"),
      warmupDurationInput:    document.getElementById("warmupDuration"),
      warmupDurationContainer: document.getElementById("warmupDurationContainer"),
    }
  };


  /* -----------------------------------------------------------------------
     Initialisation Sequence
  ----------------------------------------------------------------------- */

  formatRequiredLabels();                    // Add * to required form fields
  UI.Inputs.assayName.value = generateAutoID(); // Pre-fill with timestamp-based ID
  abandonAllActiveTrialsInDB().catch(err =>  // Clean up any crashed session leftovers
    console.warn("Background cleanup failed:", err)
  );
  initializeSettings();                      // Restore saved preferences from localStorage
  setState(STATES.SETUP);                    // Render the initial state


  /* -----------------------------------------------------------------------
     State Machine
  ----------------------------------------------------------------------- */

  /**
   * Transitions the application to a new state.
   *
   * Sets body.className to "state-<nextState>" so CSS rules can show or hide
   * the correct sections without manual display toggling in JS.
   *
   * Each case also configures button availability for that state to prevent
   * invalid actions (e.g. tapping Stop when no run is active).
   *
   * @param {string} nextState - Target state constant from STATES.
   */
  function setState(nextState) {
    currentState           = nextState;
    document.body.className = `state-${currentState}`;

    switch (currentState) {
      case STATES.SETUP:
        UI.Buttons.tap.disabled            = true;
        UI.Buttons.stopRun.disabled        = true;
        UI.Buttons.finishTrial.disabled    = true;
        UI.Inputs.genotypeSelect.innerHTML = "";
        UI.Buttons.tap.textContent         = "Select Genotype to Start";
        break;

      case STATES.CONFIGURED:
        UI.Inputs.genotypeSelect.disabled = false;
        UI.Buttons.tap.disabled           = false;
        UI.Buttons.progress.disabled      = false;
        UI.Buttons.stopRun.disabled       = true;
        UI.Buttons.finishTrial.disabled   = true;
        UI.Buttons.tap.textContent        = "Select Genotype to Start";
        break;

      case STATES.POISED:
        UI.Inputs.genotypeSelect.disabled = false;
        UI.Buttons.tap.disabled           = false;
        UI.Buttons.finishTrial.disabled   = false;
        UI.Buttons.progress.disabled      = false;
        UI.Buttons.stopRun.disabled       = true;
        UI.Buttons.tap.textContent        = "Select Genotype to Start";
        break;

      case STATES.RUNNING:
        UI.Inputs.genotypeSelect.disabled = true;
        UI.Buttons.finishTrial.disabled   = true;
        UI.Buttons.progress.disabled      = true;
        UI.Buttons.tap.disabled           = false;
        UI.Buttons.stopRun.disabled       = false;
        break;

      case STATES.EXPORT:
        // All controls remain as-is; export screen CSS handles visibility
        break;
    }
  }


  /* -----------------------------------------------------------------------
     Overlay Screen Management
  ----------------------------------------------------------------------- */

  /**
   * Shows an overlay screen (settings, guidelines, saved assays) while
   * adding the 'state-overlay' body class for CSS-driven dimming.
   *
   * @param {HTMLElement} screenElement - The section element to show.
   */
  function showScreen(screenElement) {
    UI.Displays.overflowMenu.hidden = true;
    document.body.classList.add("state-overlay");

    // Collapse all overlay screens first to avoid stacking
    UI.Screens.settings.hidden    = true;
    UI.Screens.guidelines.hidden  = true;
    UI.Screens.savedAssays.hidden = true;

    screenElement.hidden = false;
  }

  /**
   * Hides an overlay screen and removes the dimming class.
   *
   * @param {HTMLElement} screenElement - The section element to hide.
   */
  function hideScreenAndRestore(screenElement) {
    screenElement.hidden = true;
    document.body.classList.remove("state-overlay");
  }


  /* -----------------------------------------------------------------------
     Hardware Integration
  ----------------------------------------------------------------------- */

  /**
   * Requests a screen Wake Lock to prevent the device from sleeping during
   * an active run. Silently no-ops on browsers that don't support the API.
   */
  async function requestWakeLock() {
    try {
      if ("wakeLock" in navigator) {
        wakeLock = await navigator.wakeLock.request("screen");
      }
    } catch (err) {
      console.warn("Wake Lock request failed:", err);
    }
  }

  /**
   * Releases the active Wake Lock (called on run complete or stop).
   * Safe to call when no lock is held.
   */
  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().then(() => { wakeLock = null; });
    }
  }


  /* -----------------------------------------------------------------------
     Run Lifecycle — Start
  ----------------------------------------------------------------------- */

  /**
   * Creates a new run record within the current trial and starts the metronome.
   *
   * Flow:
   *   1. Creates a run object and appends it to the active trial in memory.
   *   2. Persists the initial run record to IDB.
   *   3. Requests Wake Lock and transitions to RUNNING state.
   *   4. Initialises scheduling timestamps and starts the Worker heartbeat.
   */
  async function startRun() {
    if (!currentAssay) return;

    const activeTrial = getActiveTrial(currentAssay);
    if (!activeTrial) return;

    const selectedGenotype = UI.Inputs.genotypeSelect.value;

    // Count only non-active (completed / abandoned) runs for this genotype
    // to avoid double-counting if a previous run stalled mid-flight
    const animalIndex = activeTrial.runs.filter(
      run => run.genotype === selectedGenotype && run.status !== "active"
    ).length + 1;

    const run = createRun({
      genotype:          selectedGenotype,
      animalIndex,
      expectedStimCount: currentAssay.stimCount
    });

    activeTrial.runs.push(run);
    await saveRun(currentAssay.assayId, activeTrial.trialId, run);

    // Transition UI
    setState(STATES.RUNNING);
    UI.Buttons.tap.textContent       = "Tap";
    UI.Displays.totalStim.textContent = currentAssay.stimCount;
    UI.Displays.currentStim.textContent = "1";

    runStartTime = Date.now();
    requestWakeLock();
    startCueLoop();
  }

  /**
   * Seeds the scheduling timestamps using the AudioContext clock and starts
   * the Web Worker metronome heartbeat.
   *
   * The 0.5s offset gives the audio context time to warm up before the first
   * tick fires, preventing the first beep from being clipped or delayed.
   */
  function startCueLoop() {
    // Reset all scheduling counters
    currentStimulusIndex    = 0;
    nextSpeechIndex         = 0;
    nextAudioStimulusIndex  = 0;
    tapTimestamps           = [];
    lastSchedulerTime       = 0;
    lastBatchSaveIndex      = 0;

    const startTime = getAudioTime() + 0.5;  // 500ms warm-up delay

    nextAudioScheduleTime  = startTime;
    nextSpeechTime         = startTime;
    nextDataIntervalTime   = startTime + currentAssay.isi;  // First window closes after one ISI

    timerWorker.postMessage("start");
    visualAnimationFrame = requestAnimationFrame(renderVisualMetronome);
  }


  /* -----------------------------------------------------------------------
     Scheduling Pipeline (Core)
  ----------------------------------------------------------------------- */

  /**
   * The main scheduler function — called on every Worker "tick" (~40×/sec).
   *
   * Runs three sequential layers:
   *
   *   Step 0: TIMING INTEGRITY CHECK
   *     Detects if the gap since the last tick is suspiciously large
   *     (indicates backgrounding or browser throttling). If so, stops the
   *     run and marks it ineligible to prevent recording garbage data.
   *
   *   Step 1: SPEECH / UI SYNC
   *     Fires at the opening of each stimulus window.
   *     Updates the stimulus counter and triggers optional voice cues.
   *
   *   Step 2: DATA RECORDING
   *     Fires at the closing of each stimulus window.
   *     Checks whether a tap occurred during that interval and records 0 or 1.
   *     Batch-saves to IDB every BATCH_SAVE_INTERVAL stimuli.
   *     Triggers run completion when all stimuli are recorded.
   *
   *   Step 3: AUDIO PRE-SCHEDULING
   *     Schedules hardware beeps slightly ahead of time using the AudioContext
   *     clock to guarantee timing accuracy independent of JS thread load.
   */
  function scheduler() {
    const activeTrial = getActiveTrial(currentAssay);
    const run         = activeTrial?.runs.find(r => r.status === "active");

    // Safety: if there's no active run, halt the loop
    if (!run) {
      stopCueLoop();
      return;
    }

    const currentTime = getAudioTime();

    // ── Step 0: Timing gap detection ───────────────────────────────────────
    if (lastSchedulerTime > 0) {
      const gap            = currentTime - lastSchedulerTime;
      const maxAllowedGap  = Math.max(currentAssay.isi * 2, 1.0);

      if (gap > maxAllowedGap) {
        console.error(
          `Timing gap: ${gap.toFixed(3)}s exceeds max ${maxAllowedGap.toFixed(3)}s — ` +
          `auto-stopping run (device was backgrounded or throttled)`
        );
        stopRunEarly("Timing interrupted — device was backgrounded or throttled");
        return;
      }
    }
    lastSchedulerTime = currentTime;

    // ── Step 1: Speech & UI sync (fires at stimulus open) ──────────────────
    while (currentTime >= nextSpeechTime && nextSpeechIndex < currentAssay.stimCount) {
      const displayIndex = nextSpeechIndex + 1;  // 1-based for display

      UI.Displays.currentStim.textContent = displayIndex;
      triggerImmediateSpeech(displayIndex, currentAssay.isi);

      nextSpeechTime += currentAssay.isi;
      nextSpeechIndex++;
    }

    // ── Step 2: Data recording (fires at stimulus close) ───────────────────
    while (currentTime >= nextDataIntervalTime && currentStimulusIndex < currentAssay.stimCount) {
      const intervalStart = nextDataIntervalTime - currentAssay.isi;
      const intervalEnd   = nextDataIntervalTime;

      // Check if the experimenter tapped within this stimulus window
      const tapOccurred = tapTimestamps.some(t => t >= intervalStart && t < intervalEnd);

      // Encoding:
      //   1 = animal responded (default — experimenter did NOT tap)
      //   0 = animal did not respond (experimenter tapped to record non-response)
      run.values.push(tapOccurred ? 0 : 1);

      // Batch save: flush to IDB periodically to reduce transaction overhead
      const stimsSinceLastSave = currentStimulusIndex - lastBatchSaveIndex;
      if (stimsSinceLastSave >= BATCH_SAVE_INTERVAL) {
        saveRun(currentAssay.assayId, activeTrial.trialId, run).catch(err =>
          console.error("Batch save failed:", err)
        );
        lastBatchSaveIndex = currentStimulusIndex;
      }

      // Prune timestamps that are now in the past (before this window's end)
      tapTimestamps = tapTimestamps.filter(t => t >= intervalEnd);

      // Reset visual "bucket fulfilled" indicators for the next interval
      UI.Buttons.tap.classList.remove("bucket-fulfilled");
      const metronomeBar = document.getElementById("visualMetronomeBar");
      if (metronomeBar) metronomeBar.classList.remove("fulfilled");

      currentStimulusIndex++;
      nextDataIntervalTime += currentAssay.isi;

      // Check if all stimuli for this run are recorded
      if (run.values.length === run.expectedStimCount) {
        stopCueLoop();
        completeRunNormally();
        return;  // Exit scheduler immediately — run is over
      }
    }

    // ── Step 3: Audio pre-scheduling (fires slightly ahead of time) ────────
    while (
      nextAudioScheduleTime < currentTime + SCHEDULE_AHEAD_TIME &&
      nextAudioStimulusIndex < currentAssay.stimCount
    ) {
      scheduleWebAudioTick(nextAudioStimulusIndex + 1, currentAssay.isi, nextAudioScheduleTime);
      nextAudioScheduleTime += currentAssay.isi;
      nextAudioStimulusIndex++;
    }
  }


  /* -----------------------------------------------------------------------
     Run Lifecycle — Stop / Complete
  ----------------------------------------------------------------------- */

  /**
   * Halts the Worker heartbeat and cancels the visual animation frame.
   * Does not modify any data — call before any run-ending function.
   */
  function stopCueLoop() {
    timerWorker.postMessage("stop");
    if (visualAnimationFrame !== null) {
      cancelAnimationFrame(visualAnimationFrame);
      visualAnimationFrame = null;
    }
  }

  /**
   * Called when a run completes naturally (all stimuli recorded).
   *
   * Marks the run as completed, evaluates eligibility for analysis,
   * saves the final state to IDB, plays the completion chime, and
   * returns the UI to POISED state so the next run can begin.
   */
  async function completeRunNormally() {
    const activeTrial = getActiveTrial(currentAssay);
    const run         = activeTrial.runs.find(r => r.status === "active");
    if (!run) return;

    completeRun(run);

    // A run is eligible for analysis only if it recorded the full expected stimulus count
    run.eligibleForAnalysis = (run.values.length === run.expectedStimCount);

    if (!run.eligibleForAnalysis) {
      run.ineligibleReason = "Incomplete stimulus count";
    } else {
      // Pre-compute and cache binned percentages on the run object
      run.binnedPercentages = binRunValues(run.values, currentAssay.binSize);
    }

    // Warn if the stimulus count is not an exact multiple of binSize —
    // trailing values will be silently dropped during analysis
    const remainder = run.values.length % currentAssay.binSize;
    if (remainder !== 0) {
      run.partialBinWarning =
        `Last ${remainder} value(s) dropped — do not fill a complete bin of size ${currentAssay.binSize}`;
    }

    // Final save: ensures all values are in IDB regardless of batch timing
    await saveRun(currentAssay.assayId, activeTrial.trialId, run);

    // Completion feedback
    playCompletionTone();
    try {
      if (navigator.vibrate) navigator.vibrate([100, 50, 200]);  // Ascending haptic pattern
    } catch (e) { /* Haptics not supported — silently ignore */ }

    // Update the UI and return to POISED state for the next run
    updateProgressTable();
    document.getElementById("assayProgress").hidden = false;
    UI.Buttons.progress.textContent = "Hide Progress";
    refreshGenotypeDropdownCounts();
    releaseWakeLock();
    setState(STATES.POISED);
  }

  /**
   * Aborts an in-progress run and marks it as ineligible for analysis.
   * Called by: the Stop Run button, the timing gap detector, and crash guards.
   *
   * @param {string} [reason="Run stopped early by user"] - Explanation for the stop.
   */
  function stopRunEarly(reason = "Run stopped early by user") {
    isWarmingUp = false;
    stopCueLoop();
    stopSpeech();

    const activeTrial = getActiveTrial(currentAssay);
    const run         = activeTrial?.runs.find(r => r.status === "active");
    if (!run) return;

    // Tag the run with ineligibility information
    run.status               = "stoppedEarly";
    run.endedAt              = Date.now();
    run.eligibleForAnalysis  = false;
    run.ineligibleReason     = reason;

    saveRun(currentAssay.assayId, activeTrial.trialId, run).catch(err =>
      console.error("Failed to save stopped run:", err)
    );

    // Update UI and return to POISED state
    updateProgressTable();
    document.getElementById("assayProgress").hidden = false;
    UI.Buttons.progress.textContent = "Hide Progress";
    refreshGenotypeDropdownCounts();
    releaseWakeLock();
    setState(STATES.POISED);
  }


  /* -----------------------------------------------------------------------
     Tap Action Handler
  ----------------------------------------------------------------------- */

  /**
   * Central handler for all tap/keypress inputs.
   *
   * Routes differently depending on current state:
   *   CONFIGURED / POISED: double-tap confirmation → start warmup → start run
   *   RUNNING:             record a tap timestamp for the current stimulus window
   *
   * Also handles:
   *   - Hardware debounce (TAP_COOLDOWN_MS)
   *   - Audio context warm-up on first interaction
   *   - Visual and haptic feedback on every tap
   */
  async function executeTapAction() {
    // Block taps on the export screen entirely
    if (currentState === STATES.EXPORT) return;

    // ── Hardware debounce ─────────────────────────────────────────────────
    const now = Date.now();
    if (now - lastTapTime < TAP_COOLDOWN_MS) return;
    lastTapTime = now;

    const isStartingNewRun = (currentState === STATES.CONFIGURED || currentState === STATES.POISED);

    // ── Pre-flight checks (only when starting a new run) ──────────────────
    if (isStartingNewRun) {
      const selectedGenotype = UI.Inputs.genotypeSelect.value;

      if (!selectedGenotype) {
        alert("Please select a genotype before starting the timer.");
        return;
      }

      if (!pendingStart) {
        // First tap: show confirmation prompt and set a 2-second reset timer
        pendingStart = true;

        // Count only finished runs so the displayed index is accurate
        const activeTrial = getActiveTrial(currentAssay);
        const nextIndex   = activeTrial.runs.filter(
          r => r.genotype === selectedGenotype && r.status !== "active"
        ).length + 1;

        UI.Buttons.tap.textContent = `Tap again to start ${selectedGenotype} (Animal ${nextIndex})`;

        clearTimeout(startTimeout);
        startTimeout = setTimeout(() => {
          pendingStart = false;
          if (currentState === STATES.CONFIGURED || currentState === STATES.POISED) {
            UI.Buttons.tap.textContent = `Start ${selectedGenotype} (Animal ${nextIndex})`;
          }
        }, 2000);

        return;  // Wait for the second tap
      }

      // Second tap: proceed to start
      pendingStart = false;
      clearTimeout(startTimeout);
    }

    // ── Audio warm-up (first interaction) ────────────────────────────────
    if (!isAudioReady()) {
      warmUpAudio();
      speak("");  // Unblocks the speech engine on iOS
    }

    // ── Visual & haptic feedback ──────────────────────────────────────────
    UI.Buttons.tap.classList.add("tapped");
    setTimeout(() => UI.Buttons.tap.classList.remove("tapped"), 100);

    try {
      if (navigator.vibrate) navigator.vibrate(50);
    } catch (err) {
      console.warn("Haptics not supported/allowed:", err);
    }

    // ── Route the action ──────────────────────────────────────────────────
    if (currentState === STATES.RUNNING) {
      // Record the tap's AudioContext timestamp for the data recording layer
      tapTimestamps.push(getAudioTime());

      // Visual indicator: "bucket fulfilled" shows the tap was registered
      UI.Buttons.tap.classList.add("bucket-fulfilled");
      const metronomeBar = document.getElementById("visualMetronomeBar");
      if (metronomeBar) metronomeBar.classList.add("fulfilled");

    } else if (isStartingNewRun) {
      // Start the warmup countdown (which then calls startRun)
      await runWarmup();
    }
  }


  /* -----------------------------------------------------------------------
     Warmup Countdown
  ----------------------------------------------------------------------- */

  /**
   * Plays an optional countdown (warmupDuration seconds) before starting a run.
   * Shows a large number countdown in the UI and plays a beep each second.
   *
   * If warmup is disabled in Settings, calls startRun() immediately.
   * The isWarmingUp flag prevents re-entry if the user taps during the countdown.
   *
   * The countdown checks each iteration whether it should still be running,
   * so it can be cancelled cleanly if the state changes unexpectedly.
   */
  async function runWarmup() {
    if (isWarmingUp) return;

    if (!isWarmupEnabled) {
      startRun();
      return;
    }

    isWarmingUp                    = true;
    UI.Displays.warmup.hidden      = false;
    UI.Buttons.tap.hidden          = true;

    for (let i = warmupDuration; i > 0; i--) {
      // Cancel if the state has changed externally (e.g. stop was clicked)
      if (!isWarmingUp || (currentState !== STATES.CONFIGURED && currentState !== STATES.POISED)) {
        isWarmingUp               = false;
        UI.Displays.warmup.hidden = true;
        UI.Buttons.tap.hidden     = false;
        return;
      }

      UI.Displays.warmup.textContent = i;
      playWarmupTone(1200);  // High beep each countdown second

      await new Promise(r => setTimeout(r, 1000));
    }

    isWarmingUp               = false;
    UI.Displays.warmup.hidden = true;
    UI.Buttons.tap.hidden     = false;
    startRun();
  }


  /* -----------------------------------------------------------------------
     Visual Metronome Renderer
  ----------------------------------------------------------------------- */

  /**
   * Draws the visual progress bar that sweeps left-to-right across each
   * stimulus interval, synced to the AudioContext clock.
   *
   * Uses requestAnimationFrame to run at display refresh rate.
   * The bar position is calculated purely from the AudioContext time,
   * so it stays perfectly in sync with audio regardless of frame rate.
   */
  function renderVisualMetronome() {
    if (currentState !== STATES.RUNNING || !currentAssay) return;

    const currentTime   = getAudioTime();
    const intervalStart = nextDataIntervalTime - currentAssay.isi;

    // Progress: 0.0 at interval start → 1.0 at interval end
    let progress = (currentTime - intervalStart) / currentAssay.isi;
    progress     = Math.max(0, Math.min(1, progress));  // Clamp to [0, 1]

    const bar = document.getElementById("visualMetronomeBar");
    if (bar) bar.style.width = `${progress * 100}%`;

    // Schedule the next frame
    visualAnimationFrame = requestAnimationFrame(renderVisualMetronome);
  }


  /* -----------------------------------------------------------------------
     UI Renderers & Data Helpers
  ----------------------------------------------------------------------- */

  /**
   * Adds a red asterisk (*) next to the label of every required form field.
   * Runs once at startup so CSS doesn't need to carry this concern.
   */
  function formatRequiredLabels() {
    document.querySelectorAll("input[required], select[required]").forEach(input => {
      const label = input.id
        ? document.querySelector(`label[for="${input.id}"]`)
        : input.closest("label");

      if (!label || label.querySelector(".required-asterisk")) return;

      const textNode = Array.from(label.childNodes).find(
        node => node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== ""
      );

      if (textNode) {
        const wrapper = document.createElement("span");
        wrapper.innerHTML = `${textNode.nodeValue.trim()} <span class="required-asterisk">*</span>`;
        label.replaceChild(wrapper, textNode);
      }
    });
  }

  /**
   * Restores user preferences from localStorage and applies them to the UI.
   * Called once during initialisation.
   */
  function initializeSettings() {
    // Warmup settings
    UI.Settings.warmupToggle.checked              = isWarmupEnabled;
    UI.Settings.warmupDurationInput.value         = warmupDuration;
    UI.Settings.warmupDurationContainer.style.display = isWarmupEnabled ? "flex" : "none";

    // Theme
    const savedTheme = localStorage.getItem("touchAssayTheme") || "light";
    document.documentElement.setAttribute("data-theme", savedTheme);
    document.querySelectorAll('input[name="themeMode"]').forEach(input => {
      if (input.value === savedTheme) input.checked = true;
    });

    // Voice mode
    const savedVoiceMode = localStorage.getItem("touchAssayVoiceMode") || "tick";
    setVoiceMode(savedVoiceMode);
    document.querySelectorAll('input[name="voiceMode"]').forEach(input => {
      if (input.value === savedVoiceMode) input.checked = true;
    });
  }

  /**
   * Calculates and displays a warning when the stimulus count is not an
   * exact multiple of the bin size (some trailing stimuli will be dropped).
   * Called whenever either input field changes.
   */
  function updateBinWarning() {
    const stimCount = Number(UI.Inputs.stimCount.value);
    const binSize   = Number(UI.Inputs.binSize.value);

    if (!stimCount || !binSize || stimCount % binSize === 0) {
      UI.Displays.binWarning.hidden = true;
      return;
    }

    const usable = stimCount - (stimCount % binSize);
    UI.Displays.binWarning.textContent =
      `Total stimulations (${stimCount}) are not an exact multiple of bin size (${binSize}). ` +
      `Binned analysis will include the first ${usable} stimulations.`;
    UI.Displays.binWarning.hidden = false;
  }

  /**
   * Rebuilds the genotype selection dropdown with current run counts.
   * The count shows how many runs have been completed (non-active) for each genotype
   * in the current trial, giving the experimenter live feedback.
   *
   * Restores the previously selected value after rebuilding.
   *
   * @param {string[]} genotypes - Ordered list of genotype labels.
   */
  function populateGenotypeSelect(genotypes) {
    const trial          = currentAssay ? getActiveTrial(currentAssay) : null;
    const previousValue  = UI.Inputs.genotypeSelect.value;

    UI.Inputs.genotypeSelect.innerHTML =
      `<option value="" disabled selected>Select Genotype</option>`;

    genotypes.forEach(g => {
      const option  = document.createElement("option");
      option.value  = g;

      // Count completed (non-active) runs for this genotype
      const count   = trial
        ? trial.runs.filter(r => r.genotype === g && r.status !== "active").length
        : 0;

      option.textContent = count > 0 ? `${g} (${count} done)` : g;
      UI.Inputs.genotypeSelect.appendChild(option);
    });

    // Restore the selection if the previously selected genotype still exists
    const options = Array.from(UI.Inputs.genotypeSelect.options);
    if (previousValue && options.some(o => o.value === previousValue)) {
      UI.Inputs.genotypeSelect.value = previousValue;
    }
  }

  /**
   * Re-populates the genotype dropdown to reflect updated run counts
   * without changing the current selection. Called after each run ends.
   */
  function refreshGenotypeDropdownCounts() {
    if (!currentAssay) return;
    populateGenotypeSelect(currentAssay.genotypes);
  }

  /**
   * Rebuilds the in-assay progress summary table showing total, eligible,
   * and ineligible run counts per genotype for the current trial.
   */
  function updateProgressTable() {
    const container = document.getElementById("assayProgress");
    container.innerHTML = "";

    if (!currentAssay || !getActiveTrial(currentAssay)) return;

    const trial   = getActiveTrial(currentAssay);
    const summary = {};

    // Initialise counters for every declared genotype
    currentAssay.genotypes.forEach(g => {
      summary[g] = { total: 0, eligible: 0, ineligible: 0 };
    });

    // Tally runs into the appropriate bucket
    trial.runs.forEach(r => {
      if (!summary[r.genotype]) return;
      summary[r.genotype].total++;
      if (r.status === "completed" && r.eligibleForAnalysis) {
        summary[r.genotype].eligible++;
      } else if (r.status !== "active") {
        summary[r.genotype].ineligible++;
      }
    });

    let html = `<table><thead><tr>` +
               `<th>Genotype</th><th>Total Runs</th><th>Eligible</th><th>Ineligible</th>` +
               `</tr></thead><tbody>`;

    currentAssay.genotypes.forEach(g => {
      html += `<tr>` +
              `<td>${g}</td>` +
              `<td>${summary[g].total}</td>` +
              `<td>${summary[g].eligible}</td>` +
              `<td>${summary[g].ineligible}</td>` +
              `</tr>`;
    });

    html += `</tbody></table>`;
    container.innerHTML = html;
  }

  /**
   * Populates the export dataset list with checkboxes for each trial and
   * the two pooled (completed-only vs all-trials) options.
   * Completed trials are pre-checked; abandoned/active are unchecked.
   *
   * @param {Object} assay - The full assay object.
   */
  function populateExportDatasetList(assay) {
    const container = document.getElementById("exportDatasetList");
    container.innerHTML = "";

    if (!assay || !assay.trials) return;

    assay.trials.forEach(trial => {
      const isCompleted = trial.status === "completed";
      const isAbandoned = trial.status === "abandoned";
      const total       = trial.runs.length;
      const eligible    = trial.runs.filter(r => r.eligibleForAnalysis).length;

      container.innerHTML +=
        `<label>` +
        `<input type="checkbox" data-dataset-type="trial" data-trial-id="${trial.trialId}"` +
        ` ${isCompleted ? "checked" : ""}>` +
        ` Trial ${trial.trialIndex} — ${eligible} eligible (${total} total)` +
        `${isAbandoned ? " (abandoned)" : ""}` +
        `</label>`;
    });

    container.innerHTML +=
      `<label><input type="checkbox" data-dataset-type="pooled" ` +
      `data-include-abandoned="false" checked> Pooled (completed trials only)</label>`;

    container.innerHTML +=
      `<label><input type="checkbox" data-dataset-type="pooled" ` +
      `data-include-abandoned="true"> Pooled (include abandoned)</label>`;
  }

  /**
   * Escapes HTML special characters to prevent XSS when rendering
   * user-supplied strings (e.g. assay names) into innerHTML.
   *
   * @param {string} str - Raw user input string.
   * @returns {string} Safely escaped HTML string.
   */
  function escapeHTML(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g,  "&lt;")
      .replace(/>/g,  "&gt;")
      .replace(/"/g,  "&quot;");
  }

  /**
   * Fetches all saved assays from IndexedDB and renders them as a list
   * in the Saved Assays overlay. Each entry shows the assay name, date,
   * and action buttons (Start New Trial, Export, Delete).
   */
  async function populateSavedAssaysList() {
    const assays = await loadAllAssays();
    UI.Displays.savedAssaysList.innerHTML = "";

    if (assays.length === 0) {
      UI.Displays.savedAssaysList.textContent = "No saved assays.";
      return;
    }

    // Sort newest first
    let html = "";
    assays.sort((a, b) => b.createdAt - a.createdAt).forEach(assay => {
      html += `
        <div class="saved-assay-row">
          <div class="assay-row-header">
            <input type="checkbox" class="assay-select-checkbox" data-assay-id="${assay.assayId}">
            <div class="assay-info">
              ${escapeHTML(assay.assayName) || "Untitled"} — ${new Date(assay.createdAt).toLocaleString()}
            </div>
          </div>
          <div class="assay-actions">
            <button class="secondary" data-action="start"  data-assay-id="${assay.assayId}">Start New Trial</button>
            <button class="secondary" data-action="export" data-assay-id="${assay.assayId}">Export</button>
            <button class="danger"    data-action="delete" data-assay-id="${assay.assayId}"
              data-assay-name="${escapeHTML(assay.assayName)}">Delete</button>
          </div>
        </div>
      `;
    });

    UI.Displays.savedAssaysList.innerHTML = html;
    UI.Buttons.deleteSelectedAssays.disabled = true;
    UI.Inputs.selectAllAssays.checked        = false;
  }

  /**
   * Reads the export dataset checkboxes and returns the selected configurations.
   *
   * @returns {Array<{ type: string, trialId?: string, includeAbandoned?: boolean }>}
   */
  function getExportConfigs() {
    const checked = Array.from(
      document.querySelectorAll("#exportDatasetList input[type='checkbox']:checked")
    );
    return checked.map(input => ({
      type:             input.dataset.datasetType,
      trialId:          input.dataset.trialId,
      includeAbandoned: input.dataset.includeAbandoned === "true"
    }));
  }


  /* -----------------------------------------------------------------------
     Crash Guards (Visibility & Unload)
  ----------------------------------------------------------------------- */

  /**
   * Fires when the app is sent to the background (visibilityState = "hidden").
   * Emergency-flushes the current run data to IDB before the browser suspends us.
   *
   * The scheduler's timing gap check will stop the run when the app resumes
   * (because the gap will exceed 2×ISI), so we only need to save here, not stop.
   *
   * Also re-requests the Wake Lock when the app returns to the foreground,
   * because Wake Locks are released automatically when the page is hidden.
   */
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "hidden" && currentState === STATES.RUNNING && currentAssay) {
      const activeTrial = getActiveTrial(currentAssay);
      const run         = activeTrial?.runs.find(r => r.status === "active");
      if (run) {
        saveRun(currentAssay.assayId, activeTrial.trialId, run).catch(() => {});
      }
    }

    // Wake Locks are released when hidden; re-acquire when visible
    if (wakeLock !== null && document.visibilityState === "visible") {
      await requestWakeLock();
    }
  });

  /**
   * Fires synchronously when the user closes or refreshes the tab.
   * Marks the active run as stoppedEarly and attempts a final IDB save.
   *
   * Note: beforeunload handlers are best-effort on mobile — the save may
   * not complete before the page is torn down. The abandonAllActiveTrialsInDB()
   * cleanup on next launch catches any that slip through.
   */
  window.addEventListener("beforeunload", () => {
    if (currentState !== STATES.RUNNING || !currentAssay) return;

    const activeTrial = getActiveTrial(currentAssay);
    const run         = activeTrial?.runs.find(r => r.status === "active");

    if (run) {
      run.status               = "stoppedEarly";
      run.endedAt              = Date.now();
      run.eligibleForAnalysis  = false;
      run.ineligibleReason     = "App closed during active run";
      saveRun(currentAssay.assayId, activeTrial.trialId, run).catch(() => {});
    }
  });


  /* -----------------------------------------------------------------------
     Web Worker Communication
  ----------------------------------------------------------------------- */

  /**
   * Receives heartbeat ticks from the timer-worker.
   * Only calls scheduler() when the app is actively in RUNNING state
   * to prevent spurious processing during other states.
   */
  timerWorker.onmessage = function (e) {
    if (e.data === "tick" && currentState === STATES.RUNNING && currentAssay) {
      scheduler();
    }
  };


  /* -----------------------------------------------------------------------
     Event Bindings
  ----------------------------------------------------------------------- */

  // ── Form submission (assay setup) ───────────────────────────────────────
  UI.Forms.setup.addEventListener("submit", async function (event) {
    event.preventDefault();

    const setupValues = {
      assayName:   UI.Inputs.assayName.value.trim(),
      genotypes:   UI.Inputs.genotypes.value.split(",").map(g => g.trim()).filter(g => g !== ""),
      isi:         Number(UI.Inputs.isi.value),
      stimCount:   Number(UI.Inputs.stimCount.value),
      binSize:     Number(UI.Inputs.binSize.value),
      temperature: Number(UI.Inputs.temperature.value),
      humidity:    Number(UI.Inputs.humidity.value)
    };

    const validation = validateInputs(setupValues);
    if (!validation.isValid) {
      alert("Please fix the following errors:\n\n• " + validation.errors.join("\n• "));
      return;
    }

    // Create and persist the assay and its first trial
    currentAssay = createAssay(setupValues);
    await saveAssay(currentAssay);

    const firstTrial = createTrial(1);
    currentAssay.trials.push(firstTrial);
    await saveTrial(currentAssay.assayId, firstTrial);

    populateGenotypeSelect(setupValues.genotypes);
    setState(STATES.CONFIGURED);
  });

  // ── Bin warning live update ─────────────────────────────────────────────
  UI.Inputs.stimCount.addEventListener("input", updateBinWarning);
  UI.Inputs.binSize.addEventListener("input",   updateBinWarning);

  // ── Tap button (pointerdown avoids 300ms mobile ghost-click delay) ──────
  UI.Buttons.tap.addEventListener("pointerdown", e => {
    e.preventDefault();  // Prevents ghost click / double-fire on touch devices
    executeTapAction();
  });

  // ── Space bar shortcut ──────────────────────────────────────────────────
  document.addEventListener("keydown", event => {
    // Ignore if a form field is focused or if the key is being held down
    if (event.repeat) return;
    if (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "SELECT") return;

    if (event.key === " ") {
      event.preventDefault();
      if (!UI.Buttons.tap.disabled) executeTapAction();
    }
  });

  // ── Stop run button ─────────────────────────────────────────────────────
  UI.Buttons.stopRun.addEventListener("click", () => stopRunEarly());

  // ── Finish trial button ─────────────────────────────────────────────────
  UI.Buttons.finishTrial.addEventListener("click", async () => {
    if (!confirm("Finish this trial? You will not be able to add more runs to this trial.")) return;

    const activeTrial = getActiveTrial(currentAssay);

    if (activeTrial.runs.length === 0) {
      await markTrialAbandoned(currentAssay.assayId, activeTrial.trialId, "No runs recorded");
    } else {
      await markTrialCompleted(currentAssay.assayId, activeTrial.trialId);
    }

    // Hydrate FIRST so the export list reflects the updated trial status
    currentAssay = await hydrateAssay(currentAssay.assayId);
    populateExportDatasetList(currentAssay);
    setState(STATES.EXPORT);
  });

  // ── Show/hide progress table ────────────────────────────────────────────
  UI.Buttons.progress.addEventListener("click", () => {
    const progressContainer            = document.getElementById("assayProgress");
    progressContainer.hidden           = !progressContainer.hidden;
    UI.Buttons.progress.textContent    = progressContainer.hidden ? "Show Progress" : "Hide Progress";
  });

  // ── Genotype selection change — update tap button label ─────────────────
  UI.Inputs.genotypeSelect.addEventListener("change", e => {
    if (currentState === STATES.CONFIGURED || currentState === STATES.POISED) {
      const selected    = e.target.value;
      const activeTrial = getActiveTrial(currentAssay);
      const nextIndex   = activeTrial.runs.filter(
        r => r.genotype === selected && r.status !== "active"
      ).length + 1;

      UI.Buttons.tap.textContent = `Start ${selected} (Animal ${nextIndex})`;

      // Reset the double-tap guard when the genotype changes
      pendingStart = false;
      clearTimeout(startTimeout);
    }
  });

  // ── Start new trial (from export screen) ───────────────────────────────
  UI.Buttons.backToAssay.addEventListener("click", async () => {
    const trial = createTrial(currentAssay.trials.length + 1);
    currentAssay.trials.push(trial);
    await saveTrial(currentAssay.assayId, trial);  // await: run start must not race DB write
    populateGenotypeSelect(currentAssay.genotypes);
    updateProgressTable();
    // POISED (not CONFIGURED): this assay already exists; Finish Trial must be
    // immediately available in case the experimenter only needs one run.
    setState(STATES.POISED);
  });

  // ── New assay ───────────────────────────────────────────────────────────
  UI.Buttons.newAssay.addEventListener("click", () => {
    currentAssay = null;
    UI.Forms.setup.reset();
    UI.Inputs.assayName.value    = generateAutoID();
    UI.Displays.binWarning.hidden = true;

    // Reset all timing/scheduling state to prevent stale values
    // from a previous run affecting the next one
    currentStimulusIndex   = 0;
    tapTimestamps          = [];
    lastSchedulerTime      = 0;
    lastBatchSaveIndex     = 0;
    nextAudioScheduleTime  = 0.0;
    nextSpeechTime         = 0.0;
    nextDataIntervalTime   = 0.0;

    setState(STATES.SETUP);
  });

  // ── Overlay navigation ──────────────────────────────────────────────────
  UI.Buttons.openSettings.addEventListener("click",   () => showScreen(UI.Screens.settings));
  UI.Buttons.closeSettings.addEventListener("click",  () => hideScreenAndRestore(UI.Screens.settings));
  UI.Buttons.openGuidelines.addEventListener("click", () => showScreen(UI.Screens.guidelines));
  UI.Buttons.closeGuidelines.addEventListener("click",() => hideScreenAndRestore(UI.Screens.guidelines));

  UI.Buttons.openSavedAssays.addEventListener("click", () => {
    showScreen(UI.Screens.savedAssays);
    populateSavedAssaysList();
  });
  UI.Buttons.closeSavedAssays.addEventListener("click", () =>
    hideScreenAndRestore(UI.Screens.savedAssays)
  );

  // ── Overflow menu toggle ────────────────────────────────────────────────
  UI.Buttons.overflowMenu.addEventListener("click", e => {
    e.stopPropagation();  // Prevent the document click handler from immediately closing it
    UI.Displays.overflowMenu.hidden = !UI.Displays.overflowMenu.hidden;
  });

  // Close the overflow menu when clicking anywhere outside it
  document.addEventListener("click", e => {
    if (!UI.Displays.overflowMenu.hidden && !UI.Displays.overflowMenu.contains(e.target)) {
      UI.Displays.overflowMenu.hidden = true;
    }
  });

  // ── Saved assays list — event delegation ───────────────────────────────
  UI.Displays.savedAssaysList.addEventListener("click", async e => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;

    const action  = btn.dataset.action;
    const assayId = btn.dataset.assayId;

    if (action === "start") {
      currentAssay = await hydrateAssay(assayId);
      populateGenotypeSelect(currentAssay.genotypes);

      // Abandon any previously active trial (shouldn't exist, but guard anyway)
      const active = getActiveTrial(currentAssay);
      if (active) {
        await markTrialAbandoned(currentAssay.assayId, active.trialId, "Started new trial from saved assays");
      }

      const newTrial = createTrial(currentAssay.trials.length + 1);
      currentAssay.trials.push(newTrial);
      await saveTrial(currentAssay.assayId, newTrial);

      hideScreenAndRestore(UI.Screens.savedAssays);
      setState(STATES.POISED);

    } else if (action === "export") {
      currentAssay = await hydrateAssay(assayId);
      hideScreenAndRestore(UI.Screens.savedAssays);
      populateExportDatasetList(currentAssay);
      setState(STATES.EXPORT);

    } else if (action === "delete") {
      const name = btn.dataset.assayName || "this assay";
      if (confirm(`Delete ${name}?`)) {
        try {
          await deleteAssay(assayId);
          await populateSavedAssaysList();
        } catch (err) {
          console.error("Delete failed:", err);
          alert(`Failed to delete "${name}". Please try again.`);
        }
      }
    }  // end action routing
  });

  // ── Saved assays bulk selection ─────────────────────────────────────────
  UI.Displays.savedAssaysList.addEventListener("change", e => {
    if (!e.target.classList.contains("assay-select-checkbox")) return;

    const all     = document.querySelectorAll(".assay-select-checkbox");
    const checked = document.querySelectorAll(".assay-select-checkbox:checked");

    UI.Buttons.deleteSelectedAssays.disabled = checked.length === 0;
    UI.Inputs.selectAllAssays.checked        = checked.length === all.length && all.length > 0;
  });

  UI.Inputs.selectAllAssays.addEventListener("change", e => {
    const isChecked = e.target.checked;
    document.querySelectorAll(".assay-select-checkbox").forEach(cb => {
      cb.checked = isChecked;
    });
    const all = document.querySelectorAll(".assay-select-checkbox");
    UI.Buttons.deleteSelectedAssays.disabled = !isChecked || all.length === 0;
  });

  UI.Buttons.deleteSelectedAssays.addEventListener("click", async () => {
    const checked = document.querySelectorAll(".assay-select-checkbox:checked");
    if (checked.length === 0) return;

    if (!confirm(`Are you sure you want to permanently delete ${checked.length} selected assays?`)) return;

    UI.Buttons.deleteSelectedAssays.textContent = "Deleting...";
    UI.Buttons.deleteSelectedAssays.disabled    = true;

    const idsToDelete = Array.from(checked).map(cb => cb.dataset.assayId);
    let failCount = 0;

    // Delete sequentially — parallel deletes on the same cached IDB connection
    // can interleave their write transactions and cause silent aborts.
    for (const id of idsToDelete) {
      try {
        await deleteAssay(id);
      } catch (err) {
        console.error(`Failed to delete assay ${id}:`, err);
        failCount++;
      }
    }

    if (failCount > 0) {
      alert(`${failCount} assay(s) could not be deleted. The rest were removed.`);
    }

    UI.Buttons.deleteSelectedAssays.textContent = "Delete Selected";
    await populateSavedAssaysList();
  });

  // ── Settings ────────────────────────────────────────────────────────────
  UI.Settings.warmupToggle.addEventListener("change", e => {
    isWarmupEnabled = e.target.checked;
    localStorage.setItem("touchAssayWarmupEnabled", isWarmupEnabled);
    UI.Settings.warmupDurationContainer.style.display = isWarmupEnabled ? "flex" : "none";
  });

  UI.Settings.warmupDurationInput.addEventListener("change", e => {
    warmupDuration = Math.max(1, parseInt(e.target.value, 10));
    localStorage.setItem("touchAssayWarmupDuration", warmupDuration);
  });

  document.querySelectorAll('input[name="themeMode"]').forEach(input => {
    input.addEventListener("change", e => {
      if (!e.target.checked) return;
      document.documentElement.setAttribute("data-theme", e.target.value);
      document.querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", e.target.value === "dark" ? "#1f2937" : "#ffffff");
      localStorage.setItem("touchAssayTheme", e.target.value);
    });
  });

  document.querySelectorAll('input[name="voiceMode"]').forEach(input => {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      stopSpeech();
      setVoiceMode(input.value);
      localStorage.setItem("touchAssayVoiceMode", input.value);
    });
  });

  // ── Export ──────────────────────────────────────────────────────────────
  UI.Buttons.exportExcel.addEventListener("click", () => {
    if (!currentAssay) return;

    const configs = getExportConfigs();
    if (configs.length === 0) {
      alert("Please select a dataset.");
      return;
    }

    // If SheetJS isn't loaded (offline / CDN failure), fall back to CSV silently
    if (typeof XLSX === "undefined") {
      const result = performCSVExport(currentAssay, configs);
      if (!result.success) alert("Export failed: " + result.error);
      return;
    }

    const result = performExcelExport(currentAssay, configs);
    if (!result.success) {
      if (confirm(`Excel export failed: ${result.error}\n\nWould you like to export as CSV instead?`)) {
        performCSVExport(currentAssay, configs);
      }
    }
  });

  UI.Buttons.previewExcel.addEventListener("click", () => {
    if (!currentAssay) return;

    const configs = getExportConfigs();
    if (configs.length === 0) {
      alert("Please select a dataset to preview.");
      return;
    }

    UI.Displays.previewContainer.innerHTML = generatePreviewHTML(currentAssay, configs);
    UI.Displays.previewModal.hidden        = false;
  });

  // Close preview modal via button or backdrop click
  UI.Displays.closePreview.addEventListener("click", () => {
    UI.Displays.previewModal.hidden = true;
  });

  UI.Displays.previewModal.addEventListener("click", e => {
    if (e.target === UI.Displays.previewModal) {
      UI.Displays.previewModal.hidden = true;
    }
  });

  UI.Buttons.exportFromPreview.addEventListener("click", () => {
    UI.Buttons.exportExcel.click();       // Delegate to the main export handler
    UI.Displays.previewModal.hidden = true;
  });

  // ── Diagnostic logging ──────────────────────────────────────────────────
  UI.Buttons.downloadLogs.addEventListener("click", async () => {
    UI.Buttons.downloadLogs.textContent = "Processing...";
    await downloadLogs();
    UI.Buttons.downloadLogs.textContent = "Download Logs";
  });

  UI.Buttons.clearLogs.addEventListener("click", async () => {
    if (confirm("Are you sure you want to permanently delete all system logs?")) {
      await clearLogs();
      alert("System logs cleared.");
    }
  });

});  // end DOMContentLoaded
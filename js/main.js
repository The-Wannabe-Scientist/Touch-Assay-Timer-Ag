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
 * Scheduling pipeline (fires ~125×/sec via timer-worker.js):
 *
 *   Worker "tick" → scheduler() {
 *     Step 0: Gap check — auto-stop if timing gap > 2×ISI (backgrounding detected)
 *     Step 1: Speech/UI layer  — update counter, trigger voice cue at stimulus open
 *     Step 2: Data layer       — record 0/1 at stimulus close, batch-save to IDB
 *     Step 3: Audio layer      — pre-schedule hardware beep slightly in advance
 *   }
 */


import { validateInputs, generateAutoID, binRunValues, escapeHTML, formatDateTime } from "./utils.js";  // escapeHTML is shared from utils.js
import {
  createAssay, createTrial, createRun,
  getActiveTrial, completeRun
}                                                      from "./models.js";
import {
  saveAssay, loadAllAssays, hydrateAssay, deleteAssay,
  saveTrial, markTrialCompleted, markTrialAbandoned,
  saveRun, abandonAllActiveTrialsInDB, markOrphanRunsStopped, getIdbAvailable,
  recoverCrashGuard, exportAllDataAsJSON, importAllDataFromJSON
}                                                      from "./db.js";
import {
  isAudioReady, setVoiceMode, getVoiceMode, loadVoices, speak, stopSpeech,
  warmUpAudio, playWarmupTone, scheduleWebAudioTick,
  triggerImmediateSpeech, getAudioTime, playCompletionTone,
  setTickPitch, getTickPitch, primeSpeechEngine, setBinSpeak,
  playTick
}                                                      from "./audio.js";
import {
  performExcelExport, performCSVExport, generatePreviewHTML, RUN_STATUS_LABELS
}                                                      from "./export.js";
import { showToast, dismissLatestToast }                from "./toast.js";
import {
  isBluetoothSupported, isArmbandConnected,
  armbandConnect, armbandDisconnect,
  armbandTap, armbandRunComplete, armbandTest,
  armbandStartHeartbeat, armbandStopHeartbeat,
}                                                      from "./haptic-armband.js";


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
 * Consumed via tapReadIndex — no per-interval array reallocation needed.
 * @type {number[]}
 */
let tapTimestamps = [];

/**
 * Read pointer into tapTimestamps[].
 * All entries at indices < tapReadIndex have already been consumed by a
 * closed stimulus window and will not be checked again. This replaces
 * the previous `.some()` + `.filter()` pattern, avoiding closure and
 * array allocation on every ISI tick.
 * @type {number}
 */
let tapReadIndex = 0;

/**
 * Cached reference to the currently active run object.
 * Set once at the start of a run (startCueLoop) and cleared when the run ends.
 * Eliminates the `.find()` scan inside scheduler() which otherwise runs ~125×/sec.
 * @type {Object|null}
 */
let activeRun = null;

/**
 * Cached ISI (inter-stimulus interval) for the current run, in seconds.
 * Copied from currentAssay.isi at the start of each run so the hot path
 * in scheduler() never needs to dereference the assay object.
 * @type {number}
 */
let runISI = 0;

/**
 * Cached stimulus count for the current run.
 * Copied from currentAssay.stimCount at the start of each run.
 * @type {number}
 */
let runStimCount = 0;

/**
 * Cached bin size for the current run.
 * Copied from currentAssay.binSize at the start of each run and forwarded
 * to audio.js via setBinSpeak() so "bins" voice mode speaks on the correct
 * stimulus boundaries without dereferencing the assay object in the hot path.
 * @type {number}
 */
let runBinSize = 10;

/**
 * Grace period for the current run in seconds, clamped to half the ISI at
 * run-start. Set by startCueLoop() and read by scheduler() on every tick.
 * Using a stable cached value (rather than recomputing from gracePeriodMs
 * each tick) ensures mid-run slider changes don't affect the ongoing run.
 * @type {number}
 */
let runGraceSec = 0;

/** @type {number} AudioContext time when the next speech/UI update should fire. */
let nextSpeechTime = 0.0;

/** @type {number} AudioContext time when the next data recording window closes. */
let nextDataIntervalTime = 0.0;

/** @type {number} AudioContext time when the next hardware tick should be scheduled. */
let nextAudioScheduleTime = 0.0;

/**
 * How far ahead (in seconds) the audio scheduler pre-books hardware ticks.
 * 200ms gives enough headroom for budget Android devices where main-thread
 * pauses of 100–150ms are common (background GC, compositing, etc.).
 * Still well below any ISI used in practice (≥ 500ms) so ticks won't
 * sound early.
 * @type {number}
 */
const SCHEDULE_AHEAD_TIME = 0.20;

/**
 * AudioContext timestamp of the last scheduler() invocation.
 * Used to detect timing gaps caused by backgrounding / throttling.
 * @type {number}
 */
let lastSchedulerTime = 0;

/**
 * How many milliseconds before the stimulus opens to fire the TTS command,
 * to compensate for browser speech-engine cold-path latency (typically 50–120 ms).
 * Loaded from localStorage so users can tune it per-device in Settings.
 * @type {number}
 */
// wrap top-level localStorage reads in try/catch — accessing localStorage
// before DOMContentLoaded in restricted/Private-Browsing contexts can throw SecurityError.
let speechLeadMs = 80;  // 80 ms default
try {
  const _stored = parseInt(localStorage.getItem("touchAssaySpeechLeadMs"), 10);
  // use Math.max/min clamp (same as settings write at applyWarmupDuration)
  // so any stored value — including negatives from corrupted localStorage — is
  // consistently normalised to [0, 490] ms instead of being silently discarded.
  // Values ≥ 500 ms would push nextSpeechTime before AudioContext t0, causing the
  // first cue to fire immediately on start.
  if (!isNaN(_stored)) speechLeadMs = Math.max(0, Math.min(490, _stored));
} catch { /* Private browsing or sandboxed iframe — use default */ }

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

// runStartTime removed — was set but never read; startup time is not needed by any consumer.


/* ==========================================================================
   Hardware & Settings State
   ========================================================================== */

/** @type {WakeLockSentinel|null} Active screen Wake Lock, or null if not held. */
let wakeLock = null;

/**
 * Tracks whether a Wake Lock is currently desired.
 * Using a separate boolean (instead of checking `wakeLock !== null`) ensures the
 * visibilitychange re-acquire logic works correctly even after releaseWakeLock()
 * synchronously nulls `wakeLock` before `.release()` resolves.
 * @type {boolean}
 */
let wantsWakeLock = false;

/**
 * Whether the countdown warmup is enabled before each run.
 * Persisted in localStorage so the setting survives page refreshes.
 * @type {boolean}
 */
// wrap in try/catch (same reason as speechLeadMs above).
let isWarmupEnabled = true;
try { isWarmupEnabled = localStorage.getItem("touchAssayWarmupEnabled") !== "false"; } catch { /* use default */ }

/**
 * Duration of the warmup countdown in seconds.
 * @type {number}
 */
let warmupDuration = 3;
try { warmupDuration = Math.min(60, Math.max(1, parseInt(localStorage.getItem("touchAssayWarmupDuration"), 10) || 3)); } catch { /* use default */ }

/**
 * Human reaction grace period in milliseconds.
 * When > 0, a tap arriving up to this many ms after a stimulus window closes
 * is still credited to that interval (compensates for natural human latency).
 * 250 ms default = widely-cited average simple auditory reaction time.
 * @type {number}
 */
let gracePeriodMs = 250;
try {
  const _gp = parseInt(localStorage.getItem("touchAssayGracePeriodMs"), 10);
  // Clamp to 400 ms max and snap to step=10 on load so a stale value like
  // 255 doesn't cause a silent jump on first slider interaction.
  if (!isNaN(_gp)) gracePeriodMs = Math.max(0, Math.min(400, Math.round(_gp / 10) * 10));
} catch { /* use default */ }

/**
 * AudioContext timestamp of the last Escape keypress during RUNNING state.
 * Used to implement double-Escape-to-stop-run: two presses within 2 seconds
 * will call stopRunEarly(). 0 means no recent Escape press.
 * @type {number}
 */
let lastEscapeTime = 0;

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

  // ── Global Error Boundary ────────────────────────────────────────────────
  // unhandledrejection should NOT show the fatal overlay for
  // transient, recoverable errors (BLE write failures, IDB NotFoundError,
  // network timeouts, etc.). Only genuine unexpected JS errors escalate.
  window.addEventListener('error', (e) => handleFatalError(e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    const isTransient =
      !(reason instanceof Error) ||
      reason.name === "AbortError"    ||
      reason.name === "NotFoundError" ||
      reason.name === "NetworkError";
    if (isTransient) {
      console.warn("[Unhandled Rejection — non-fatal, skipped overlay]", reason);
      return;
    }
    handleFatalError(reason);
  });

  /**
   * Displays the full-screen fatal error boundary and wires its recovery
   * actions (download a JSON snapshot of the in-progress assay/run, or reload).
   * Called for genuine unexpected JS errors — transient/recoverable rejections
   * (BLE write failures, IDB NotFoundError, network timeouts) are filtered out
   * before reaching here (see the unhandledrejection listener above).
   *
   * @param {Error|string} err - The error (or message) to log and display.
   */
  function handleFatalError(err) {
    console.error("Fatal Error Caught:", err);
    const boundary = document.getElementById('errorBoundary');
    if (boundary) boundary.style.display = 'flex';
    const downloadBtn = document.getElementById('downloadRecoveryBtn');
    if (downloadBtn) {
      downloadBtn.onclick = () => {
        // Deep-clone both objects before serialising so that mutations that
        // triggered the fatal error cannot corrupt the recovery snapshot.
        // structuredClone is available in all modern browsers (Chrome 98+, FF 94+, Safari 15.4+).
        let safeAssay   = null;
        let safeRun     = null;
        try { safeAssay = structuredClone(currentAssay ?? {}); } catch { safeAssay = currentAssay ?? {}; }
        try { safeRun   = structuredClone(activeRun ?? null);  } catch { safeRun   = activeRun   ?? null; }
        const recoveryData = {
          assay:     safeAssay,
          activeRun: safeRun,
          timestamp: Date.now(),
        };
        const dataStr = "data:text/json;charset=utf-8," +
          encodeURIComponent(JSON.stringify(recoveryData, null, 2));
        const a = document.createElement('a');
        a.setAttribute("href", dataStr);
        a.setAttribute("download", "touch_assay_recovery_data.json");
        a.click();
      };
    }
    const reloadBtn = document.getElementById('reloadAppBtn');
    if (reloadBtn) reloadBtn.onclick = () => window.location.reload();
  }

  /**
   * Warns the user once per session if IndexedDB storage is nearly full.
   * Uses a proportional threshold (>90% of quota) rather than an absolute
   * byte count, since quota varies widely by browser/device. Checked once at
   * startup rather than continuously, to avoid toasting mid-assay.
   */
  async function checkStorageQuota() {
    if (!(navigator.storage && navigator.storage.estimate)) return;
    try {
      const { quota, usage } = await navigator.storage.estimate();
      if (!quota) return;
      if (usage / quota > 0.9 && !sessionStorage.getItem('storageWarnShown')) {
        sessionStorage.setItem('storageWarnShown', '1');
        showToast(
          // replaced stray superscript-3 (³, U+00B3) with ≥ (U+2265).
          `Storage nearly full (≥${Math.round((usage / quota) * 100)}% used). Export old data to avoid data loss.`,
          "warning", 8000
        );
      }
    } catch (e) {
      console.warn("Storage estimate failed", e);
    }
  }
  checkStorageQuota();


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
      genotypePicker:      document.getElementById("genotypePicker"),
      genotypePills:       document.getElementById("genotypePills"),
      genotypeTrigger:     document.getElementById("genotypeTrigger"),
      genotypeTriggerDot:  document.getElementById("genotypeTriggerDot"),
      genotypeTriggerLabel: document.getElementById("genotypeTriggerLabel"),
      genotypeOverlay:     document.getElementById("genotypeOverlay"),
      genotypeListbox:     document.getElementById("genotypeListbox"),
      selectAllAssays:  document.getElementById("selectAllAssays"),
      exportSelectAll:  document.getElementById("exportSelectAll"),
      importBackupFile: document.getElementById("importBackupInput"),
    },
    Screens: {
      setup:         document.getElementById("setupScreen"),
      assay:         document.getElementById("assayScreen"),
      export:        document.getElementById("exportScreen"),
      settings:      document.getElementById("settingsScreen"),
      guidelines:    document.getElementById("guidelinesScreen"),
      savedAssays:   document.getElementById("savedAssaysScreen"),
      assayDefaults: document.getElementById("assayDefaultsScreen"),
    },
    Buttons: {
      tap:                  document.getElementById("tapButton"),
      stopRun:              document.getElementById("stopRun"),
      finishTrial:          document.getElementById("finishTrial"),
      backToAssay:          document.getElementById("backToAssay"),
      newAssay:             document.getElementById("newAssay"),
      progress:             document.getElementById("toggleProgress"),
      exportExcel:          document.getElementById("exportExcel"),
      exportCSV:            document.getElementById("exportCSV"),
      previewExcel:         document.getElementById("previewExcel"),
      exportFromPreview:    document.getElementById("exportFromPreview"),
      openSettings:         document.getElementById("openSettings"),
      closeSettings:        document.getElementById("closeSettings"),
      openGuidelines:       document.getElementById("openGuidelines"),
      closeGuidelines:      document.getElementById("closeGuidelines"),
      openSavedAssays:      document.getElementById("openSavedAssays"),
      closeSavedAssays:     document.getElementById("closeSavedAssays"),
      exportBackup:         document.getElementById("exportBackupBtn"),
      importBackup:         document.getElementById("importBackupBtn"),
      overflowMenu:         document.getElementById("overflowMenuButton"),

      deleteSelectedAssays: document.getElementById("deleteSelectedAssays"),
      headerHome:           document.getElementById("headerHomeBtn"),
      armbandHeaderBtn:     document.getElementById("armbandHeaderBtn"),
      connectArmband:       document.getElementById("connectArmband"),
      disconnectArmband:    document.getElementById("disconnectArmband"),
      testArmband:          document.getElementById("testArmband"),
      testRigBtn:           document.getElementById("testRigBtn"),
    },
    Displays: {
      tapLabel:         document.getElementById("tapButtonLabel"),
      liveProgress:     document.getElementById("liveProgress"),
      currentStim:      document.getElementById("currentStimDisplay"),
      totalStim:        document.getElementById("totalStimDisplay"),
      stimulusProgressAnnouncer: document.getElementById("stimulusProgressAnnouncer"),
      testRigBtnLabel:  document.getElementById("testRigBtnLabel"),
      testRigPulse:     document.getElementById("testRigPulse"),
      warmup:           document.getElementById("warmupDisplay"),
      warmupNumber:     document.getElementById("warmupNumber"),
      binWarning:       document.getElementById("binWarning"),
      savedAssaysList:  document.getElementById("savedAssaysList"),
      previewModal:     document.getElementById("previewModal"),
      previewContainer: document.getElementById("previewContainer"),
      closePreview:     document.getElementById("closePreview"),
      overflowMenu:          document.getElementById("overflowMenu"),
      // Cached once to avoid repeated getElementById calls inside the hot scheduler loop
      metronomeBar:          document.getElementById("visualMetronomeBar"),
      armbandStatusSettings: document.getElementById("armbandStatusSettings"),
      armbandBatteryLevel:   document.getElementById("armbandBatteryLevel"),
    },
    Forms: {
      setup: document.getElementById("setupForm"),
    },
    Settings: {
      warmupToggle:             document.getElementById("warmupToggle"),
      warmupDurationInput:      document.getElementById("warmupDuration"),
      warmupDurationContainer:  document.getElementById("warmupDurationContainer"),
      tickPitch:                document.getElementById("tickPitch"),
      tickPitchDisplay:         document.getElementById("tickPitchDisplay"),
      speechLead:               document.getElementById("speechLead"),
      speechLeadDisplay:        document.getElementById("speechLeadDisplay"),
      gracePeriod:              document.getElementById("gracePeriod"),
      gracePeriodDisplay:       document.getElementById("gracePeriodDisplay"),
      // Assay Defaults sub-page inputs
      defaultISI:               document.getElementById("defaultISI"),
      defaultStimCount:         document.getElementById("defaultStimCount"),
      defaultBinSize:           document.getElementById("defaultBinSize"),
      defaultTemperature:       document.getElementById("defaultTemperature"),
      defaultHumidity:          document.getElementById("defaultHumidity"),
    }
  };

  // Genotype picker constants — declared here (as `const`, not hoisted like
  // the `function` declarations below) because setState(STATES.SETUP) in the
  // initialisation sequence just below already calls into
  // renderGenotypePicker() → assignGenotypeColors() on the very first paint.
  // Declaring these after that call would throw a temporal-dead-zone
  // ReferenceError before the app ever renders.

  /** @type {number} Above this genotype count, pills give way to the trigger+panel even on wide viewports — keeps the common small-N case fast without letting a long list wrap into multiple header rows. */
  const GENOTYPE_PILL_MAX = 5;

  /**
   * Matches the app's existing desktop breakpoint (see #tapButton in
   * styles.css). Narrow (no match) always uses the collapsed trigger, per
   * the #tapButton space-priority comment in styles.css — the picker must
   * never grow the header at the tap button's expense.
   * @type {MediaQueryList}
   */
  const GENOTYPE_WIDE_MQ = window.matchMedia("(min-width: 769px)");

  /**
   * Fixed categorical palette for genotype color accents. Order matters:
   * assignGenotypeColors() walks this in order and only reaches for the
   * adjacency-guard fallback when two consecutive genotypes would otherwise
   * land on visually similar entries.
   * @type {string[]}
   */
  const GENOTYPE_COLOR_PALETTE = [
    "#2563eb", // blue
    "#dc2626", // red
    "#059669", // green
    "#d97706", // amber
    "#7c3aed", // violet
    "#db2777", // pink
    "#0891b2", // cyan
    "#65a30d", // lime
    "#9333ea", // purple
    "#ea580c"  // orange
  ];


  /* -----------------------------------------------------------------------
     Initialisation Sequence
  ----------------------------------------------------------------------- */

  formatRequiredLabels();                    // Add * to required form fields
  UI.Inputs.assayName.value = generateAutoID(); // Pre-fill with timestamp-based ID
  restoreSetupDraft();                       // Restore any unsaved form draft
  initializeSettings();                      // Restore saved preferences from localStorage
  setState(STATES.SETUP);                    // Render the initial state

  /**
   * Cleans up orphaned sessions left by a previous crash/force-close.
   *
   * Runs three steps sequentially rather than concurrently — all three read
   * and write the same orphaned run record, and running them in parallel let
   * whichever transaction committed last silently overwrite the others'
   * status/values. Order matters: recoverCrashGuard() merges any last-second
   * values into the run while it's still "active"; abandonAllActiveTrialsInDB()
   * is the primary cleanup; markOrphanRunsStopped() is a superset safety net
   * that must run last so it doesn't race the primary cleanup's writes.
   */
  async function runStartupCleanup() {
    await recoverCrashGuard();
    await abandonAllActiveTrialsInDB();
    await markOrphanRunsStopped();
  }

  Promise.allSettled([
    runStartupCleanup()
  ]).then(() => {
    if (!getIdbAvailable()) {
      const banner = document.getElementById("idbWarningBanner");
      if (banner) banner.removeAttribute("hidden");
      showToast(
        "Storage unavailable — data will not be saved. Check browser settings.",
        "error",
        0  // persistent
      );
    }
  });


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
        renderGenotypePicker([]);
        UI.Displays.tapLabel.textContent   = "Select Genotype to Start";
        break;

      case STATES.CONFIGURED:
        UI.Inputs.genotypeSelect.disabled = false;
        UI.Buttons.tap.disabled           = false;
        UI.Buttons.progress.disabled      = false;
        UI.Buttons.stopRun.disabled       = true;
        UI.Buttons.finishTrial.disabled   = true;
        UI.Displays.tapLabel.textContent  = "Select Genotype to Start";
        break;

      case STATES.POISED:
        UI.Inputs.genotypeSelect.disabled = false;
        UI.Buttons.tap.disabled           = false;
        UI.Buttons.finishTrial.disabled   = false;
        UI.Buttons.progress.disabled      = false;
        UI.Buttons.stopRun.disabled       = true;
        // always recompute the tap button label based on the
        // currently-selected genotype. Without this, completing or stopping a
        // run snaps the label back to "Select Genotype to Start" even though
        // the dropdown still shows the previously chosen genotype.
        {
          const _pSel = UI.Inputs.genotypeSelect.value;
          if (_pSel && currentAssay) {
            const _pAt = getActiveTrial(currentAssay);
            const _pN  = (_pAt?.runs.filter(
              r => r.genotype === _pSel && r.status === "completed" && r.eligibleForAnalysis
            ).length ?? 0) + 1;
            UI.Displays.tapLabel.textContent = `Start ${_pSel} (Animal ${_pN})`;
          } else {
            UI.Displays.tapLabel.textContent = "Select Genotype to Start";
          }
        }
        break;

      case STATES.RUNNING:
        UI.Inputs.genotypeSelect.disabled = true;
        UI.Buttons.finishTrial.disabled   = true;
        UI.Buttons.progress.disabled      = true;
        UI.Buttons.tap.disabled           = false;
        UI.Buttons.stopRun.disabled       = false;
        // The "do not leave" beforeunload dialog is handled by the event listener
        // registered below — no additional setup is needed here.
        break;

      case STATES.EXPORT:
        // All controls remain as-is; export screen CSS handles visibility
        break;
    }

    // Every branch above may have just changed #genotypeSelect.disabled;
    // keep the custom picker's pills/trigger in sync without a full rebuild.
    syncGenotypePickerEnabled();
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
    UI.Buttons.overflowMenu.setAttribute("aria-expanded", "false");  // M9: reset aria-expanded
    document.body.classList.add("state-overlay");

    // Collapse all overlay screens first to avoid stacking
    UI.Screens.settings.hidden      = true;
    UI.Screens.guidelines.hidden    = true;
    UI.Screens.savedAssays.hidden   = true;
    UI.Screens.assayDefaults.hidden = true;

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
    // Stop any running Test Rig loop so it never keeps ticking/vibrating in
    // the background after Settings is closed. No-ops if it wasn't running.
    stopTestRig();
  }


  /* -----------------------------------------------------------------------
     Hardware Integration
  ----------------------------------------------------------------------- */

  /**
   * Requests a screen Wake Lock to prevent the device from sleeping during
   * an active run. Silently no-ops on browsers that don't support the API.
   */
  async function requestWakeLock() {
    wantsWakeLock = true;
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
    wantsWakeLock = false;
    if (wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      lock.release().catch(() => {});
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

    // Defensive: the Settings screen shouldn't be reachable while a real run
    // starts, but guard anyway so a Test Rig loop can never keep ticking
    // underneath an actual assay run.
    stopTestRig();

    const activeTrial = getActiveTrial(currentAssay);
    if (!activeTrial) return;

    const selectedGenotype = UI.Inputs.genotypeSelect.value;

    // guard against an empty genotype — createRun with genotype:"" would
    // silently persist an un-labelled run and corrupt exports.
    if (!selectedGenotype) {
      showToast("Please select a genotype before starting.", "info", 3000);
      return;
    }

    // Count only eligible runs for this genotype to determine the next animal index,
    // consistent with the tap-button and genotype-dropdown counters
    const animalIndex = activeTrial.runs.filter(
      run => run.genotype === selectedGenotype && run.status === "completed" && run.eligibleForAnalysis
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
    UI.Displays.tapLabel.textContent = "Tap";
    UI.Displays.totalStim.textContent = currentAssay.stimCount;
    UI.Displays.currentStim.textContent = "1";

    requestWakeLock();
    startCueLoop();
  }

  /**
   * Seeds the scheduling timestamps using the AudioContext clock and starts
   * the Web Worker metronome heartbeat.
   *
   * The 0.5s offset gives the audio context time to warm up before the first
   * tick fires, preventing the first beep from being clipped or delayed.
   *
   * Also captures the active run reference and stable assay parameters into
   * module-level cache variables so scheduler() never dereferences currentAssay
   * or scans the runs array during its hot path.
   */
  function startCueLoop() {
    // Capture the active run reference once — scheduler() will use this directly
    const activeTrial = getActiveTrial(currentAssay);
    activeRun         = activeTrial?.runs.find(r => r.status === "active") ?? null;

    // Cache stable run parameters to avoid repeated property lookups in scheduler()
    runISI        = currentAssay.isi;
    runStimCount  = currentAssay.stimCount;
    runBinSize    = currentAssay.binSize || 10;

    // If gracePeriodMs >= ISI the grace window of interval N overlaps the real
    // window of interval N+1, making tap attribution semantically undefined.
    // Clamp to at most half the ISI (in ms) so grace never bleeds into the next window.
    // Math.round (not Math.floor) avoids an off-by-one that would give 0 for
    // ISIs just under 2 ms and produce imprecise results for short ISIs generally.
    const _maxGrace = Math.round((runISI * 1000) / 2);
    if (gracePeriodMs > _maxGrace) {
      console.warn(
        `Grace period (${gracePeriodMs} ms) ≥ half ISI (${_maxGrace} ms). ` +
        `Clamping to ${_maxGrace} ms for this run.`
      );
      showToast(
        `Grace period clamped to ${_maxGrace} ms (half the ISI) for this run.`,
        "warning",
        4000
      );
    }
    runGraceSec = Math.min(gracePeriodMs, _maxGrace) / 1000;

    // Forward bin size to audio module for "bins" voice mode
    setBinSpeak(runBinSize);

    // Reset all scheduling counters
    currentStimulusIndex    = 0;
    nextSpeechIndex         = 0;
    nextAudioStimulusIndex  = 0;
    tapTimestamps           = [];
    tapReadIndex            = 0;
    lastSchedulerTime       = 0;

    const t0 = getAudioTime();
    const startTime = t0 + 0.5;  // 500ms warm-up delay

    nextAudioScheduleTime  = startTime;
    // Fire the TTS command slightly before the stimulus opens to compensate
    // for browser speech-engine latency (speechLeadMs, default 80 ms).
    nextSpeechTime         = startTime - (speechLeadMs / 1000);
    nextDataIntervalTime   = startTime + runISI;  // First window closes after one ISI

    timerWorker.postMessage("start");
    armbandStartHeartbeat();  // keep armband watchdog alive during the run

    // Cancel any stale animation frame before starting a fresh one
    // (guards against rapid stop→start sequences stacking rAF callbacks)
    if (visualAnimationFrame !== null) {
      cancelAnimationFrame(visualAnimationFrame);
    }
    visualAnimationFrame = requestAnimationFrame(renderVisualMetronome);
  }


  /* -----------------------------------------------------------------------
     Scheduling Pipeline (Core)
  ----------------------------------------------------------------------- */

  /**
   * The main scheduler function — called on every Worker "tick" (~125×/sec).
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
   *     No IDB write happens here — see the no-mid-run-save note below.
   *     Triggers run completion when all stimuli are recorded.
   *
   *   Step 3: AUDIO PRE-SCHEDULING
   *     Schedules hardware beeps slightly ahead of time using the AudioContext
   *     clock to guarantee timing accuracy independent of JS thread load.
   */
  function scheduler() {
    // Use cached run reference — avoids a linear .find() scan (~125×/sec)
    const run = activeRun;

    // Safety: if there's no active run, halt the loop
    if (!run) {
      stopCueLoop();
      return;
    }

    const currentTime = getAudioTime();

    // ── Step 0: Timing gap detection ───────────────────────────────────────
    // Note: lastSchedulerTime is set *after* this check so that on the very
    // first tick (lastSchedulerTime === 0) the guard is intentionally skipped.
    // On a recovered return from background, the first tick post-resume will
    // correctly fire the gap guard and abort the run before any data is lost.
    if (lastSchedulerTime > 0) {
      const gap           = currentTime - lastSchedulerTime;
      const maxAllowedGap = Math.max(runISI * 2, 1.0);

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
    // Optimisation: when the scheduler misses several ticks (e.g. a brief JS
    // pause), the while-loop would catch up by firing triggerImmediateSpeech()
    // for every missed beat. Each call does cancel() + speak(), so only the
    // last utterance survives — the intermediate ones are pure churn (~5-10ms
    // each). Instead, we advance through all missed beats, update the UI to
    // the latest, and fire speech exactly once for the most recent stimulus.
    {
      let speechFired = false;
      while (currentTime >= nextSpeechTime && nextSpeechIndex < runStimCount) {
        const displayIndex = nextSpeechIndex + 1;  // 1-based for display

        // Always update the counter — it must reflect the latest stimulus
        UI.Displays.currentStim.textContent = displayIndex;

        // Periodic screen-reader progress announcement. Only in "tick" mode —
        // "count"/"tens"/"bins" already speak stimulus numbers via
        // triggerImmediateSpeech() below, so an aria-live update here would be
        // redundant. Gated to every 10th stimulus (not every one) so it doesn't
        // spam assistive tech at typical ISIs.
        if (
          UI.Displays.stimulusProgressAnnouncer &&
          getVoiceMode() === "tick" &&
          (displayIndex === 1 || displayIndex % 10 === 0)
        ) {
          UI.Displays.stimulusProgressAnnouncer.textContent =
            `Stimulus ${displayIndex} of ${runStimCount}`;
        }

        // Only fire speech on the last iteration of this catch-up loop.
        // Peek ahead: if the *next* beat is also due, skip speech for this one.
        const nextBeatAlsoDue = (currentTime >= nextSpeechTime + runISI)
                             && (nextSpeechIndex + 1 < runStimCount);
        if (!nextBeatAlsoDue) {
          triggerImmediateSpeech(displayIndex, runISI);
          speechFired = true;
        }

        nextSpeechTime += runISI;
        nextSpeechIndex++;
      }
      // If we skipped all speech calls (shouldn't happen, but defensive),
      // the counter is still up-to-date from the last iteration above.
      void speechFired;  // Suppress unused-variable linters
    }

    // ── Step 2: Data recording (fires at stimulus close) ───────────────────
    while (currentTime >= nextDataIntervalTime && currentStimulusIndex < runStimCount) {
      const intervalStart = nextDataIntervalTime - runISI;
      const intervalEnd   = nextDataIntervalTime;
      // Grace period: extend acceptance window for taps that arrived up to
      // gracePeriodMs ms after this interval closed. Use runGraceSec (computed
      // at startCueLoop and already clamped to half-ISI) rather than the raw
      // module-level gracePeriodMs, which could be updated mid-run by the slider.
      const graceEnd      = intervalEnd + runGraceSec;

      // Check if the experimenter tapped within this stimulus window.
      // Uses an index pointer (tapReadIndex) to scan only unconsumed entries,
      // avoiding the previous .some() + .filter() pattern that allocated a new
      // array and closures on every ISI tick.
      let tapOccurred = false;
      while (tapReadIndex < tapTimestamps.length) {
        const t = tapTimestamps[tapReadIndex];
        // Stop scanning if the tap is beyond both the interval AND the grace window.
        // If gracePeriodMs = 0 then graceEnd = intervalEnd and behaviour is unchanged.
        if (t >= graceEnd) break;               // belongs to a future window (past grace)
        // guard against a tap that arrived after the second confirmation
        // press but before the first stimulus window opened (i.e. t < intervalStart
        // for stimulus 1).  The old code consumed these pre-run taps without counting
        // them — which is correct — but if such a tap landed exactly ON intervalStart
        // it would pass the >= check and set tapOccurred = true for stimulus 1,
        // recording a false non-response.  The strict-boundary case is now blocked
        // by using a half-open interval [intervalStart, intervalEnd) so that a tap
        // at exactly intervalStart is correctly attributed to stimulus 1 only when
        // it was genuinely within the window.
        if (t >= intervalStart) tapOccurred = true;  // inside window or within grace period
        tapReadIndex++;                         // consume (past or matched)
      }

      // Encoding:
      //   1 = animal responded (default — experimenter did NOT tap)
      //   0 = animal did not respond (experimenter tapped to record non-response)
      //
      // Intentionally binary: the touch-assay readout itself is a response/
      // no-response call, not a reaction-time measurement, so the tap's exact
      // timestamp (tapTimestamps[]) is only used to test window membership
      // above and is discarded once consumed. It is never stored per-stimulus
      // or exported — there is no "response latency" to capture here.
      run.values.push(tapOccurred ? 0 : 1);

      // Reset visual "bucket fulfilled" indicators for the next interval
      UI.Buttons.tap.classList.remove("bucket-fulfilled");
      // Remove ISI waiting dim now that a new interval is starting
      UI.Buttons.tap.classList.remove("isi-waiting");
      if (UI.Displays.metronomeBar) UI.Displays.metronomeBar.classList.remove("fulfilled");
      if (UI.Displays.metronomeBar) UI.Displays.metronomeBar.classList.remove("near-full");

      currentStimulusIndex++;
      nextDataIntervalTime += runISI;

      // No IDB write here, by design: this loop runs on the AudioContext-clocked
      // hot path and is the one place where timing precision matters most, so it
      // must never risk a main-thread stall from a periodic write or the
      // background-tab throttling IDB transactions can trigger. A run's values
      // live only in memory until it ends (completeRunNormally / stopRunEarly),
      // both of which persist immediately. The tradeoff: a hard crash mid-run
      // (tab kill, OS crash, power loss — not a clean backgrounding, which the
      // visibilitychange handler below already flushes) loses that one run's
      // in-progress data. Accepted deliberately — a single animal is cheap to
      // re-run, unlike a precision regression across every run.

      // Check if all stimuli for this run are recorded
      if (run.values.length === run.expectedStimCount) {
        // Capture the run reference BEFORE stopCueLoop() sets activeRun = null,
        // so completeRunNormally() receives it directly without a fragile .find() re-scan.
        const completedRun = run;
        stopCueLoop();
        completeRunNormally(completedRun);
        return;  // Exit scheduler immediately — run is over
      }
    }

    // ── Step 3: Audio pre-scheduling (fires slightly ahead of time) ────────
    while (
      nextAudioScheduleTime < currentTime + SCHEDULE_AHEAD_TIME &&
      nextAudioStimulusIndex < runStimCount
    ) {
      scheduleWebAudioTick(nextAudioStimulusIndex + 1, runISI, nextAudioScheduleTime);
      nextAudioScheduleTime += runISI;
      nextAudioStimulusIndex++;
    }
  }


  /* -----------------------------------------------------------------------
     Run Lifecycle — Stop / Complete
  ----------------------------------------------------------------------- */

  /**
   * Halts the Worker heartbeat and cancels the visual animation frame.
   * Also clears the cached activeRun reference so scheduler() cannot fire
   * against a stale run object if a tick arrives after stop.
   * Does not modify any data — call before any run-ending function.
   */
  function stopCueLoop() {
    timerWorker.postMessage("stop");
    armbandStopHeartbeat();   // cancel heartbeat so watchdog doesn't fire between runs
    activeRun = null;  // Defensive: prevent scheduler() processing stale run
    if (visualAnimationFrame !== null) {
      cancelAnimationFrame(visualAnimationFrame);
      visualAnimationFrame = null;
    }
    // trim consumed tapTimestamps entries to prevent unbounded
    // array growth during long runs. Reset the read index to match.
    tapTimestamps.length = 0;
    tapReadIndex = 0;
  }

  /**
   * Called when a run completes naturally (all stimuli recorded).
   *
   * Marks the run as completed, evaluates eligibility for analysis,
   * saves the final state to IDB, plays the completion chime, and
   * returns the UI to POISED state so the next run can begin.
   */
  async function completeRunNormally(run) {
    // Clear the double-Escape timer so the first Esc press in a new run can
    // never inadvertently skip the confirmation toast because the previous
    // run's first-Esc time is still within the 2 s window.
    lastEscapeTime = 0;

    const activeTrial = getActiveTrial(currentAssay);
    // run is passed directly from the scheduler — no .find() needed.
    // (activeRun is already null at this point because stopCueLoop() was called first.)
    if (!run) return;

    // guard against null activeTrial. This can happen in an extreme
    // race where the trial was already completed via another path before the
    // scheduler fired completeRunNormally. Without this guard, line 830
    // (`saveRun(currentAssay.assayId, activeTrial.trialId, run)`) would throw
    // TypeError and the final IDB save would never happen.
    if (!activeTrial) {
      console.error("completeRunNormally: no active trial found — run data may not be saved to IDB.");
      playCompletionTone();
      updateProgressTable();
      refreshGenotypeDropdownCounts();
      releaseWakeLock();
      applyProgressVisibilityPreference();
      setState(STATES.POISED);
      showToast("Run complete — all stimulations recorded.", "success");
      return;
    }

    completeRun(run);

    // A run is eligible for analysis only if it recorded the full expected stimulus count
    run.eligibleForAnalysis = (run.values.length === run.expectedStimCount);

    if (!run.eligibleForAnalysis) {
      run.ineligibleReason = "Incomplete stimulus count";
    }

    // Snapshot the automatic determination — immutable record of what the
    // system originally decided, preserved even if a human later overrides
    // eligibleForAnalysis via the progress table's override toggle.
    run.autoEligibleForAnalysis = run.eligibleForAnalysis;
    run.autoIneligibleReason    = run.ineligibleReason;
    // NOTE: run.binnedPercentages is intentionally NOT cached here.
    // export.js always recomputes binned percentages fresh from raw `run.values`
    // via buildRunCache() → binRunValues(), so a stale cached value would be ignored
    // anyway. Caching here also caused staleness if binSize changed between trials.

    // Warn if the stimulus count is not an exact multiple of binSize —
    // trailing values will be silently dropped during analysis
    const remainder = run.values.length % currentAssay.binSize;
    if (remainder !== 0) {
      // reworded to remove ambiguous double-negative ("do not fill")
      run.partialBinWarning =
        `Last ${remainder} value(s) dropped — not enough to fill a complete bin of size ${currentAssay.binSize}`;
    }

    // Final save: ensures all values are in IDB regardless of batch timing
    await saveRun(currentAssay.assayId, activeTrial.trialId, run);

    // Update last-modified timestamp so metadata exports reflect the latest activity
    currentAssay.lastModifiedAt = Date.now();
    saveAssay(currentAssay).catch(err => console.error("Failed to update assay metadata:", err));

    // Completion feedback
    playCompletionTone();
    try {
      if (navigator.vibrate) navigator.vibrate([100, 50, 200]);  // Ascending haptic pattern
    } catch (e) { /* Haptics not supported — silently ignore */ }
    armbandRunComplete();  // mirror navigator.vibrate([100,50,200]) on the armband

    // Update the UI and return to POISED state for the next run.
    // applyProgressVisibilityPreference() below sets both .hidden and the button
    // label correctly — no need to pre-set them here (that would override the pref).
    updateProgressTable();
    refreshGenotypeDropdownCounts();
    updateProgressBadge();
    releaseWakeLock();
    // Respect the user's saved visibility preference for the progress table
    // (set via the "Hide/Show Progress" toggle in the assay screen).
    applyProgressVisibilityPreference();
    setState(STATES.POISED);
    showToast("Run complete — all stimulations recorded.", "success");
  }

  /**
   * Aborts an in-progress run and marks it as ineligible for analysis.
   * Called by: the Stop Run button, the timing gap detector, and crash guards.
   *
   * @param {string} [reason="Run stopped early by user"] - Explanation for the stop.
   */
  // Re-entrancy guard — prevents a rapid double-press on "Stop Run" (or a
  // timing-gap auto-stop racing with the button) from calling stopRunEarly()
  // twice on the same run.
  //
  // Uses a per-run Promise chain so the guard stays locked until ALL async
  // IDB writes (saveRun + saveAssay) have settled, not just until the
  // synchronous portion of the function returns.  Without this, a Worker
  // tick arriving after the function returns but before the IDB writes
  // complete could call stopRunEarly() a second time on the same run.
  let _stopRunPromise = null;

  /**
   * Stops the active run before it reaches its full stimulus count, marking
   * it "stoppedEarly" and persisting the reason.
   * @param {string} [reason="Run stopped early by user"] - Human-readable reason, stored on the run record.
   */
  function stopRunEarly(reason = "Run stopped early by user") {
    // Clear the double-Escape timer unconditionally — BEFORE the re-entrancy
    // guard — so a blocked second call still resets the stale timestamp.
    // Placing this after the guard meant a rapid double-stop that hit the guard
    // on the second call could leave lastEscapeTime armed into the next run.
    lastEscapeTime = 0;

    // Guard: if a stop sequence is already in flight, do nothing.
    if (_stopRunPromise) return;

    isWarmingUp = false;
    // if warmup was in progress, clear the overlay and ring class so
    // the UI doesn't get stuck in an unresponsive state after an external stop.
    // also remove the state-warming-up body class and reset the bar so
    // CSS-driven elements (amber bar, live counter) don't stay visible post-stop.
    document.body.classList.remove("state-warming-up");
    if (UI.Displays.metronomeBar) {
      UI.Displays.metronomeBar.classList.remove("warmup");
      UI.Displays.metronomeBar.style.transform = "scaleX(0)";
      UI.Displays.metronomeBar.style.removeProperty("--warmup-duration");
    }
    UI.Buttons.tap.classList.remove("warming-up");
    if (!UI.Displays.warmup.hidden) UI.Displays.warmup.hidden = true;

    // Snapshot activeRun BEFORE stopCueLoop() nulls it. This prevents a double-stop
    // race where a final Worker tick arrives after stopCueLoop() clears activeRun,
    // causing a second call that would tag and re-save an already-tagged run.
    const snapshotRun = activeRun;
    stopCueLoop();
    stopSpeech();

    // Guard against currentAssay being null (e.g. corrupted state or a
    // spurious call after resetToSetup). Without this, saveRun(currentAssay.assayId, ...)
    // below would throw TypeError: Cannot read properties of null.
    if (!currentAssay) return;

    const activeTrial = getActiveTrial(currentAssay);
    const run         = snapshotRun || activeTrial?.runs.find(r => r.status === "active");
    if (!run) return;

    // Tag the run with ineligibility information
    run.status               = "stoppedEarly";
    run.endedAt              = Date.now();
    run.eligibleForAnalysis  = false;
    run.ineligibleReason     = reason;

    // Snapshot the automatic determination (see completeRunNormally for why).
    run.autoEligibleForAnalysis = false;
    run.autoIneligibleReason    = reason;

    // Build a Promise that covers both IDB writes so the guard stays locked
    // until all async persistence is complete.
    const saveRunPromise = (activeTrial)
      ? saveRun(currentAssay.assayId, activeTrial.trialId, run).catch(err =>
          console.error("Failed to save stopped run:", err)
        )
      : (console.error("stopRunEarly: no active trial — run may not be saved to IDB"), Promise.resolve());

    // Update last-modified timestamp so metadata exports reflect the latest activity
    currentAssay.lastModifiedAt = Date.now();
    const saveAssayPromise = saveAssay(currentAssay).catch(err =>
      console.error("Failed to update assay metadata:", err)
    );

    // Hold the guard until both writes settle, then clear it.
    _stopRunPromise = Promise.all([saveRunPromise, saveAssayPromise])
      .finally(() => { _stopRunPromise = null; });

    // Update UI and return to POISED state.
    // applyProgressVisibilityPreference() handles both .hidden and the label.
    updateProgressTable();
    refreshGenotypeDropdownCounts();
    updateProgressBadge();
    releaseWakeLock();
    // Respect the user's saved visibility preference for the progress table.
    applyProgressVisibilityPreference();
    setState(STATES.POISED);
    showToast(
      reason === "Run stopped early by user"
        ? "Run cancelled — marked ineligible for analysis."
        : `Run interrupted: ${reason}`,
      "warning",
      5000
    );
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

    // Warmup countdown keeps currentState at CONFIGURED/POISED (it isn't its
    // own STATES value), and CSS-only pointer-events blocking doesn't cover
    // the Space-bar path. Without this guard a stray press during warmup
    // re-arms pendingStart, letting the *next* run start with zero confirmation.
    if (isWarmingUp) return;

    // ── Hardware debounce ─────────────────────────────────────────────────
    const now = Date.now();
    if (now - lastTapTime < TAP_COOLDOWN_MS) return;
    lastTapTime = now;

    const isStartingNewRun = (currentState === STATES.CONFIGURED || currentState === STATES.POISED);

    // ── Pre-flight checks (only when starting a new run) ──────────────────
    if (isStartingNewRun) {
      const selectedGenotype = UI.Inputs.genotypeSelect.value;

      if (!selectedGenotype) {
        showToast("Please select a genotype before starting.", "info", 3000);
        return;
      }

      if (!pendingStart) {
        // First tap: show confirmation prompt and set a 2-second reset timer
        pendingStart = true;

        // activeTrial can be null if the trial was abandoned/completed by
        // another code path. Use optional chaining consistent with the timeout branch.
        const activeTrial = getActiveTrial(currentAssay);
        const nextIndex   = (activeTrial?.runs.filter(
          r => r.genotype === selectedGenotype && r.status === "completed" && r.eligibleForAnalysis
        ).length ?? 0) + 1;

        UI.Displays.tapLabel.textContent = `Tap again to start ${selectedGenotype} (Animal ${nextIndex})`;

        clearTimeout(startTimeout);
        startTimeout = setTimeout(() => {
          pendingStart = false;
          if (currentState === STATES.CONFIGURED || currentState === STATES.POISED) {
            // re-read genotype from the DOM inside the timeout to avoid
            // using a stale closure-captured value if the user changed the dropdown.
            const freshGenotype = UI.Inputs.genotypeSelect.value;
            // Recompute freshly — do not use the closure-captured nextIndex which was
            // calculated at first-tap time and may be stale if a run completed in between.
            const activeTrial = getActiveTrial(currentAssay);
            const freshIndex = (activeTrial?.runs.filter(
              r => r.genotype === freshGenotype &&
                   r.status === "completed" &&
                   r.eligibleForAnalysis
            ).length ?? 0) + 1;
            UI.Displays.tapLabel.textContent = `Start ${freshGenotype} (Animal ${freshIndex})`;
          }
        }, 2000);

        return;  // Wait for the second tap
      }

      // Second tap: proceed to start
      pendingStart = false;
      clearTimeout(startTimeout);
    }

    // ── Audio warm-up (first interaction) ────────────────────────────────────
    if (!isAudioReady()) {
      // warmUpAudio() re-throws on failure. Catch here so we can show a
      // user-facing error and abort instead of continuing with a suspended
      // AudioContext where getAudioTime() returns 0.
      try {
        await warmUpAudio();
      } catch {
        showToast(
          "Audio could not start — check your browser's autoplay/audio settings and try again.",
          "error",
          7000
        );
        return;
      }
      // speak("") with an empty string can break iOS speechSynthesis.
      // primeSpeechEngine() uses a silent space utterance (" ") for the same purpose
      // and is already used during warmup for exactly this reason.
      primeSpeechEngine();
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
      // No "undo last tap" is offered by design: at typical ISIs (~1 Hz) a
      // confirmation affordance would itself eat into the next stimulus
      // window, and by the time a misfire is noticed the window it belongs
      // to has usually already closed and been scored (see the data-recording
      // pass below). Correcting a bad run means stopping/discarding it, not
      // patching a single tap.
      // Record the tap's AudioContext timestamp for the data recording layer
      tapTimestamps.push(getAudioTime());
      armbandTap();  // mirror navigator.vibrate(50) on the armband

      // Visual indicator: "bucket fulfilled" shows the tap was registered
      UI.Buttons.tap.classList.add("bucket-fulfilled");
      // Use cached reference — avoids getElementById on every tap during a run
      if (UI.Displays.metronomeBar) UI.Displays.metronomeBar.classList.add("fulfilled");

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
    // set isWarmingUp = true here, BEFORE the !isWarmupEnabled early-exit
    // branch, so the guard also prevents re-entrant startRun() calls when warmup is
    // disabled. Previously, two taps that both passed the guard could both reach
    // startRun() concurrently, creating two runs for the same genotype.
    isWarmingUp = true;

    if (!isWarmupEnabled) {
      primeSpeechEngine();  // Warm the TTS engine even when skipping the countdown
      // Wrap startRun() so IDB/audio failures are surfaced rather than swallowed.
      try {
        await startRun();
      } catch (err) {
        console.error("Failed to start run:", err);
        showToast("Failed to start run — storage error. Please try again.", "error");
      }
      isWarmingUp = false;  // clear flag after the no-warmup path exits
      return;
    }

    // Removed redundant isWarmingUp = true. isWarmingUp is already
    // set to true unconditionally earlier in this function,
    // so this second assignment was a stale leftover — never false at this point.
    // Show the countdown overlay INSIDE the tap button (button stays visible).
    // The .warming-up class adds the pulsing ring and blocks pointer events.
    UI.Displays.warmup.hidden = false;
    // hide the overlay + normal label from AT while countdown is active.
    UI.Displays.warmup.setAttribute("aria-hidden", "true");
    UI.Displays.tapLabel.setAttribute("aria-hidden", "true");
    UI.Buttons.tap.classList.add("warming-up");

    // Show bar + counter in warmup mode: body class makes them visible,
    // amber bar counts down via CSS animation for the full warmup duration.
    document.body.classList.add("state-warming-up");
    const bar = UI.Displays.metronomeBar;
    if (bar) {
      bar.style.setProperty("--warmup-duration", `${warmupDuration}s`);
      bar.style.transform = ""; // let CSS animation take over
      bar.classList.add("warmup");
    }
    // Show "Warmup" in the stimulus counter so experimenter knows what's happening
    const stimDisplay = document.getElementById("currentStimDisplay");
    if (stimDisplay) stimDisplay.textContent = "Warmup";

    // Prime the TTS engine with a silent utterance so the synthesis pipeline
    // is warm before the first real voiced cue fires during the run.
    primeSpeechEngine();

    /** Cleans up warmup UI without starting a run (cancelled path). */
    const _cancelWarmupUI = () => {
      isWarmingUp = false;
      document.body.classList.remove("state-warming-up");
      if (bar) {
        bar.classList.remove("warmup");
        bar.style.transform = "scaleX(0)"; // reset for next run
        bar.style.removeProperty("--warmup-duration");
      }
      if (stimDisplay) stimDisplay.textContent = "0";
      UI.Displays.warmup.hidden = true;
      // restore accessibility on cancel path.
      UI.Displays.warmup.removeAttribute("aria-hidden");
      UI.Displays.tapLabel.removeAttribute("aria-hidden");
      UI.Buttons.tap.classList.remove("warming-up");
      // Restore the tap button label so it doesn't show the stale "Tap again…" text.
      const sel = UI.Inputs.genotypeSelect.value;
      if (sel && (currentState === STATES.CONFIGURED || currentState === STATES.POISED)) {
        const at = getActiveTrial(currentAssay);
        const n  = (at?.runs.filter(r => r.genotype === sel && r.status === "completed" && r.eligibleForAnalysis).length ?? 0) + 1;
        UI.Displays.tapLabel.textContent = `Start ${sel} (Animal ${n})`;
      }
    };

    for (let i = warmupDuration; i > 0; i--) {
      // Cancel if the state has changed externally (e.g. stop was clicked)
      if (!isWarmingUp || (currentState !== STATES.CONFIGURED && currentState !== STATES.POISED)) {
        _cancelWarmupUI();
        return;
      }

      UI.Displays.warmupNumber.textContent = i;
      // cancel running Web Animations instead of triggering a
      // layout reflow via offsetWidth to restart the digit pop-in each second.
      UI.Displays.warmupNumber.getAnimations().forEach(a => a.cancel());
      UI.Displays.warmupNumber.style.animation = "";   // re-enable CSS animation
      playWarmupTone(1200);  // High beep each countdown second

      await new Promise(r => setTimeout(r, 1000));

      // Re-check after the await — warmup may have been cancelled while suspended
      if (!isWarmingUp) {
        _cancelWarmupUI();
        return;
      }
    }

    // Countdown finished — tear down warmup state and start the run
    isWarmingUp = false;
    document.body.classList.remove("state-warming-up");
    if (bar) {
      bar.classList.remove("warmup");
      bar.style.transform = "scaleX(0)"; // reset; startRun's rAF will take over
      bar.style.removeProperty("--warmup-duration");
    }
    if (stimDisplay) stimDisplay.textContent = "0";
    UI.Displays.warmup.hidden = true;
    // restore accessibility on the success completion path too.
    UI.Displays.warmup.removeAttribute("aria-hidden");
    UI.Displays.tapLabel.removeAttribute("aria-hidden");
    UI.Buttons.tap.classList.remove("warming-up");

    // Wrap startRun() so IDB/audio failures are surfaced rather than swallowed.
    try {
      await startRun();
    } catch (err) {
      console.error("Failed to start run:", err);
      showToast("Failed to start run — storage error. Please try again.", "error");
    }
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
    if (currentState !== STATES.RUNNING || !currentAssay) {
      // Setting visualAnimationFrame = null here is safe.
      // This callback itself is the current rAF tick — its handle was already
      // consumed by the browser when it invoked us.  We zero the variable so
      // stopCueLoop()'s cancelAnimationFrame(visualAnimationFrame) call has a
      // consistent "no pending frame" sentinel (null) regardless of which path
      // stopped the run, preventing a stale handle from ever being re-cancelled
      // on the next run.
      visualAnimationFrame = null;
      return;
    }

    // Snapshot nextDataIntervalTime once to avoid a race with scheduler(), which can
    // increment it between consecutive rAF callbacks and cause the bar to flash to 100%
    // or reset to 0% mid-interval before the next frame corrects it.
    const intervalEnd   = nextDataIntervalTime;
    const currentTime   = getAudioTime();
    const intervalStart = intervalEnd - runISI;  // Use cached ISI

    // Progress: 0.0 at interval start → 1.0 at interval end
    let progress = (currentTime - intervalStart) / runISI;  // Use cached ISI
    progress     = Math.max(0, Math.min(1, progress));  // Clamp to [0, 1]

    // Dim the tap button during ISI — only after a tap has already been registered.
    // When bucket-fulfilled (experimenter tapped), there's nothing more to do until
    // the next interval, so a gentle dim signals "wait" without alarming the user.
    if (UI.Buttons.tap.classList.contains("bucket-fulfilled") &&
        !UI.Buttons.tap.classList.contains("tapped")) {
      UI.Buttons.tap.classList.add("isi-waiting");
    } else {
      UI.Buttons.tap.classList.remove("isi-waiting");
    }

    // Use cached DOM reference from UI — avoids getElementById on every frame
    if (UI.Displays.metronomeBar) {
      // Drive via scaleX so the compositor layer added by will-change: transform
      // is used end-to-end. Previously used style.width which forced layout;
      // scaleX + transform-origin:left is equivalent visually but GPU-accelerated.
      UI.Displays.metronomeBar.style.transform = `scaleX(${progress})`;
      // near-full glow at 90%+ to signal upcoming stimulus
      if (progress >= 0.9) {
        UI.Displays.metronomeBar.classList.add("near-full");
      } else {
        UI.Displays.metronomeBar.classList.remove("near-full");
      }
    }

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
    // Read all localStorage values first, guarded by try/catch because
    // localStorage can throw SecurityError in Private Browsing / sandboxed iframes.
    // DOM writes are intentionally OUTSIDE the try block so programming errors
    // (e.g. a null UI element) are not silently swallowed.
    let savedTheme, savedVoiceMode, savedPitch, progressPref;
    try {
      savedTheme    = localStorage.getItem("touchAssayTheme") ||
        (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      savedVoiceMode = localStorage.getItem("touchAssayVoiceMode") || "tick";
      savedPitch    = parseInt(localStorage.getItem("touchAssayTickPitch"), 10);
      progressPref  = localStorage.getItem("touchAssayProgressVisible");
    } catch {
      // H5: localStorage unavailable — fall back to in-memory defaults already
      // set by the module-level variable initialisers (speechLeadMs, gracePeriodMs, etc.)
      savedTheme     = window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      savedVoiceMode = "tick";
      savedPitch     = NaN;   // triggers isNaN fallback to 900 below
      progressPref   = null;
    }

    // ── Warmup settings ──
    UI.Settings.warmupToggle.checked              = isWarmupEnabled;
    UI.Settings.warmupDurationInput.value         = warmupDuration;
    UI.Settings.warmupDurationContainer.style.display = isWarmupEnabled ? "flex" : "none";

    // ── Theme ──
    // Mirror the inline script's OS-preference fallback: if no theme has ever been
    // saved, use prefers-color-scheme rather than hardcoding "light". Without this,
    // initializeSettings() would overwrite the dark theme the inline script just
    // applied (via the same OS-preference check) back to "light" on first load.
    document.documentElement.setAttribute("data-theme", savedTheme);
    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) metaThemeColor.setAttribute('content', savedTheme === 'dark' ? '#0f172a' : '#f1f5f9');
    document.querySelectorAll('input[name="themeMode"]').forEach(input => {
      if (input.value === savedTheme) input.checked = true;
    });

    // ── Voice mode ──
    setVoiceMode(savedVoiceMode);
    document.querySelectorAll('input[name="voiceMode"]').forEach(input => {
      if (input.value === savedVoiceMode) input.checked = true;
    });

    // ── Tick pitch ──
    const initPitch = isNaN(savedPitch) ? 900 : savedPitch;
    setTickPitch(initPitch);
    if (UI.Settings.tickPitch) {
      UI.Settings.tickPitch.value = initPitch;
      if (UI.Settings.tickPitchDisplay)
        UI.Settings.tickPitchDisplay.value = initPitch;
    }

    // ── Speech lead time (ms) — compensates for TTS engine latency ──
    if (UI.Settings.speechLead) {
      UI.Settings.speechLead.value = speechLeadMs;
      if (UI.Settings.speechLeadDisplay)
        UI.Settings.speechLeadDisplay.value = speechLeadMs;
    }

    // ── Grace period ──
    if (UI.Settings.gracePeriod) {
      UI.Settings.gracePeriod.value = gracePeriodMs;
      if (UI.Settings.gracePeriodDisplay)
        UI.Settings.gracePeriodDisplay.value = gracePeriodMs;
    }

    // ── Assay Defaults — restore saved defaults into the sub-page inputs ──
    _restoreAssayDefaultsToUI();

    // Restore progress-table visibility preference.
    // We don't apply it here at startup because there's no data yet;
    // it gets applied in completeRunNormally() / stopRunEarly() when
    // the table is first shown (or kept hidden) according to preference.
    void progressPref;  // variable read during localStorage phase; consumed later
  }

  /**
   * Reads assay defaults from localStorage and populates the Assay Defaults
   * sub-page stepper inputs with those values.
   */
  function _restoreAssayDefaultsToUI() {
    const defaults = _loadAssayDefaults();
    if (UI.Settings.defaultISI)         UI.Settings.defaultISI.value         = defaults.isi;
    if (UI.Settings.defaultStimCount)   UI.Settings.defaultStimCount.value   = defaults.stimCount;
    if (UI.Settings.defaultBinSize)     UI.Settings.defaultBinSize.value     = defaults.binSize;
    if (UI.Settings.defaultTemperature) UI.Settings.defaultTemperature.value = defaults.temperature;
    if (UI.Settings.defaultHumidity)    UI.Settings.defaultHumidity.value    = defaults.humidity;
  }

  /**
   * Loads assay setup defaults from localStorage.
   * Returns hardcoded fallback values when no defaults have been saved yet.
   * @returns {{ isi: number, stimCount: number, binSize: number, temperature: number, humidity: number }}
   */
  function _loadAssayDefaults() {
    try {
      // Use explicit isNaN guards so that:
      //   - Missing keys  → parseFloat/parseInt(null) = NaN → use fallback
      //   - Valid 0 values (e.g. 0 °C, 0% RH) are NOT replaced by || fallback
      //   - ?? would also fail: NaN ?? fallback still returns NaN (NaN ≠ null/undefined)
      const _f = (key, fallback) => { const v = parseFloat(localStorage.getItem(key)); return isNaN(v) ? fallback : v; };
      const _i = (key, fallback) => { const v = parseInt(localStorage.getItem(key), 10); return isNaN(v) ? fallback : v; };
      return {
        isi:         _f("touchAssayDefaultISI",         1),
        stimCount:   _i("touchAssayDefaultStimCount",   100),
        binSize:     _i("touchAssayDefaultBinSize",     10),
        temperature: _f("touchAssayDefaultTemperature", 20),
        humidity:    _f("touchAssayDefaultHumidity",    60),
      };
    } catch {
      return { isi: 1, stimCount: 100, binSize: 10, temperature: 20, humidity: 60 };
    }
  }

  /**
   * Applies the user's saved progress-table visibility preference.
   * Called after each run ends so the table respects the user's toggle setting.
   */
  function applyProgressVisibilityPreference() {
    let pref = null;
    try { pref = localStorage.getItem("touchAssayProgressVisible"); } catch {} // L7: guard for Private Browsing
    const container = document.getElementById("assayProgress");
    if (!container) return;
    // Default: show the table ("true" or no stored pref = visible)
    const shouldShow = pref !== "false";
    container.hidden = !shouldShow;
    // the `hidden` attribute already removes the element from the
    // accessibility tree — setting aria-hidden on top is redundant and can cause
    // screen readers to announce a hidden element when aria-hidden="false" is present.
    container.removeAttribute("aria-hidden");
    // Update text, icon, and aria-pressed together
    const label = UI.Buttons.progress.querySelector(".toggle-progress-label");
    const eyeOn  = UI.Buttons.progress.querySelector(".toggle-progress-icon-eye");
    const eyeOff = UI.Buttons.progress.querySelector(".toggle-progress-icon-eye-off");
    if (label)  label.textContent     = shouldShow ? "Hide Progress" : "Show Progress";
    if (eyeOn)  eyeOn.hidden          = !shouldShow;
    if (eyeOff) eyeOff.hidden         = shouldShow;
    UI.Buttons.progress.setAttribute("aria-pressed", String(shouldShow));
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

    const remainder = stimCount % binSize;
    const usable    = stimCount - remainder;
    UI.Displays.binWarning.textContent =
      `The last ${remainder} stimulus/stimuli will be excluded from bin analysis — ` +
      `they don't fill a complete bin of size ${binSize}. ` +
      `Only the first ${usable} stimulations will be used.`;
    UI.Displays.binWarning.hidden = false;
  }

  /**
   * Shows an inline warning below the ISI field when the current grace period
   * setting would exceed half the ISI (and would therefore be clamped on run start).
   * Called whenever the ISI input changes.
   *
   * NOTE: ETA display was intentionally omitted per experimenter preference.
   */
  function updateGraceIsiWarning() {
    const isiEl  = document.getElementById("graceIsiWarning");
    if (!isiEl) return;
    const isiMs  = Number(UI.Inputs.isi.value) * 1000;
    if (!isiMs || isiMs <= 0) { isiEl.hidden = true; return; }
    const halfMs = Math.floor(isiMs / 2);
    if (gracePeriodMs > halfMs) {
      isiEl.textContent =
        `⚠ Grace period (${gracePeriodMs} ms) exceeds half the ISI (${halfMs} ms). ` +
        `It will be clamped to ${halfMs} ms when the run starts.`;
      isiEl.hidden = false;
    } else {
      isiEl.hidden = true;
    }
  }

  /**
   * Updates the numeric run-count badge inside the #toggleProgress button.
   * Shows the total number of completed+stopped runs in the current trial.
   * Called after every run ends (normal or early stop).
   */
  function updateProgressBadge() {
    const badge = document.getElementById("progressRunBadge");
    if (!badge || !currentAssay) { if (badge) badge.hidden = true; return; }
    const trial = getActiveTrial(currentAssay);
    if (!trial) { badge.hidden = true; return; }
    // Count only eligible completed runs — consistent with the genotype-dropdown
    // counter and what the experimenter actually cares about (usable data points).
    // stoppedEarly runs are intentionally excluded so the badge isn't inflated
    // by cancelled or interrupted recordings.
    const count = trial.runs.filter(r => r.status === "completed" && r.eligibleForAnalysis).length;
    if (count === 0) {
      badge.hidden = true;
    } else {
      badge.textContent = count;
      badge.hidden = false;
    }
  }

  /* -----------------------------------------------------------------------
     Genotype Picker (custom UI over the hidden #genotypeSelect)

     #genotypeSelect (the native <select>) remains the single source of truth
     for the selected value — every other part of the app reads/writes it
     exactly as before. Everything below is a purely visual/interaction layer
     that mirrors it: renderGenotypePicker() rebuilds the on-screen control
     from the same (genotypes, trial) data populateGenotypeSelect() already
     computes, and selectGenotype() writes back to the hidden select and
     dispatches a "change" event so existing listeners fire unchanged.

     Two display modes (see the CSS comment above .genotype-pills):
       - Pills:            wide viewport, genotype count <= GENOTYPE_PILL_MAX.
       - Trigger + panel:  narrow viewport (always), or wide viewport beyond
                            GENOTYPE_PILL_MAX. Panel renders as an anchored
                            dropdown on wide viewports, a bottom sheet on
                            narrow ones.
  ----------------------------------------------------------------------- */

  /**
   * Euclidean distance between two "#rrggbb" colors in RGB space (0-441).
   * Not a perceptual color-difference model (e.g. CIEDE2000) — a coarse
   * heuristic is enough here since the goal is only to catch two colors
   * that would obviously look alike side by side, not to guarantee
   * colorblind-safe contrast (not a requirement for this app).
   * @param {string} hexA
   * @param {string} hexB
   * @returns {number}
   */
  function colorDistance(hexA, hexB) {
    const a = parseInt(hexA.slice(1), 16);
    const b = parseInt(hexB.slice(1), 16);
    const dr = ((a >> 16) & 0xff) - ((b >> 16) & 0xff);
    const dg = ((a >> 8)  & 0xff) - ((b >> 8)  & 0xff);
    const db = (a         & 0xff) - (b         & 0xff);
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  /**
   * Assigns a stable color to each genotype, in entry order, with a greedy
   * adjacency guard: if a genotype's default palette color would be too
   * similar to its immediate neighbor's, swap in a palette color that is
   * sufficiently distinct from both neighbors instead.
   *
   * Deterministic given the same genotypes array — since genotype order
   * never changes mid-trial (only run counts do), this naturally stays
   * stable across every re-render without needing an explicit cache.
   *
   * No index numbers are added alongside color — deliberately: genotype
   * labels here are already dense (allele-style names), and a serial number
   * would add clutter without meaningfully improving disambiguation.
   *
   * @param {string[]} genotypes
   * @returns {Map<string, string>} genotype label -> "#rrggbb" color.
   */
  function assignGenotypeColors(genotypes) {
    const MIN_DISTANCE = 90; // heuristic threshold, out of a max ~441
    const palette  = GENOTYPE_COLOR_PALETTE;
    const assigned = genotypes.map((_, i) => palette[i % palette.length]);

    for (let i = 1; i < assigned.length; i++) {
      const prev = assigned[i - 1];
      if (colorDistance(assigned[i], prev) >= MIN_DISTANCE) continue;

      const next = i + 1 < assigned.length ? assigned[i + 1] : null;
      const candidate = palette.find(c =>
        colorDistance(c, prev) >= MIN_DISTANCE &&
        (next === null || colorDistance(c, next) >= MIN_DISTANCE)
      );
      // If the palette is too small relative to genotype count, no
      // sufficiently-distinct candidate may exist — best-effort only, leave
      // the original assignment rather than throwing.
      if (candidate) assigned[i] = candidate;
    }

    const map = new Map();
    genotypes.forEach((g, i) => map.set(g, assigned[i]));
    return map;
  }

  /**
   * Rebuilds the genotype selection dropdown with current run counts.
   * The count shows how many runs have been completed (non-active) for each genotype
   * in the current trial, giving the experimenter live feedback.
   *
   * Restores the previously selected value after rebuilding.
   *
   * Genotype labels are shown as entered and listed in entry order, by design:
   * the experimenter must know which genotype/plate they are handling to place
   * the animal under the probe correctly, so blinding the label during scoring
   * isn't workable for this assay. Likewise, testing order is left as entered
   * rather than auto-randomized, since plate/genotype handling order is
   * constrained by the physical bench setup, not just data-quality concerns.
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

      // Count only eligible (completed + eligible for analysis) runs for this genotype
      const count   = trial
        ? trial.runs.filter(r => r.genotype === g && r.status === "completed" && r.eligibleForAnalysis).length
        : 0;

      option.textContent = count > 0 ? `${g} (${count} eligible)` : g;
      UI.Inputs.genotypeSelect.appendChild(option);
    });

    // Restore the selection if the previously selected genotype still exists
    const options = Array.from(UI.Inputs.genotypeSelect.options);
    if (previousValue && options.some(o => o.value === previousValue)) {
      UI.Inputs.genotypeSelect.value = previousValue;
    }

    renderGenotypePicker(genotypes);
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
   * Writes the chosen genotype back to the hidden #genotypeSelect (the
   * actual source of truth) and dispatches a "change" event so every
   * existing listener on it fires exactly as if the user had picked the
   * option natively. Then closes the panel (if open) and re-renders the
   * picker to reflect the new selection.
   *
   * @param {string} genotype
   */
  function selectGenotype(genotype) {
    UI.Inputs.genotypeSelect.value = genotype;
    UI.Inputs.genotypeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    closeGenotypeOverlay();
    if (currentAssay) renderGenotypePicker(currentAssay.genotypes);
  }

  /**
   * Positions the dropdown-mode panel directly below the trigger button,
   * clamped so it never overflows the right edge or bottom of the viewport.
   * Bottom-sheet mode (narrow viewports) uses fixed CSS positioning instead
   * and does not call this.
   */
  function positionGenotypePanel() {
    const trigger = UI.Inputs.genotypeTrigger;
    const panel   = UI.Inputs.genotypeListbox;
    const rect    = trigger.getBoundingClientRect();
    const width   = Math.max(rect.width, 280);

    panel.style.width    = `${width}px`;
    panel.style.left     = `${Math.min(rect.left, window.innerWidth - width - 8)}px`;
    panel.style.top      = `${rect.bottom + 6}px`;
    panel.style.maxHeight = `${Math.max(160, window.innerHeight - rect.bottom - 16)}px`;
  }

  /** Opens the genotype panel and moves focus to the current selection (or the first option). */
  function openGenotypeOverlay() {
    if (UI.Inputs.genotypeTrigger.disabled) return;
    const isWide = GENOTYPE_WIDE_MQ.matches;
    UI.Inputs.genotypeOverlay.classList.toggle("genotype-overlay--sheet", !isWide);
    UI.Inputs.genotypeOverlay.hidden = false;
    UI.Inputs.genotypeTrigger.setAttribute("aria-expanded", "true");
    if (isWide) positionGenotypePanel();

    const current = UI.Inputs.genotypeListbox.querySelector('[aria-selected="true"]')
                 || UI.Inputs.genotypeListbox.firstElementChild;
    if (current) current.focus();
  }

  /** Closes the genotype panel, if open. Safe to call unconditionally. */
  function closeGenotypeOverlay() {
    UI.Inputs.genotypeOverlay.hidden = true;
    UI.Inputs.genotypeTrigger.setAttribute("aria-expanded", "false");
  }

  /**
   * Mirrors #genotypeSelect.disabled onto the custom picker's pills and
   * trigger. setState() toggles the hidden select's .disabled directly
   * (unchanged legacy behavior) without rebuilding the picker, so this is
   * called once after every state transition to keep the two in sync.
   */
  function syncGenotypePickerEnabled() {
    const disabled = UI.Inputs.genotypeSelect.disabled;
    UI.Inputs.genotypeTrigger.disabled = disabled;
    UI.Inputs.genotypePills.querySelectorAll("button").forEach(btn => { btn.disabled = disabled; });
    if (disabled) closeGenotypeOverlay();
  }

  /**
   * Rebuilds the custom on-screen genotype picker (pills or trigger+panel)
   * to mirror the current genotypes/selection/disabled state of the hidden
   * #genotypeSelect. Called every time populateGenotypeSelect() runs, so it
   * always reflects the same data (run counts included).
   *
   * @param {string[]} genotypes
   */
  function renderGenotypePicker(genotypes) {
    const selected = UI.Inputs.genotypeSelect.value;
    const disabled = UI.Inputs.genotypeSelect.disabled;
    const trial    = currentAssay ? getActiveTrial(currentAssay) : null;
    const colors   = assignGenotypeColors(genotypes);

    const eligibleCount = g => trial
      ? trial.runs.filter(r => r.genotype === g && r.status === "completed" && r.eligibleForAnalysis).length
      : 0;

    const usePills = genotypes.length > 0
                   && genotypes.length <= GENOTYPE_PILL_MAX
                   && GENOTYPE_WIDE_MQ.matches;

    UI.Inputs.genotypePills.hidden   = !usePills;
    UI.Inputs.genotypeTrigger.hidden = usePills || genotypes.length === 0;

    if (genotypes.length === 0) {
      closeGenotypeOverlay();
      return;
    }

    if (usePills) {
      UI.Inputs.genotypePills.innerHTML = "";
      genotypes.forEach(g => {
        const btn = document.createElement("button");
        btn.type      = "button";
        btn.className = "genotype-pill";
        btn.disabled  = disabled;
        btn.setAttribute("aria-pressed", String(g === selected));
        btn.style.setProperty("--genotype-color", colors.get(g));

        const count = eligibleCount(g);
        btn.innerHTML =
          `<span class="genotype-pill-dot" aria-hidden="true"></span>` +
          `<span>${escapeHTML(g)}</span>` +
          (count > 0 ? `<span class="genotype-pill-count">${count}</span>` : "");
        btn.addEventListener("click", () => selectGenotype(g));
        UI.Inputs.genotypePills.appendChild(btn);
      });
      return;
    }

    // Trigger + panel mode — trigger reflects the current selection.
    UI.Inputs.genotypeTrigger.disabled = disabled;
    if (selected) {
      UI.Inputs.genotypeTriggerDot.style.background = colors.get(selected);
      UI.Inputs.genotypeTriggerDot.hidden = false;
      UI.Inputs.genotypeTriggerLabel.textContent = selected;
    } else {
      UI.Inputs.genotypeTriggerDot.hidden = true;
      UI.Inputs.genotypeTriggerLabel.textContent = "Select Genotype";
    }

    UI.Inputs.genotypeListbox.innerHTML = "";
    genotypes.forEach(g => {
      const opt = document.createElement("button");
      opt.type      = "button";
      opt.className = "genotype-option";
      opt.setAttribute("role", "menuitemradio");
      opt.setAttribute("aria-selected", String(g === selected));
      opt.style.setProperty("--genotype-color", colors.get(g));

      const count = eligibleCount(g);
      opt.innerHTML =
        `<span class="genotype-option-dot" aria-hidden="true"></span>` +
        `<span class="genotype-option-label">${escapeHTML(g)}</span>` +
        (count > 0 ? `<span class="genotype-option-count">${count} eligible</span>` : "");
      opt.addEventListener("click", () => selectGenotype(g));
      UI.Inputs.genotypeListbox.appendChild(opt);
    });

    // If the panel is currently open, refresh its position/size — the
    // trigger's own width can change slightly when its label text changes.
    if (!UI.Inputs.genotypeOverlay.hidden && GENOTYPE_WIDE_MQ.matches) {
      positionGenotypePanel();
    }
  }

  /**
   * Rebuilds the in-assay progress summary table showing total, eligible,
   * and ineligible run counts per genotype for the current trial (excluding
   * in-progress runs), plus a collapsible per-genotype run list with a
   * manual eligibility override control on each row.
   */
  function updateProgressTable() {
    const container = document.getElementById("assayProgress");
    if (!container) return;  // guard against missing element
    container.innerHTML = "";

    // call getActiveTrial once and reuse — avoids a second .find() scan.
    const trial = currentAssay ? getActiveTrial(currentAssay) : null;
    if (!currentAssay) return;

    const summary = {};

    // Initialise counters for every declared genotype
    currentAssay.genotypes.forEach(g => {
      summary[g] = { total: 0, eligible: 0, ineligible: 0, runs: [] };
    });

    // Tally runs into the appropriate bucket (skip active/in-progress runs)
    if (trial && trial.runs) {
      trial.runs.forEach(r => {
        if (!summary[r.genotype]) return;
        if (r.status === "active") return;  // Don't count in-progress runs
        summary[r.genotype].total++;
        if (r.status === "completed" && r.eligibleForAnalysis) {
          summary[r.genotype].eligible++;
        } else {
          summary[r.genotype].ineligible++;
        }
        summary[r.genotype].runs.push(r);
      });
    }

    let html = `<table><thead><tr>` +
               `<th>Genotype</th><th>Total Runs</th><th>Eligible</th><th>Ineligible</th>` +
               `</tr></thead><tbody>`;

    currentAssay.genotypes.forEach(g => {
      // Only colour a count when it's actually informative — an ineligible
      // count of 0 doesn't need red, and an eligible count of 0 doesn't need
      // green. Keeps the table calm until there's something worth noticing.
      const eligibleCell   = summary[g].eligible > 0
        ? `<span class="count-pill count-pill--good">${summary[g].eligible}</span>`
        : summary[g].eligible;
      const ineligibleCell = summary[g].ineligible > 0
        ? `<span class="count-pill count-pill--bad">${summary[g].ineligible}</span>`
        : summary[g].ineligible;

      html += `<tr>` +
              `<td>${escapeHTML(g)}</td>` +
              `<td>${summary[g].total}</td>` +
              `<td>${eligibleCell}</td>` +
              `<td>${ineligibleCell}</td>` +
              `</tr>`;
    });

    html += `</tbody></table>`;

    // Per-run detail list with manual eligibility override, one collapsible
    // section per genotype. Collapsed by default so the quick-glance summary
    // table above stays the primary view during a live assay.
    currentAssay.genotypes.forEach(g => {
      const runs = summary[g].runs;
      if (runs.length === 0) return;

      html += `<details class="run-history-genotype">` +
              `<summary>${escapeHTML(g)} — run details</summary>` +
              `<table class="run-history-table"><thead><tr>` +
              `<th>Animal</th><th>Status</th><th>Eligible</th><th>Override</th>` +
              `</tr></thead><tbody>`;

      runs.forEach(r => {
        const statusLabel = RUN_STATUS_LABELS[r.status] ?? r.status;
        // Colour is the primary signal here — the researcher scans this column,
        // not reads it word by word — so eligibility gets a solid state pill
        // (green/red) while "(manual)" gets its own amber tag, deliberately a
        // different hue from both eligibility states and the app's own indigo
        // accent, so "a human overrode this" always reads as its own category.
        const eligibleLabel = r.eligibleForAnalysis
          ? `<span class="status-pill status-pill--good">✓ Eligible</span>`
          : `<span class="status-pill status-pill--bad">✕ Ineligible</span>`;
        const manualTag = r.manuallyOverridden
          ? ` <span class="override-badge" title="Manually ${r.eligibleForAnalysis ? "included" : "excluded"}${r.overrideReason ? `: ${escapeHTML(r.overrideReason)}` : ""}">(manual)</span>`
          : "";
        const toggleLabel = r.eligibleForAnalysis ? "Mark Ineligible" : "Mark Eligible";

        html += `<tr data-run-id="${escapeHTML(r.runId)}">` +
                `<td>${escapeHTML(String(r.animalIndex))}</td>` +
                `<td>${escapeHTML(statusLabel)}</td>` +
                `<td>${eligibleLabel}${manualTag}</td>` +
                `<td class="run-override-cell">` +
                `<input type="text" class="override-reason-input" placeholder="Optional reason" ` +
                `aria-label="Reason for overriding ${escapeHTML(g)} animal ${escapeHTML(String(r.animalIndex))}" ` +
                `value="${escapeHTML(r.overrideReason || "")}">` +
                `<button type="button" class="override-toggle-btn secondary" data-run-id="${escapeHTML(r.runId)}">` +
                `${toggleLabel}</button>` +
                `</td></tr>`;
      });

      html += `</tbody></table></details>`;
    });

    container.innerHTML = html;
  }

  /**
   * Manually overrides a completed/stopped run's effective eligibility for
   * analysis. The automatic determination is preserved separately in
   * autoEligibleForAnalysis/autoIneligibleReason (set once, never changed),
   * so the override is always traceable back to what the system originally
   * decided — surfaced in exports via the "Manual Override" row.
   *
   * @param {Object}  run          - The run object to mutate.
   * @param {boolean} newEligible  - The new effective eligibleForAnalysis value.
   * @param {string}  [reasonText] - Optional free-text note (not mandatory).
   */
  async function toggleRunEligibilityOverride(run, newEligible, reasonText = "") {
    const activeTrial = getActiveTrial(currentAssay);
    if (!activeTrial) return;

    run.eligibleForAnalysis = newEligible;
    run.manuallyOverridden  = true;
    run.overrideReason      = reasonText.trim() || null;
    run.overrideAt          = Date.now();
    // Effective ineligible reason: cleared when now-eligible, otherwise the
    // user's note (or a default) — the original auto reason lives on in
    // autoIneligibleReason regardless of what happens here.
    run.ineligibleReason    = newEligible ? null : (run.overrideReason || "Manually marked ineligible");

    await saveRun(currentAssay.assayId, activeTrial.trialId, run);
    currentAssay.lastModifiedAt = Date.now();
    saveAssay(currentAssay).catch(err => console.error("Failed to update assay metadata:", err));

    updateProgressTable();
    refreshGenotypeDropdownCounts();
    updateProgressBadge();
    showToast(`Run manually marked ${newEligible ? "eligible" : "ineligible"}.`, "info", 3000);
  }

  // Event delegation on the stable container element — updateProgressTable()
  // rebuilds its innerHTML on every call, so a listener bound to individual
  // buttons would be lost on each rebuild. Bound once here instead.
  {
    const progressContainer = document.getElementById("assayProgress");
    if (progressContainer) {
      progressContainer.addEventListener("click", e => {
        const btn = e.target.closest(".override-toggle-btn");
        if (!btn) return;
        const runId = btn.dataset.runId;
        const trial = currentAssay ? getActiveTrial(currentAssay) : null;
        const run   = trial?.runs.find(r => r.runId === runId);
        if (!run) return;
        const reasonInput = btn.closest("tr")?.querySelector(".override-reason-input");
        toggleRunEligibilityOverride(run, !run.eligibleForAnalysis, reasonInput?.value ?? "");
      });
    }
  }

  /**
   * Populates the export dataset list with checkboxes for each trial and
   * the two pooled (completed-only vs all-trials) options.
   * Completed trials are pre-checked; abandoned/active are unchecked.
   * Shows a per-genotype run breakdown alongside the totals.
   * Syncs the Select All checkbox and refreshes button state after building.
   *
   * @param {Object} assay - The full assay object.
   */
  function populateExportDatasetList(assay) {
    const container = document.getElementById("exportDatasetList");
    container.innerHTML = "";

    if (!assay || !assay.trials) return;

    // Accumulate into a string and assign once — avoids O(n²) DOM
    // re-parsing that happens when innerHTML += is called inside a loop
    // (each append reads the entire current DOM, re-serialises it, and
    // re-parses the concatenated result).
    let html = "";

    assay.trials.forEach(trial => {
      const isCompleted = trial.status === "completed";
      const isAbandoned = trial.status === "abandoned";
      const total       = trial.runs.length;
      const eligible    = trial.runs.filter(r => r.eligibleForAnalysis).length;

      // per-genotype run count breakdown
      const genotypeSummary = assay.genotypes
        .map(g => {
          const n = trial.runs.filter(r => r.genotype === g).length;
          return n > 0 ? `${escapeHTML(g)}: ${n}` : null;
        })
        .filter(Boolean)
        .join(", ");

      // Same green-pill treatment as the assay screen's progress table, so
      // "how much usable data is in this trial" reads the same way in both
      // places instead of being colored state in one and plain text here.
      const eligibleDisplay = eligible > 0
        ? `<span class="count-pill count-pill--good">${eligible}</span>`
        : eligible;

      html +=
        `<label>` +
        `<input type="checkbox" data-dataset-type="trial" data-trial-id="${trial.trialId}"` +
        ` aria-label="Trial ${Number(trial.trialIndex)}, ${eligible} eligible of ${total} total${isAbandoned ? ', abandoned' : ''}"` +
        ` ${isCompleted ? "checked" : ""}>` +
        ` Trial ${Number(trial.trialIndex)}` +
        ` — ${eligibleDisplay} eligible (${total} total)` +
        (genotypeSummary ? ` &middot; ${genotypeSummary}` : "") +
        (isAbandoned ? " <em>(abandoned)</em>" : "") +
        `</label>`;
    });

    html +=
      `<label><input type="checkbox" data-dataset-type="pooled" ` +
      `data-include-abandoned="false" checked> Pooled (completed trials only)</label>`;

    html +=
      `<label><input type="checkbox" data-dataset-type="pooled" ` +
      `data-include-abandoned="true"> Pooled (include abandoned)</label>`;

    // Single assignment — all trial rows are parsed in one pass
    container.innerHTML = html;

    // ── Touch-Index exclusion advisory ──────────────────────────────────────
    // Warn the experimenter if any eligible run has a stimCount that is not an
    // exact multiple of binSize — those trailing stimuli are dropped in the
    // Touch Index calculation, which can subtly skew per-animal summaries.
    //
    // NOTE: r.values is the definitive record of recorded stimuli for a run.
    // stimCount is not stored on individual run objects — only on the assay.
    // r.values.length is therefore the correct canonical source for the
    // per-run stimulus count.  If the data model ever changes so that values
    // is trimmed or normalised separately from the recorded stimulus count,
    // this check should be updated to use a dedicated run.stimCount field.
    const tiWarn = document.getElementById("tiExclusionWarning");
    if (tiWarn) {
      if (assay.binSize) {
        const affectedTrials = assay.trials.filter(trial =>
          trial.runs.some(r =>
            r.eligibleForAnalysis &&
            r.values &&
            r.values.length % assay.binSize !== 0
          )
        );
        if (affectedTrials.length > 0) {
          tiWarn.textContent =
            `⚠ ${affectedTrials.length} trial(s) contain runs whose stimulus count ` +
            `is not a multiple of bin size (${assay.binSize}). ` +
            `Trailing stimuli will be excluded from binned analysis.`;
          tiWarn.hidden = false;
        } else {
          tiWarn.hidden = true;
        }
      } else {
        // binSize is falsy (0, missing, or legacy data) — always hide to avoid
        // a stale warning from a previous assay persisting on screen.
        tiWarn.hidden = true;
      }
    }

    // Sync select-all state and button enabled state after rebuilding the list
    syncExportSelectAll();
    refreshExportButtonState();
  }

  /**
   * Enables or disables the Export and Preview buttons based on whether at
   * least one dataset checkbox is currently checked.
   */
  function refreshExportButtonState() {
    const anyChecked =
      document.querySelectorAll("#exportDatasetList input[type='checkbox']:checked").length > 0;
    UI.Buttons.exportExcel.disabled  = !anyChecked;
    UI.Buttons.previewExcel.disabled = !anyChecked;
    if (UI.Buttons.exportCSV) UI.Buttons.exportCSV.disabled = !anyChecked;
  }

  /**
   * Updates the "Select all datasets" master checkbox to reflect the current
   * checked / indeterminate state of all dataset checkboxes.
   */
  function syncExportSelectAll() {
    const all      = document.querySelectorAll("#exportDatasetList input[type='checkbox']");
    const checked  = Array.from(all).filter(cb => cb.checked);
    const selAll   = UI.Inputs.exportSelectAll;
    if (!selAll) return;
    selAll.checked       = checked.length === all.length && all.length > 0;
    selAll.indeterminate = checked.length > 0 && checked.length < all.length;
  }

  // escapeHTML is imported from utils.js (shared with export.js).
  // The local copy that was here has been removed.

  /**
   * Builds and renders the trial summary card on the export screen.
   * Shows eligible run counts and mean overall response rate per genotype
   * for the most recently completed trial.
   *
   * @param {Object} assay - The fully hydrated assay (after hydrateAssay()).
   */
  function renderTrialSummaryCard(assay) {
    // Trial summary removed — keep card permanently hidden.
    const card = document.getElementById("trialSummaryCard");
    if (card) card.hidden = true;
  }

  /**
   * Fetches all saved assays from IndexedDB and renders them as a list
   * in the Saved Assays overlay. Each entry shows the assay name, date,
   * and action buttons (Start New Trial, Export, Delete).
   */
  async function populateSavedAssaysList() {
    // Show a loading indicator while IDB is read
    UI.Displays.savedAssaysList.innerHTML = `<p class="saved-assays-loading">Loading\u2026</p>`;

    let assays;
    try {
      assays = await loadAllAssays();
    } catch (err) {
      console.error("populateSavedAssaysList: IDB read failed:", err);
      UI.Displays.savedAssaysList.innerHTML = `
        <div class="saved-assays-empty">
          <p><strong>Could not load saved assays.</strong><br>
          There was a problem reading from storage (${err?.message ?? "unknown error"}).</p>
          <button class="secondary" id="retryLoadAssays" style="margin-top:0.75rem;">Retry</button>
        </div>`;
      document.getElementById("retryLoadAssays")?.addEventListener("click", populateSavedAssaysList);
      return;
    }

    UI.Displays.savedAssaysList.innerHTML = "";

    if (assays.length === 0) {
      // Styled empty state with icon instead of plain text
      UI.Displays.savedAssaysList.innerHTML = `
        <div class="saved-assays-empty">
          <svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 24 24"
               fill="none" stroke="currentColor" stroke-width="1.5"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            <line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>
          </svg>
          <p><strong>No saved assays yet</strong>Complete an assay setup to get started. Your experiments will appear here.</p>
        </div>`;
      return;
    }

    // Sort newest first
    let html = "";
    assays.sort((a, b) => b.createdAt - a.createdAt).forEach(assay => {
      // Name is the primary identifier and gets its own line; genotypes + date
      // are secondary metadata on a muted line underneath — previously all
      // three were run together in one sentence-like string that wrapped
      // awkwardly for assays with several genotypes.
      const metaParts = [];
      if (assay.genotypes && assay.genotypes.length) metaParts.push(escapeHTML(assay.genotypes.join(", ")));
      metaParts.push(formatDateTime(assay.createdAt));

      html += `
        <div class="saved-assay-row">
          <div class="assay-row-header">
            <input type="checkbox" class="assay-select-checkbox" data-assay-id="${escapeHTML(assay.assayId)}">
            <div class="assay-info">
              <div class="assay-info-name">${escapeHTML(assay.assayName) || "Untitled"}</div>
              <div class="assay-info-meta">${metaParts.join(" &middot; ")}</div>
            </div>
          </div>
          <div class="assay-actions">
            <button class="secondary" data-action="start"  data-assay-id="${escapeHTML(assay.assayId)}">Start New Trial</button>
            <button class="secondary" data-action="export" data-assay-id="${escapeHTML(assay.assayId)}">Export</button>
            <button class="btn-danger-outline" data-action="delete" data-assay-id="${escapeHTML(assay.assayId)}"
              data-assay-name="${escapeHTML(assay.assayName)}">Delete</button>
          </div>
        </div>
      `;
    });

    UI.Displays.savedAssaysList.innerHTML = html;
    UI.Buttons.deleteSelectedAssays.disabled  = true;
    UI.Inputs.selectAllAssays.checked         = false;
    UI.Inputs.selectAllAssays.indeterminate   = false;  // clear indeterminate on every rebuild
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
    // Stop any running Test Rig loop when the app is backgrounded — it has no
    // reason to keep ticking/vibrating while the tab isn't visible.
    if (document.visibilityState === "hidden") stopTestRig();

    if (document.visibilityState === "hidden" && currentState === STATES.RUNNING && currentAssay) {
      // Emergency flush: persist whatever is recorded so far before the browser suspends us.
      // Do NOT call stopRunEarly() here — the scheduler's gap check (Step 0) will stop the
      // run cleanly when the app resumes once the gap exceeds 2×ISI. Calling stopRunEarly()
      // here AND letting the gap check fire on resume creates a double-stop race where two
      // concurrent IDB writes target the same run record.
      const activeTrial = getActiveTrial(currentAssay);
      const run = activeRun || activeTrial?.runs.find(r => r.status === "active");
      if (run && activeTrial) {
        saveRun(currentAssay.assayId, activeTrial.trialId, run).catch(() => {});
      }
    }

    // Wake Locks are released when hidden; re-acquire when visible, but only
    // if a run is still active — there is no point holding the lock otherwise.
    // Also check activeRun !== null. On slow devices the timing-gap auto-stop
    // in scheduler() fires on the first tick after resume, which means currentState
    // is still RUNNING when this handler fires. Without the activeRun guard, we
    // re-acquire a lock that will be released again moments later.
    if (wantsWakeLock && document.visibilityState === "visible" && currentState === STATES.RUNNING && activeRun !== null) {
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
  window.addEventListener("beforeunload", e => {
    if (currentState !== STATES.RUNNING || !currentAssay) return;

    // Show the browser's native "Leave site?" dialog when a run is active.
    // Setting returnValue triggers the confirmation on all modern browsers.
    e.preventDefault();
    e.returnValue = "";  // Required for Chrome/Edge (legacy spec)

    // snapshot the current run values to sessionStorage synchronously
    // before the page is torn down. On mobile browsers (iOS Safari, Chrome Android)
    // the async IDB write inside stopRunEarly() is not guaranteed to commit before
    // the page is unloaded. sessionStorage writes are synchronous and survive a
    // same-origin reload, giving abandonAllActiveTrialsInDB() on next launch a
    // fallback to tag the run as stopped even if the IDB write was dropped.
    try {
      const activeTrial = getActiveTrial(currentAssay);
      const runToSave   = activeRun || activeTrial?.runs.find(r => r.status === "active");
      if (runToSave && activeTrial) {
        sessionStorage.setItem("touchAssayCrashGuard", JSON.stringify({
          assayId:  currentAssay.assayId,
          trialId:  activeTrial.trialId,
          runId:    runToSave.runId,
          values:   runToSave.values,
          savedAt:  Date.now()
        }));
      }
    } catch { /* sessionStorage may be unavailable in some private-browse modes */ }

    // beforeunload should NOT call stopRunEarly() because the user
    // may click "Stay" on the Leave dialog. stopRunEarly() has irreversible side
    // effects (marks the run stoppedEarly, stops the Worker), so it should only
    // fire on actual page unload. The `unload` event below handles this.
    // NOTE: `unload` is unreliable in modern browsers (especially mobile), but
    // the sessionStorage crash-guard snapshot above provides a safety net.
  });

  // move stopRunEarly() to the `unload` event so it only fires
  // when the user actually leaves, not when they click "Stay" on the dialog.
  window.addEventListener("unload", () => {
    if (currentState !== STATES.RUNNING || !currentAssay) return;
    stopRunEarly("App closing \u2014 run stopped for data safety");
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
    // Also guard on activeRun: stopCueLoop() nulls activeRun synchronously, but
    // a tick message already queued in the event loop can still arrive before
    // completeRunNormally() calls setState(POISED). Checking activeRun here means
    // those late ticks exit immediately without re-entering scheduler().
    if (e.data === "tick" && currentState === STATES.RUNNING && currentAssay && activeRun) {
      scheduler();
    }
  };


  /* -----------------------------------------------------------------------
     Navigation Helpers (shared between newAssay and headerHome)
  ----------------------------------------------------------------------- */

  /**
   * Zeroes all scheduling and timing counters so a fresh run cannot be
   * corrupted by values left over from a previous session.
   *
   * Also resets the warmup guard — navigating away mid-countdown would
   * otherwise leave `isWarmingUp = true`, blocking the next run from starting.
   */
  function resetTimingState() {
    isWarmingUp            = false;
    currentStimulusIndex   = 0;
    // Also reset the two speech/audio index counters so a fresh session after
    // resetToSetup() cannot inherit stale values from a previous run.
    nextSpeechIndex        = 0;
    nextAudioStimulusIndex = 0;
    tapTimestamps          = [];
    tapReadIndex           = 0;
    lastSchedulerTime      = 0;
    nextAudioScheduleTime  = 0.0;
    nextSpeechTime         = 0.0;
    nextDataIntervalTime   = 0.0;
  }

  /**
   * Tears down the active assay and returns the app to the Setup screen.
   *
   * Resets the form, clears the progress table, and zeroes all
   * timing/scheduling counters. Called by both the "New Assay" button
   * and the header logo/home button.
   */
  function resetToSetup() {
    // clear the double-tap guard so a first-tap on a previous assay
    // cannot carry over and skip the confirmation on the very next assay.
    pendingStart = false;
    clearTimeout(startTimeout);

    // Close any open overlay screen (settings, guidelines, saved assays).
    // resetToSetup() can be called from the header logo while an overlay is
    // open — without this, the overlay stays on top of the reset setup screen.
    UI.Screens.settings.hidden      = true;
    UI.Screens.guidelines.hidden    = true;
    UI.Screens.savedAssays.hidden   = true;
    UI.Screens.assayDefaults.hidden = true;
    document.body.classList.remove("state-overlay");
    // also remove state-warming-up so the amber countdown bar and live
    // counter don't remain visible when the user navigates home mid-warmup.
    document.body.classList.remove("state-warming-up");
    if (UI.Displays.metronomeBar) {
      UI.Displays.metronomeBar.classList.remove("warmup");
      UI.Displays.metronomeBar.style.transform = "scaleX(0)";
      UI.Displays.metronomeBar.style.removeProperty("--warmup-duration");
    }
    UI.Displays.overflowMenu.hidden = true;
    UI.Buttons.overflowMenu.setAttribute("aria-expanded", "false");

    currentAssay = null;
    UI.Forms.setup.reset();
    UI.Inputs.assayName.value     = generateAutoID();
    UI.Displays.binWarning.hidden = true;

    // form.reset() clears the hidden #genotypes input value but does NOT
    // clear the chip DOM elements — chips from the previous assay would remain
    // visually, while the hidden input is empty, causing a confusing validation
    // error on next submit. Clear the chip list explicitly.
    const chipList = document.getElementById("chipList");
    if (chipList) chipList.innerHTML = "";

    // Clear progress table from the previous assay
    const progressContainer = document.getElementById("assayProgress");
    // guard against null — element may not exist in all DOM states.
    if (progressContainer) {
      progressContainer.innerHTML = "";
      progressContainer.hidden    = true;
    }
    // Sync progress toggle button state
    const label = UI.Buttons.progress.querySelector(".toggle-progress-label");
    const eyeOn  = UI.Buttons.progress.querySelector(".toggle-progress-icon-eye");
    const eyeOff = UI.Buttons.progress.querySelector(".toggle-progress-icon-eye-off");
    if (label)  label.textContent = "Show Progress";
    if (eyeOn)  eyeOn.hidden     = true;
    if (eyeOff) eyeOff.hidden    = false;
    UI.Buttons.progress.setAttribute("aria-pressed", "false");

    resetTimingState();
    setState(STATES.SETUP);
  }




  /* -----------------------------------------------------------------------
     showConfirmModal
     Theme-aware async confirmation dialog. Replaces blocking confirm() that
     cannot be styled and may be suppressed in PWA / Private Browsing mode.
   ----------------------------------------------------------------------- */

  /**
   * Shows a lightweight confirmation modal that respects the app's theme.
   *
   * @param {string} title      Bold heading shown at the top of the dialog.
   * @param {string} body       Descriptive sentence shown below the heading.
   * @param {string} [okLabel]  Label for the confirm button (default "Confirm").
   * @param {string} [okClass]  CSS class for the confirm button — "danger" (default,
   *   for destructive actions like delete) or "primary" (for benign actions like
   *   offering an alternate export format).
   * @returns {Promise<boolean>} Resolves true on confirm, false on cancel.
   */
  function showConfirmModal(title, body, okLabel = "Confirm", okClass = "danger") {
    return new Promise(resolve => {
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay";

      // build skeleton with static HTML only — no user-supplied text.
      // title, body, and okLabel are set via textContent below so they can never
      // introduce HTML injection even if a future call-site passes unescaped data.
      overlay.innerHTML =
        `<div class="modal-content" style="max-width:400px">` +
          `<div class="modal-header">` +
            `<h2 style="font-size:1.05rem;margin:0;font-weight:700" data-modal-title></h2>` +
          `</div>` +
          `<div style="padding:1.1rem 1.25rem;font-size:0.92rem;line-height:1.55;color:var(--text-muted)" data-modal-body></div>` +
          `<div class="modal-actions" style="gap:0.75rem;justify-content:flex-end">` +
            `<button type="button" class="secondary" data-modal-cancel>Cancel</button>` +
            `<button type="button" data-modal-ok></button>` +
          `</div>` +
        `</div>`;

      // Set user-supplied text safely via textContent — never via innerHTML.
      // use data-modal-ok / data-modal-cancel attributes instead of
      // id="_confirmOk" / id="_confirmCancel" — global IDs are non-unique and could
      // cross-resolve two concurrent modal Promises if the user rapid-clicked.
      overlay.querySelector("[data-modal-title]").textContent = title;
      overlay.querySelector("[data-modal-body]").textContent  = body;
      overlay.querySelector("[data-modal-ok]").textContent    = okLabel;
      overlay.querySelector("[data-modal-ok]").classList.add(okClass);

      document.body.appendChild(overlay);

      // removeEventListener moved into cleanup() so it fires on
      // every close path (OK, Cancel, backdrop, Escape) — not just Escape.
      const cleanup = result => {
        document.removeEventListener("keydown", onKey);
        document.body.removeChild(overlay);
        resolve(result);
      };
      overlay.querySelector("[data-modal-ok]").addEventListener("click",     () => cleanup(true));
      overlay.querySelector("[data-modal-cancel]").addEventListener("click", () => cleanup(false));
      overlay.addEventListener("click", e => { if (e.target === overlay) cleanup(false); });
      const onKey = e => {
        if (e.key === "Escape") cleanup(false);
      };
      document.addEventListener("keydown", onKey);
    });
  }

  /* -----------------------------------------------------------------------
     Event Bindings
  ----------------------------------------------------------------------- */

  /**
   * Saves all current setup-form field values as a JSON draft in localStorage.
   * Called on every input event (debounced) so partial entries survive a
   * tab close or navigation away.
   *
   * Uses a 400ms debounce so rapid keystrokes only trigger one write per burst.
   */
  let _draftSaveTimer = null;
  function scheduleDraftSave() {
    clearTimeout(_draftSaveTimer);
    _draftSaveTimer = setTimeout(() => {
      try {
        const draft = {
          assayName:   UI.Inputs.assayName?.value?.trim() || "",
          genotypes:   UI.Inputs.genotypes?.value || "",
          isi:         UI.Inputs.isi?.value        || "",
          stimCount:   UI.Inputs.stimCount?.value  || "",
          binSize:     UI.Inputs.binSize?.value    || "",
          temperature: UI.Inputs.temperature?.value || "",
          humidity:    UI.Inputs.humidity?.value   || ""
        };
        localStorage.setItem("touchAssaySetupDraft", JSON.stringify(draft));
      } catch { /* storage not available */ }
    }, 400);  // 400ms debounce
  }

  /**
   * Restores a saved setup draft into the form fields and genotype chips.
   * Only runs if there is a non-empty draft in localStorage.
   */
  function restoreSetupDraft() {
    // Always apply assay defaults first so the form has reasonable values
    // even when there is no saved draft. User-entered drafts below will
    // overwrite these if a draft exists, so defaults are only visible on
    // a truly fresh setup screen.
    const defaults = _loadAssayDefaults();
    UI.Inputs.isi.value         = defaults.isi;
    UI.Inputs.stimCount.value   = defaults.stimCount;
    UI.Inputs.binSize.value     = defaults.binSize;
    UI.Inputs.temperature.value = defaults.temperature;
    UI.Inputs.humidity.value    = defaults.humidity;

    let draft;
    try {
      const raw = localStorage.getItem("touchAssaySetupDraft");
      if (!raw) return;   // no draft — defaults applied above are sufficient
      draft = JSON.parse(raw);
    } catch { return; }

    if (draft.assayName)                          UI.Inputs.assayName.value   = draft.assayName;
    if (draft.isi)                                 UI.Inputs.isi.value          = draft.isi;
    if (draft.stimCount)                           UI.Inputs.stimCount.value    = draft.stimCount;
    if (draft.binSize)                             UI.Inputs.binSize.value      = draft.binSize;
    // Use != null (not truthiness) so that valid values of 0 (e.g. 0 °C, 0% RH) are restored.
    if (draft.temperature != null && draft.temperature !== "") UI.Inputs.temperature.value  = draft.temperature;
    if (draft.humidity    != null && draft.humidity    !== "") UI.Inputs.humidity.value     = draft.humidity;

    // Restore genotype chips through the shared chip-input infrastructure
    // (window.ChipInput, exposed by index.html) so restored chips get the same
    // fuzzy-dedup check, 10-genotype cap, drag-to-reorder support, and max-hint
    // updates as chips added interactively — instead of a hand-rolled DOM block
    // that silently skipped all of that.
    if (draft.genotypes && window.ChipInput) {
      window.ChipInput.clearChips();
      const genArr = draft.genotypes.split(",").map(g => g.trim()).filter(Boolean);
      genArr.forEach(val => window.ChipInput.addChip(val));
    }

    // Trigger bin warning recalculation after restoring values
    updateBinWarning();
    // Re-evaluate genotype max hint after restoring chips
    if (window.ChipInput?.updateGenotypeMaxHint) {
      window.ChipInput.updateGenotypeMaxHint();
    }
    // Re-evaluate grace×ISI warning after restoring ISI value
    updateGraceIsiWarning();
  }

  /** Clears the setup draft from localStorage. Called after a successful Begin. */
  function clearSetupDraft() {
    try { localStorage.removeItem("touchAssaySetupDraft"); } catch { /* noop */ }
  }



  // ── Draft auto-save: wire all setup form fields ────────────────────
  // Any change to a setup field is debounced and written to localStorage so
  // the form survives accidental navigation or a page refresh.
  [
    UI.Inputs.assayName,
    UI.Inputs.isi,
    UI.Inputs.stimCount,
    UI.Inputs.binSize,
    UI.Inputs.temperature,
    UI.Inputs.humidity,
  ].forEach(el => {
    if (el) el.addEventListener("input", scheduleDraftSave);
  });

  // Also save when the hidden genotypes field changes (updated by chip script)
  if (UI.Inputs.genotypes) {
    UI.Inputs.genotypes.addEventListener("change", scheduleDraftSave);
  }

  UI.Forms.setup.addEventListener("submit", async function (event) {
    event.preventDefault();

    const setupValues = {
      assayName:   UI.Inputs.assayName.value.trim(),
      genotypes:   UI.Inputs.genotypes.value.split(",").map(g => g.trim()).filter(g => g !== ""),
      isi:         Number(UI.Inputs.isi.value),
      stimCount:   Number(UI.Inputs.stimCount.value),
      binSize:     Number(UI.Inputs.binSize.value),
      temperature: UI.Inputs.temperature.value === "" ? null : Number(UI.Inputs.temperature.value),
      humidity:    UI.Inputs.humidity.value    === "" ? null : Number(UI.Inputs.humidity.value)
    };

    const validation = validateInputs(setupValues);
    if (!validation.isValid) {
      showToast(
        "Please fix: " + validation.errors.join(" • "),
        "error",
        6000
      );
      return;
    }

    // Show non-blocking advisory for very short ISI
    if (validation.warnings && validation.warnings.length > 0) {
      validation.warnings.forEach(w => showToast(w, "warning", 7000));
    }

    // Create and persist the assay and its first trial
    currentAssay = createAssay(setupValues);
    await saveAssay(currentAssay);

    const firstTrial = createTrial(1);
    currentAssay.trials.push(firstTrial);
    await saveTrial(currentAssay.assayId, firstTrial);

    // Clear the draft now that the assay has been saved
    clearSetupDraft();

    populateGenotypeSelect(setupValues.genotypes);
    updateProgressTable();
    applyProgressVisibilityPreference();
    setState(STATES.CONFIGURED);
  });

  // ── Bin warning live update ─────────────────────────────────────────────
  UI.Inputs.stimCount.addEventListener("input", updateBinWarning);
  UI.Inputs.binSize.addEventListener("input",   updateBinWarning);

  // ── Grace × ISI conflict warning (setup screen, live) ──────────────────
  // Fires whenever the ISI changes so the experimenter sees the conflict
  // before clicking Begin, not just at run-start.
  UI.Inputs.isi.addEventListener("input", updateGraceIsiWarning);
  // The gracePeriod slider listener (registered later in initializeSettings)
  // already updates gracePeriodMs and calls updateGraceIsiWarning() from
  // within the canonical settings listener — no second listener needed here.

  // feature-detect PointerEvent so only one event fires per touch.
  // On modern iOS/Android *both* pointerdown and touchstart fire for the same
  // physical touch — using both creates a double-fire risk when the 80ms
  // TAP_COOLDOWN window is straddled by a GC pause.
  if (window.PointerEvent) {
    UI.Buttons.tap.addEventListener("pointerdown", e => {
      e.preventDefault();  // Prevents ghost click / double-fire on touch devices
      executeTapAction();
    });
  } else {
    // Fallback for legacy Android WebViews that do not implement Pointer Events
    UI.Buttons.tap.addEventListener("touchstart", e => {
      e.preventDefault();  // Suppress the following 300ms-delayed click
      executeTapAction();
    }, { passive: false });
  }

  // ── Space bar shortcut ──────────────────────────────────────────────────
  document.addEventListener("keydown", event => {
    // While the genotype panel is open, let Space/Enter/Tab behave natively
    // on its focused option (selects it, via the browser's own button
    // activation) instead of being hijacked below for the tap shortcut —
    // the "Space always taps" rule that follows only makes sense once the
    // user isn't actively mid-selection. Escape still needs to fall through
    // so the check further below can close the panel.
    if (!UI.Inputs.genotypeOverlay.hidden && event.key !== "Escape") return;

    // Prevent Space from scrolling the page while on the trial screen,
    // even during key-repeat (held key). Do this before the repeat-guard
    // so that a held Space never triggers a browser scroll.
    const _onAssayForScroll = currentState === STATES.CONFIGURED
                           || currentState === STATES.POISED
                           || currentState === STATES.RUNNING;
    if (_onAssayForScroll && event.key === " ") {
      event.preventDefault();
    }

    // Ignore held-down keys (auto-repeat) for tap actions
    if (event.repeat) return;

    // ── Double-Escape to stop an active run ─────────────────────────────
    // First Escape press: show a confirmation toast. Second press within 2 s
    // (after the first) calls stopRunEarly(). This prevents accidental stops.
    if (event.key === "Escape" && currentState === STATES.RUNNING && !isWarmingUp) {
      const now = Date.now();
      if (lastEscapeTime > 0 && now - lastEscapeTime <= 2000) {
        // Second press within window — stop propagation so toast.js's global
        // Escape listener doesn't fire after us and immediately dismiss
        // whichever toast is newest once stopRunEarly() posts its own below.
        event.stopImmediatePropagation();
        lastEscapeTime = 0;
        // dismissLatestToast() dismisses whatever toast is currently newest,
        // so it must come BEFORE stopRunEarly(): at this point the newest
        // toast is still the "Press Esc again…" warning, so this clears that
        // one. Calling it after stopRunEarly() would instead dismiss the
        // "Run cancelled" toast that stopRunEarly() just posted.
        dismissLatestToast();
        stopRunEarly("Run stopped early by user");
      } else {
        // First press — arm the confirmation
        lastEscapeTime = now;
        showToast("Press Esc again within 2 s to stop the run.", "warning", 2500);
      }
      return;
    }

    // Reset the escape timer if any other key is pressed during RUNNING
    if (currentState === STATES.RUNNING && event.key !== "Escape") {
      lastEscapeTime = 0;
    }

    // allow Escape to cancel a warmup countdown in progress.
    // Setting isWarmingUp = false causes the runWarmup() loop to exit on its
    // next iteration, but we also restore the UI immediately here so the user
    // sees instant feedback instead of waiting up to 1 s for the setTimeout.
    if (event.key === "Escape" && isWarmingUp) {
      // set isWarmingUp = false so the runWarmup() loop exits cleanly
      // on its next iteration, then let _cancelWarmupUI() (defined inside runWarmup)
      // handle ALL teardown steps: body class, bar reset, warmup overlay, labels.
      // The previous inline duplicate omitted the body.classList.remove() and bar
      // reset, leaving the amber progress bar animation running for up to 1 second.
      //
      // Because _cancelWarmupUI is a closure inside runWarmup() and is not accessible
      // here, we replicate only what it can't do (the timer cancel) and rely on the
      // runWarmup loop to call _cancelWarmupUI itself on the very next setTimeout tick.
      // The UI elements that were previously updated inline are now left for that tick,
      // which fires within ≤1 s — acceptable for a cancel action.
      isWarmingUp = false;
      // also cancel the pendingStart reset timer — if the warmup
      // started while startTimeout was still running, the timer would fire
      // after Escape and write a stale label into tapLabel.
      clearTimeout(startTimeout);
      // Eagerly restore body class and bar so the UI reacts instantly rather than
      // waiting up to 1 s for the runWarmup loop to call _cancelWarmupUI.
      document.body.classList.remove("state-warming-up");
      const _bar = UI.Displays.metronomeBar;
      if (_bar) {
        _bar.classList.remove("warmup");
        _bar.style.transform = "scaleX(0)";
        _bar.style.removeProperty("--warmup-duration");
      }
      // Hide the in-button overlay and remove the pulsing ring class
      UI.Displays.warmup.hidden = true;
      // restore AT visibility on Escape path.
      UI.Displays.warmup.removeAttribute("aria-hidden");
      UI.Displays.tapLabel.removeAttribute("aria-hidden");
      UI.Buttons.tap.classList.remove("warming-up");
      const _sel = UI.Inputs.genotypeSelect.value;
      if (_sel && (currentState === STATES.CONFIGURED || currentState === STATES.POISED)) {
        const _at = getActiveTrial(currentAssay);
        const _n  = (_at?.runs.filter(r => r.genotype === _sel && r.status === "completed" && r.eligibleForAnalysis).length ?? 0) + 1;
        UI.Displays.tapLabel.textContent = `Start ${_sel} (Animal ${_n})`;
      }
      return;
    }

    // Escape key closes preview modal, overlay screens, and overflow menu.
    if (event.key === "Escape") {
      // 0. Close the genotype picker panel if open
      if (!UI.Inputs.genotypeOverlay.hidden) {
        closeGenotypeOverlay();
        return;
      }
      // 1. Close preview modal if open
      if (!UI.Displays.previewModal.hidden) {
        UI.Displays.previewModal.hidden = true;
        return;
      }
      // 2a. Assay Defaults sub-page — go back to Settings (not main screen)
      if (!UI.Screens.assayDefaults.hidden) {
        UI.Screens.assayDefaults.hidden = true;
        UI.Screens.settings.hidden      = false;
        return;
      }
      // 2b. Close any open overlay screen (settings, guidelines, saved assays)
      if (!UI.Screens.settings.hidden) {
        hideScreenAndRestore(UI.Screens.settings);
        return;
      }
      if (!UI.Screens.guidelines.hidden) {
        hideScreenAndRestore(UI.Screens.guidelines);
        return;
      }
      if (!UI.Screens.savedAssays.hidden) {
        hideScreenAndRestore(UI.Screens.savedAssays);
        return;
      }
      // 3. Close overflow menu if open
      if (!UI.Displays.overflowMenu.hidden) {
        UI.Displays.overflowMenu.hidden = true;
        return;
      }
      return;
    }

    const onAssayScreen = currentState === STATES.CONFIGURED
                       || currentState === STATES.POISED
                       || currentState === STATES.RUNNING;

    if (onAssayScreen) {
      // On the assay screen, Space and Enter must NEVER activate any focused
      // element — including the genotype <select>, buttons, etc.
      // Block the browser default BEFORE any early-return so the <select>
      // dropdown cannot be opened and no button can be activated.
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
      }

      // Non-activation keys (Tab, arrow keys, etc.) pass through unaffected.
      if (event.key !== " " && event.key !== "Enter") return;

      // Enter is silently swallowed — no tap, no button activation. The guard
      // above already ensures key is " " or "Enter", so the only case that
      // reaches this point is "Enter".
      if (event.key === "Enter") return;

      // RUNNING: tap unconditionally takes priority over everything
      if (currentState === STATES.RUNNING) {
        if (!UI.Buttons.tap.disabled) executeTapAction();
        return;
      }

      // If a toast has keyboard focus, let the toast's own keydown handler
      // dismiss it (already wired in toast.js) — don't also trigger a tap
      if (document.activeElement?.classList.contains("toast")) return;

      // Outside a run: Space dismisses the newest visible toast first
      if (dismissLatestToast()) return;

      if (!UI.Buttons.tap.disabled) executeTapAction();
      return;
    }

    // ── Non-assay screens ─────────────────────────────────────────────────
    // Allow normal keyboard input in form fields (text inputs, selects, etc.)
    if (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "SELECT") return;

    // Space only: dismiss toast or trigger tap
    if (event.key === " ") {
      event.preventDefault();
      if (document.activeElement?.classList.contains("toast")) return;
      if (dismissLatestToast()) return;
      if (!UI.Buttons.tap.disabled) executeTapAction();
    }
  });

  // ── Stop run button ─────────────────────────────────────────────────────
  UI.Buttons.stopRun.addEventListener("click", () => stopRunEarly());

  // -- Haptic Armband connect buttons (header icon + Settings card) ---------
  // Both buttons call the same shared helper so status displays stay in sync.
  if (isBluetoothSupported()) {
    // Reveal the header Bluetooth icon and the Settings fieldset
    UI.Buttons.armbandHeaderBtn.removeAttribute("hidden");
    document.querySelectorAll(".armband-fieldset").forEach(el => el.removeAttribute("hidden"));

    // Track last-alerted battery threshold so toasts fire only once per crossing.
    // 100 = "haven't warned yet"; reset to 100 on reconnect so warnings re-arm.
    let _lastBattWarnLevel = 100;

    /**
     * Handles battery level updates pushed by the armband BLE notification.
     * Updates the header badge, Settings badge, and fires threshold toasts.
     * This runs asynchronously from a BLE event -- never on the tap/audio path.
     * @param {number} level  Battery percentage 0-100.
     */
    function _handleArmbandBattery(level) {
      // -- Header badge ----------------------------------------------------
      const badge = UI.Displays.armbandBatteryLevel;
      badge.textContent = level + "%";
      badge.removeAttribute("hidden");

      // Colour: green >20%, amber 10-20%, red <=10%
      badge.className = level > 20 ? "armband-battery-level"
                      : level > 10 ? "armband-battery-level armband-batt-low"
                                   : "armband-battery-level armband-batt-critical";

      // -- Settings badge --------------------------------------------------
      UI.Displays.armbandStatusSettings.textContent = "Connected \u2713  \u00b7  " + level + "%";

      // -- Header button tooltip -------------------------------------------
      UI.Buttons.armbandHeaderBtn.setAttribute("title", "Armband connected \u2014 " + level + "%");
      UI.Buttons.armbandHeaderBtn.setAttribute("aria-label", "Armband connected \u2014 " + level + "% battery");

      // -- Threshold toasts (fire only once per crossing) ------------------
      if (level <= 10 && _lastBattWarnLevel > 10) {
        showToast(
          "Armband battery critical (" + level + "%) \u2014 haptics may cut out soon",
          "error",
          0   // persistent until dismissed
        );
        _lastBattWarnLevel = level;
      } else if (level <= 20 && _lastBattWarnLevel > 20) {
        showToast(
          "Armband battery low (" + level + "%) \u2014 consider charging soon",
          "warning",
          8000
        );
        _lastBattWarnLevel = level;
      } else if (level > 20) {
        // Battery recovered above 20% (e.g. after hot-swap) -- re-arm both warnings
        _lastBattWarnLevel = 100;
      }
    }

    /**
     * Restores the UI to the "connected" state.
     * Called from both the normal connect path and the auto-reconnect callback.
     */
    function _setArmbandConnectedUI() {
      UI.Displays.armbandStatusSettings.textContent = "Connected \u2713";
      UI.Displays.armbandStatusSettings.className   = "armband-status armband-connected";
      // Restore header icon button — remove the "connecting" pending class and
      // re-enable it (it was disabled during the picker/GATT handshake).
      UI.Buttons.armbandHeaderBtn.classList.remove("armband-connecting");
      UI.Buttons.armbandHeaderBtn.disabled = false;
      UI.Buttons.armbandHeaderBtn.classList.add("armband-connected");
      UI.Buttons.armbandHeaderBtn.classList.remove("armband-disconnected");
      UI.Buttons.armbandHeaderBtn.setAttribute("title", "Armband Connected");
      UI.Buttons.armbandHeaderBtn.setAttribute("aria-label", "Armband Connected");
      UI.Buttons.connectArmband.textContent = "Connected \u2713";
      UI.Buttons.connectArmband.disabled    = true;
      // Show disconnect button so user can cleanly switch armbands
      UI.Buttons.disconnectArmband.removeAttribute("hidden");
      // Enable the Test Vibration button now that the armband is ready
      UI.Buttons.testArmband.disabled = false;
    }

    /**
     * Shared connection handler called by both the header icon and Settings button.
     * @param {HTMLButtonElement} btn  The button that was clicked.
     */
    async function _connectArmband(btn) {
      // guard against opening the BLE picker while already connected.
      // Without this, a second requestDevice() call on top of an existing GATT
      // connection leaves the old gattserverdisconnected listener dangling.
      if (isArmbandConnected()) return;

      const isHeaderBtn = btn === UI.Buttons.armbandHeaderBtn;
      btn.disabled = true;
      if (isHeaderBtn) {
        // Do NOT set textContent here — it would destroy the SVG icon child node.
        // Use a CSS class to signal the pending state instead.
        btn.classList.add("armband-connecting");
      } else {
        btn.textContent = "Connecting\u2026";
      }

      try {
        await armbandConnect(
          // onDisconnect callback
          () => {
            UI.Displays.armbandStatusSettings.textContent = "Disconnected \u26a0";
            UI.Displays.armbandStatusSettings.className   = "armband-status armband-disconnected";
            UI.Buttons.armbandHeaderBtn.classList.remove("armband-connected");
            UI.Buttons.armbandHeaderBtn.classList.add("armband-disconnected");
            UI.Buttons.armbandHeaderBtn.setAttribute("title", "Reconnect Armband");
            UI.Displays.armbandBatteryLevel.setAttribute("hidden", "");
            UI.Buttons.connectArmband.disabled    = false;
            UI.Buttons.connectArmband.textContent = "Reconnect";
            UI.Buttons.disconnectArmband.setAttribute("hidden", "");  // hide disconnect btn
            _lastBattWarnLevel = 100;  // re-arm threshold warnings after reconnect
            showToast("Haptic armband disconnected", "warning", 4000);
          },
          // onBatteryUpdate callback
          _handleArmbandBattery,
          // onReconnect callback — fired when the background auto-reconnect succeeds
          () => {
            _setArmbandConnectedUI();
            showToast("Haptic armband reconnected", "success", 3000);
          }
        );

        // -- Connection success ---------------------------------------------
        _setArmbandConnectedUI();
        showToast("Haptic armband connected", "success", 3000);

      } catch (err) {
        // NotFoundError = user cancelled the browser picker -- silent
        if (err.name !== "NotFoundError") {
          showToast("Could not connect armband: " + err.message, "error");
        }
        btn.disabled = false;
        if (btn === UI.Buttons.armbandHeaderBtn) {
          btn.classList.remove("armband-connecting");
        } else {
          btn.textContent = "Connect";
        }
      }
    }

    UI.Buttons.connectArmband.addEventListener("click", () => _connectArmband(UI.Buttons.connectArmband));
    // Header icon: pass itself as btn so its own disabled/text state is managed.
    // When the armband is disconnected (yellow icon) the click opens the picker
    // to reconnect; when already connected it is a no-op (picker will reject).
    UI.Buttons.armbandHeaderBtn.addEventListener("click", () => _connectArmband(UI.Buttons.armbandHeaderBtn));

    // Disconnect button — cleanly tears down the BLE connection
    // so the user can pair a different armband without reloading the page.
    UI.Buttons.disconnectArmband.addEventListener("click", async () => {
      await armbandDisconnect();
      UI.Displays.armbandStatusSettings.textContent = "Not connected";
      UI.Displays.armbandStatusSettings.className   = "armband-status";
      UI.Buttons.armbandHeaderBtn.classList.remove("armband-connected");
      UI.Buttons.armbandHeaderBtn.classList.add("armband-disconnected");
      UI.Buttons.armbandHeaderBtn.setAttribute("title", "Connect Armband");
      UI.Displays.armbandBatteryLevel.setAttribute("hidden", "");
      UI.Buttons.connectArmband.disabled    = false;
      UI.Buttons.connectArmband.textContent = "Connect";
      UI.Buttons.disconnectArmband.setAttribute("hidden", "");
      UI.Buttons.testArmband.disabled = true;  // disable test btn — no armband connected
      _lastBattWarnLevel = 100;
      showToast("Haptic armband disconnected", "info", 3000);
    });

    // Settings: Test Vibration button — sends a single tap to confirm the armband is alive.
    UI.Buttons.testArmband.addEventListener("click", async () => {
      const btn = UI.Buttons.testArmband;
      btn.disabled = true;  // prevent BLE spam by disabling during operation
      const t0 = performance.now();
      await armbandTest();
      // writeValueWithoutResponse resolves when the packet enters the
      // BLE radio transmit buffer (~1 ms), NOT when the armband actually vibrates.
      // The value is therefore the BLE stack dispatch latency, not a round-trip
      // haptic latency measurement.  Renamed label to "dispatch" to avoid implying
      // a meaningful round-trip figure.
      const dispatch = Math.round(performance.now() - t0);
      // Brief visual confirmation so the user knows the command was dispatched.
      btn.classList.add("armband-test-active");
      showToast(`Test vibration dispatched ⚡ (BLE dispatch: ${dispatch} ms)`, "info", 1800);
      // also update the inline element in the settings card so the
      // dispatch time is readable without the toast needing to be open.
      const latencyEl = document.getElementById("armbandLatencyResult");
      if (latencyEl) latencyEl.textContent = `BLE dispatch: ${dispatch} ms`;
      // re-enable after 2000ms (> toast duration of 1800ms) so the
      // button stays disabled until the feedback toast has fully auto-dismissed.
      // Previous value of 1500ms was shorter than the toast, contrary to the comment.
      setTimeout(() => {
        btn.classList.remove("armband-test-active");
        btn.disabled = false;
      }, 2000);
    });
  }

  /* -----------------------------------------------------------------------
     Test Rig — audio/visual/haptic dry run
  ----------------------------------------------------------------------- */

  /**
   * setInterval handle for the running Test Rig loop, or null when stopped.
   * @type {number|null}
   */
  let testRigInterval = null;

  /**
   * Starts a 1 Hz loop that plays a tick tone, flashes a visual indicator,
   * and (if the armband is connected) sends a test haptic pulse — all in
   * sync — so the rig can be sanity-checked end-to-end before mounting an
   * animal. Registered unconditionally (not gated behind Bluetooth support):
   * armbandTest()/isArmbandConnected() are safe no-ops when the armband
   * isn't available, so audio/visual testing still works without it.
   * Writes nothing to IDB and requires no assay/genotype selection.
   */
  async function startTestRig() {
    if (testRigInterval !== null) return;  // already running

    if (currentState === STATES.RUNNING) {
      showToast("Stop the current run before using the Test Rig.", "info", 3000);
      return;
    }

    // Test Rig is started by a real user gesture (button click), so this is a
    // valid place to resume the AudioContext if it isn't already.
    try {
      await warmUpAudio();
    } catch {
      showToast(
        "Audio could not start — check your browser's autoplay/audio settings and try again.",
        "error",
        5000
      );
      return;
    }

    const pulse = () => {
      playTick();
      if (UI.Displays.testRigPulse) {
        UI.Displays.testRigPulse.classList.add("pulse");
        setTimeout(() => UI.Displays.testRigPulse?.classList.remove("pulse"), 150);
      }
      if (isArmbandConnected()) armbandTest();
    };

    pulse();  // immediate first pulse so feedback isn't delayed a full second
    testRigInterval = setInterval(pulse, 1000);

    UI.Buttons.testRigBtn.classList.add("active");
    UI.Buttons.testRigBtn.setAttribute("aria-pressed", "true");
    if (UI.Displays.testRigBtnLabel) UI.Displays.testRigBtnLabel.textContent = "Stop Test Rig";
  }

  /**
   * Stops the Test Rig loop. Safe to call even if it isn't running (no-op),
   * so callers can invoke it defensively from screen-close / backgrounding /
   * run-start paths without checking state first.
   */
  function stopTestRig() {
    if (testRigInterval === null) return;
    clearInterval(testRigInterval);
    testRigInterval = null;

    if (UI.Buttons.testRigBtn) {
      UI.Buttons.testRigBtn.classList.remove("active");
      UI.Buttons.testRigBtn.setAttribute("aria-pressed", "false");
    }
    if (UI.Displays.testRigBtnLabel) UI.Displays.testRigBtnLabel.textContent = "Start Test Rig";
    if (UI.Displays.testRigPulse) UI.Displays.testRigPulse.classList.remove("pulse");
  }

  if (UI.Buttons.testRigBtn) {
    UI.Buttons.testRigBtn.addEventListener("click", () => {
      if (testRigInterval === null) startTestRig();
      else stopTestRig();
    });
  }

  // ── Finish trial button ─────────────────────────────────────────────────
  UI.Buttons.finishTrial.addEventListener("click", async () => {
    // replace browser-native confirm() (which is blocking, cannot be
    // styled, and may be suppressed in PWA mode on some Android browsers) with a
    // lightweight async modal that respects the app's theme.
    const confirmed = await showConfirmModal(
      "Finish this trial?",
      "You will not be able to add more runs to this trial after confirming.",
      "Finish Trial"
    );
    if (!confirmed) return;

    const activeTrial = getActiveTrial(currentAssay);

    // Guard against null (can occur if the trial was already completed via another
    // path, e.g. a rapid double-click or a race with the crash-guard cleanup).
    if (!activeTrial) {
      showToast("No active trial to finish.", "warning", 4000);
      return;
    }

    // markTrialAbandoned/Completed rejects when the trial record is not
    // found in IDB (e.g. a first-launch write was dropped on mobile). Without this
    // try/catch the promise rejection is unhandled, leaving the UI frozen on the
    // assay screen with no error feedback to the experimenter.
    try {
      if (activeTrial.runs.length === 0) {
        await markTrialAbandoned(currentAssay.assayId, activeTrial.trialId, "No runs recorded");
      } else {
        await markTrialCompleted(currentAssay.assayId, activeTrial.trialId);
      }
    } catch (err) {
      console.error("finishTrial: IDB write failed:", err);
      showToast("Could not save trial — please try again. If the problem persists, export your data now.", "error", 7000);
      return;
    }

    // Hydrate FIRST so the export list reflects the updated trial status
    currentAssay = await hydrateAssay(currentAssay.assayId);
    // Render summary card for the just-completed trial
    renderTrialSummaryCard(currentAssay);
    populateExportDatasetList(currentAssay);
    setState(STATES.EXPORT);
  });

  // ── Show/hide progress table ────────────────────────────────────────────
  UI.Buttons.progress.addEventListener("click", () => {
    const progressContainer = document.getElementById("assayProgress");
    progressContainer.hidden = !progressContainer.hidden;
    const nowVisible = !progressContainer.hidden;
    // `hidden` already removes the element from the AT — do NOT
    // also set aria-hidden. Setting aria-hidden="false" on a hidden element
    // can cause some screen readers to announce it erroneously.
    progressContainer.removeAttribute("aria-hidden");
    // Update text, icon, and aria-pressed
    const label  = UI.Buttons.progress.querySelector(".toggle-progress-label");
    const eyeOn  = UI.Buttons.progress.querySelector(".toggle-progress-icon-eye");
    const eyeOff = UI.Buttons.progress.querySelector(".toggle-progress-icon-eye-off");
    if (label)  label.textContent = nowVisible ? "Hide Progress" : "Show Progress";
    if (eyeOn)  eyeOn.hidden      = !nowVisible;
    if (eyeOff) eyeOff.hidden     = nowVisible;
    UI.Buttons.progress.setAttribute("aria-pressed", String(nowVisible));
    // Persist the user's visibility preference
    // wrap in try/catch for Private Browsing / QuotaExceededError.
    try { localStorage.setItem("touchAssayProgressVisible", String(nowVisible)); } catch { /* storage unavailable */ }
  });

  // ── Genotype selection change — update tap button label ─────────────────
  UI.Inputs.genotypeSelect.addEventListener("change", e => {
    if (currentState === STATES.CONFIGURED || currentState === STATES.POISED) {
      const selected    = e.target.value;
      // activeTrial can be null; use optional chaining to prevent crash.
      const activeTrial = getActiveTrial(currentAssay);
      const nextIndex   = (activeTrial?.runs.filter(
        r => r.genotype === selected && r.status === "completed" && r.eligibleForAnalysis
      ).length ?? 0) + 1;

      UI.Displays.tapLabel.textContent = `Start ${selected} (Animal ${nextIndex})`;

      // Reset the double-tap guard when the genotype changes
      pendingStart = false;
      clearTimeout(startTimeout);
    }
  });

  // ── New assay ────────────────────────────────────────────────────
  // replace blocking confirm() with async showConfirmModal.
  UI.Buttons.newAssay.addEventListener("click", async () => {
    if (currentAssay) {
      const completedTrials = (currentAssay.trials || []).filter(t => t.status === "completed");
      if (completedTrials.length > 0) {
        const go = await showConfirmModal(
          "Start a new assay?",
          "You have unsaved data. Export your results before starting a new assay, or they may be difficult to find later.",
          "Start New Assay"
        );
        if (!go) return;
      }
    }
    resetToSetup();
  });

  // ── Start new trial (from export screen) ───────────────────────────────
  UI.Buttons.backToAssay.addEventListener("click", async () => {
    // guard against currentAssay being null — rapid navigation or state
    // corruption could leave it null, causing .assayId to throw TypeError.
    if (!currentAssay) return;
    // Re-hydrate from IDB so trialIndex is always correct, even if the user has
    // looped through export → backToAssay multiple times, and to pick up any
    // run records written since the last hydrateAssay() call.
    currentAssay = await hydrateAssay(currentAssay.assayId);
    const trial = createTrial(currentAssay.trials.length + 1);
    currentAssay.trials.push(trial);
    await saveTrial(currentAssay.assayId, trial);  // await: run start must not race DB write
    populateGenotypeSelect(currentAssay.genotypes);
    updateProgressTable();
    // POISED (not CONFIGURED): this assay already exists; Finish Trial must be
    // immediately available in case the experimenter only needs one run.
    setState(STATES.POISED);
  });


  // ── Header home (logo / title) → back to setup ─────────────────────────
  UI.Buttons.headerHome.addEventListener("click", () => {
    // Do not navigate away while a run is actively recording data
    if (currentState === STATES.RUNNING) return;
    resetToSetup();
  });

  // ── Overlay navigation ──────────────────────────────────────────────────
  UI.Buttons.openSettings.addEventListener("click",   () => showScreen(UI.Screens.settings));
  UI.Buttons.closeSettings.addEventListener("click",  () => hideScreenAndRestore(UI.Screens.settings));
  UI.Buttons.openGuidelines.addEventListener("click", () => showScreen(UI.Screens.guidelines));
  UI.Buttons.closeGuidelines.addEventListener("click",() => hideScreenAndRestore(UI.Screens.guidelines));

  // Assay Defaults sub-page navigation (within settings overlay)
  document.getElementById("openAssayDefaults").addEventListener("click", () => {
    // Mirror showScreen() fully: collapse the overflow menu, reset aria-expanded,
    // and add state-overlay so CSS dimming is consistent with other overlays.
    // Previously state-overlay was only set when Settings was first opened via
    // showScreen() — navigating into Assay Defaults from Settings didn't change
    // it, which is fine in practice (it was already set), but for correctness we
    // explicitly add it here so the sub-page works even if entered independently.
    UI.Displays.overflowMenu.hidden = true;
    UI.Buttons.overflowMenu.setAttribute("aria-expanded", "false");
    document.body.classList.add("state-overlay");
    UI.Screens.settings.hidden      = true;
    UI.Screens.assayDefaults.hidden = false;
  });
  document.getElementById("closeAssayDefaults").addEventListener("click", () => {
    // Mirror hideScreenAndRestore(): collapse overflow menu and keep state-overlay
    // set (Settings is still open underneath), but don't remove it — Settings
    // will remove it when it is itself closed via closeSettings.
    UI.Displays.overflowMenu.hidden = true;
    UI.Buttons.overflowMenu.setAttribute("aria-expanded", "false");
    document.body.classList.add("state-overlay");  // ensure it's set if navigated to directly
    UI.Screens.assayDefaults.hidden = true;
    UI.Screens.settings.hidden      = false;
  });

  UI.Buttons.openSavedAssays.addEventListener("click", () => {
    showScreen(UI.Screens.savedAssays);
    // propagate async errors — previously the returned Promise was
    // discarded so IDB failures produced a silent empty list with no user feedback.
    populateSavedAssaysList().catch(err => {
      console.error("Failed to load saved assays:", err);
      showToast("Could not load saved assays. Please try again.", "error", 4000);
    });
  });
  UI.Buttons.closeSavedAssays.addEventListener("click", () =>
    hideScreenAndRestore(UI.Screens.savedAssays)
  );

  // ── Full data backup / restore ───────────────────────────────────────────
  // A safety net beyond the analysis Excel/CSV export (which is derived and
  // one-directional) — this captures the raw assay/trial/run records so a
  // browser storage wipe or device change isn't catastrophic, per the
  // README's own "export regularly" warning (there is no server/cloud sync).
  if (UI.Buttons.exportBackup) {
    UI.Buttons.exportBackup.addEventListener("click", async () => {
      const btn = UI.Buttons.exportBackup;
      const original = btn.textContent;
      try {
        btn.disabled = true;
        const data = await exportAllDataAsJSON();
        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: "application/json" });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement("a");
        const now  = new Date();
        const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-` +
                      `${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}` +
                      `${String(now.getMinutes()).padStart(2, "0")}`;
        a.href     = url;
        a.download = `touch-assay-backup_${stamp}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        showToast(
          `Backup exported: ${data.assays.length} assay(s), ${data.trials.length} trial(s), ${data.runs.length} run(s).`,
          "success", 4000
        );
      } catch (err) {
        console.error("Backup export failed:", err);
        showToast("Backup export failed: " + err.message, "error", 6000);
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });
  }

  if (UI.Buttons.importBackup && UI.Inputs.importBackupFile) {
    UI.Buttons.importBackup.addEventListener("click", () => {
      UI.Inputs.importBackupFile.click();
    });

    UI.Inputs.importBackupFile.addEventListener("change", async e => {
      const file = e.target.files?.[0];
      // Reset immediately so selecting the same file again still fires "change".
      e.target.value = "";
      if (!file) return;

      let data;
      try {
        const text = await file.text();
        data = JSON.parse(text);
      } catch (err) {
        showToast("Could not read that file as JSON: " + err.message, "error", 5000);
        return;
      }

      if (!data || !Array.isArray(data.assays) || !Array.isArray(data.trials) || !Array.isArray(data.runs)) {
        showToast("This file doesn't look like a valid Touch Assay Timer backup.", "error", 5000);
        return;
      }

      const confirmed = await showConfirmModal(
        "Import backup?",
        `This file contains ${data.assays.length} assay(s), ${data.trials.length} trial(s), and ` +
        `${data.runs.length} run(s). Importing will add/update matching records on this device — ` +
        `nothing already here will be deleted. Continue?`,
        "Import",
        "primary"
      );
      if (!confirmed) return;

      try {
        const counts = await importAllDataFromJSON(data);
        showToast(
          `Backup imported: ${counts.assays} assay(s), ${counts.trials} trial(s), ${counts.runs} run(s).`,
          "success", 4000
        );
        // Refresh the list if it's currently open so the imported assays appear immediately.
        if (!UI.Screens.savedAssays.hidden) {
          populateSavedAssaysList().catch(err => console.error("Failed to refresh saved assays list:", err));
        }
      } catch (err) {
        console.error("Backup import failed:", err);
        showToast("Backup import failed: " + err.message, "error", 6000);
      }
    });
  }

  // ── Overflow menu toggle ────────────────────────────────────────────────
  UI.Buttons.overflowMenu.addEventListener("click", e => {
    e.stopPropagation();  // Prevent the document click handler from immediately closing it
    const willBeOpen = UI.Displays.overflowMenu.hidden;  // true = it is currently closed → we are opening it
    UI.Displays.overflowMenu.hidden = !willBeOpen;
    // keep aria-expanded in sync so screen readers announce the correct
    // open/closed state. Previously the attribute was hard-coded to "false" in HTML
    // and never updated, so assistive technologies always reported the menu as collapsed.
    UI.Buttons.overflowMenu.setAttribute("aria-expanded", String(willBeOpen));
  });

  // Close the overflow menu when clicking anywhere outside it
  document.addEventListener("click", e => {
    if (!UI.Displays.overflowMenu.hidden && !UI.Displays.overflowMenu.contains(e.target)) {
      UI.Displays.overflowMenu.hidden = true;
      // also reset aria-expanded when closed via outside click.
      UI.Buttons.overflowMenu.setAttribute("aria-expanded", "false");
    }
  });

  // ── Genotype picker: trigger toggle + outside click + arrow-key cycling ──
  UI.Inputs.genotypeTrigger.addEventListener("click", e => {
    e.stopPropagation();  // matches the overflow-menu pattern above
    if (UI.Inputs.genotypeOverlay.hidden) openGenotypeOverlay();
    else closeGenotypeOverlay();
  });

  document.addEventListener("click", e => {
    if (!UI.Inputs.genotypeOverlay.hidden && !UI.Inputs.genotypeListbox.contains(e.target)
        && e.target !== UI.Inputs.genotypeTrigger) {
      closeGenotypeOverlay();
    }
  });

  // Reposition (or switch dropdown<->sheet mode) if the viewport crosses the
  // wide/narrow breakpoint while the app is open — e.g. a tablet rotation —
  // and re-render so pills<->trigger mode stays correct for the new width.
  GENOTYPE_WIDE_MQ.addEventListener("change", () => {
    if (currentAssay) renderGenotypePicker(currentAssay.genotypes);
  });
  window.addEventListener("resize", () => {
    if (!UI.Inputs.genotypeOverlay.hidden && GENOTYPE_WIDE_MQ.matches) positionGenotypePanel();
  });

  // Arrow-key cycling: mirrors the native <select>'s behavior of changing
  // value on Up/Down while focused and closed, without opening any popup.
  // This is the keyboard path for changing genotype on the assay screen,
  // since Space/Enter are reserved for the tap action there (see the
  // onAssayScreen block in the keydown handler below) and can't be used to
  // open the trigger/activate a pill from the keyboard.
  UI.Inputs.genotypePicker.addEventListener("keydown", e => {
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
    if (!currentAssay || !currentAssay.genotypes.length) return;
    e.preventDefault();

    const genotypes = currentAssay.genotypes;
    const current    = UI.Inputs.genotypeSelect.value;
    const currentIdx = genotypes.indexOf(current);
    const dir        = (e.key === "ArrowUp" || e.key === "ArrowLeft") ? -1 : 1;
    const nextIdx    = currentIdx === -1
      ? 0
      : (currentIdx + dir + genotypes.length) % genotypes.length;

    selectGenotype(genotypes[nextIdx]);

    // Keep focus on the pill that now represents the new selection, if pills
    // are the active mode, so repeated arrow presses keep cycling in place.
    const nextPill = UI.Inputs.genotypePills.children[nextIdx];
    if (nextPill) nextPill.focus();
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
        // update the in-memory trial object to match what was
        // just written to IDB. Without this, getActiveTrial() would still
        // find this trial (status is "active" in memory), causing the new
        // trial created below to be shadowed.
        active.status          = "abandoned";
        active.abandonedReason = "Started new trial from saved assays";
        active.endedAt         = Date.now();
      }

      const newTrial = createTrial(currentAssay.trials.length + 1);
      currentAssay.trials.push(newTrial);
      await saveTrial(currentAssay.assayId, newTrial);

      // Initialize progress table for the new trial and apply visibility preference
      updateProgressTable();
      applyProgressVisibilityPreference();

      hideScreenAndRestore(UI.Screens.savedAssays);
      setState(STATES.POISED);

    } else if (action === "export") {
      currentAssay = await hydrateAssay(assayId);
      // render the trial summary card so the export screen shows
      // trial details, matching the pattern used in the complete-trial path (~L2085).
      renderTrialSummaryCard(currentAssay);
      hideScreenAndRestore(UI.Screens.savedAssays);
      populateExportDatasetList(currentAssay);
      setState(STATES.EXPORT);

    } else if (action === "delete") {
      const name = btn.dataset.assayName || "this assay";
      // replace blocking confirm() with styled async modal.
      const confirmed = await showConfirmModal(
        `Delete "${name}"?`,
        "This cannot be undone. The assay and all its trial data will be permanently removed.",
        "Delete"
      );
      if (confirmed) {
        try {
          await deleteAssay(assayId);
          await populateSavedAssaysList();
          showToast(`"${name}" deleted.`, "success", 3000);
        } catch (err) {
          console.error("Delete failed:", err);
          showToast(`Failed to delete "${name}". Please try again.`, "error");
        }
      }
    }  // end action routing
  });

  // ── Saved assays bulk selection ─────────────────────────────────────────
  UI.Displays.savedAssaysList.addEventListener("change", e => {
    if (!e.target.classList.contains("assay-select-checkbox")) return;

    const all     = document.querySelectorAll(".assay-select-checkbox");
    const checked = document.querySelectorAll(".assay-select-checkbox:checked");

    UI.Buttons.deleteSelectedAssays.disabled  = checked.length === 0;
    UI.Inputs.selectAllAssays.checked         = checked.length === all.length && all.length > 0;
    // set indeterminate when some (but not all) checkboxes are checked.
    // Previously indeterminate was never set here, so the master checkbox only
    // showed checked/unchecked, losing the "partial selection" affordance.
    // Compare with syncExportSelectAll() which handles this correctly for exports.
    UI.Inputs.selectAllAssays.indeterminate   = checked.length > 0 && checked.length < all.length;
  });

  UI.Inputs.selectAllAssays.addEventListener("change", e => {
    const isChecked = e.target.checked;
    document.querySelectorAll(".assay-select-checkbox").forEach(cb => {
      cb.checked = isChecked;
    });
    const all = document.querySelectorAll(".assay-select-checkbox");
    UI.Buttons.deleteSelectedAssays.disabled = !isChecked || all.length === 0;
  });

  // Inline confirmation for bulk delete — replaces the browser confirm() dialog
  UI.Buttons.deleteSelectedAssays.addEventListener("click", () => {
    const checked = document.querySelectorAll(".assay-select-checkbox:checked");
    if (checked.length === 0) return;

    // If a confirmation bar is already showing, do nothing (user must respond to it)
    if (document.querySelector(".bulk-delete-confirm")) return;

    const bulkBar = document.querySelector(".bulk-actions");
    const confirmRow = document.createElement("div");
    confirmRow.className = "bulk-delete-confirm";
    confirmRow.innerHTML =
      `<span>Permanently delete <strong>${checked.length}</strong> assay${checked.length !== 1 ? "s" : ""}?</span>` +
      `<button type="button" class="confirm-yes">Yes, delete</button>` +
      `<button type="button" class="confirm-cancel">Cancel</button>`;

    bulkBar.after(confirmRow);

    confirmRow.querySelector(".confirm-cancel").addEventListener("click", () => {
      confirmRow.remove();
    });

    confirmRow.querySelector(".confirm-yes").addEventListener("click", async () => {
      confirmRow.remove();

      const idsToDelete = Array.from(checked).map(cb => cb.dataset.assayId);
      UI.Buttons.deleteSelectedAssays.textContent = "Deleting...";
      UI.Buttons.deleteSelectedAssays.disabled    = true;
      let failCount = 0;

      try {
        for (const id of idsToDelete) {
          try {
            await deleteAssay(id);
          } catch (err) {
            console.error(`Failed to delete assay ${id}:`, err);
            failCount++;
          }
        }

        if (failCount > 0) {
          showToast(`${failCount} assay(s) could not be deleted. The rest were removed.`, "error", 5000);
          // previously both branches ran when failCount > 0 because there
          // was no `else` — users saw a success toast and an error toast simultaneously.
        } else {
          showToast(`${idsToDelete.length} assay${idsToDelete.length !== 1 ? "s" : ""} deleted.`, "success", 3000);
        }

        await populateSavedAssaysList();
      } finally {
        UI.Buttons.deleteSelectedAssays.textContent = "Delete Selected";
      }
    });
  });

  // ── Settings ────────────────────────────────────────────────────────────
  UI.Settings.warmupToggle.addEventListener("change", e => {
    isWarmupEnabled = e.target.checked;
    // wrap in try/catch for Private Browsing / QuotaExceededError.
    try { localStorage.setItem("touchAssayWarmupEnabled", isWarmupEnabled); } catch { /* storage unavailable */ }
    UI.Settings.warmupDurationContainer.style.display = isWarmupEnabled ? "flex" : "none";
  });

  // Split into two handlers so clamping only snaps the displayed value on
  // blur/commit (change), not on every keystroke (input). A single handler on
  // "input" that clamped and wrote back on every keypress caused visible jank:
  // typing "10" would clamp keystroke "1" to the range and snap the field back
  // to "1" before the second keystroke could complete the intended value.

  /**
   * Updates the in-memory warmupDuration on every keystroke, without writing
   * back into the field — see the split-handler rationale above.
   * @param {Event} e - The input event on the warmup duration field.
   */
  function _applyWarmupDurationOnInput(e) {
    const parsed = parseInt(e.target.value, 10);
    if (isNaN(parsed)) return;  // Let the field stay mid-edit (e.g. user cleared it)
    // Only update the in-memory variable; do not snap the field mid-keystroke.
    warmupDuration = Math.min(60, Math.max(1, parsed));
  }

  /**
   * Clamps, writes back, and persists the warmup duration on blur/Enter/spinner
   * commit — see the split-handler rationale above.
   * @param {Event} e - The change event on the warmup duration field.
   */
  function _applyWarmupDurationOnChange(e) {
    const parsed = parseInt(e.target.value, 10);
    if (isNaN(parsed)) {
      // Restore last valid value if the field is left blank.
      UI.Settings.warmupDurationInput.value = warmupDuration;
      return;
    }
    warmupDuration = Math.min(60, Math.max(1, parsed));
    UI.Settings.warmupDurationInput.value = warmupDuration;  // Reflect clamped value back
    // wrap in try/catch for Private Browsing / QuotaExceededError.
    try { localStorage.setItem("touchAssayWarmupDuration", warmupDuration); } catch { /* storage unavailable */ }
  }

  UI.Settings.warmupDurationInput.addEventListener("input",  _applyWarmupDurationOnInput);
  UI.Settings.warmupDurationInput.addEventListener("change", _applyWarmupDurationOnChange);

  document.querySelectorAll('input[name="themeMode"]').forEach(input => {
    input.addEventListener("change", e => {
      if (!e.target.checked) return;
      const theme = e.target.value;
      document.documentElement.setAttribute("data-theme", theme);
      // Keep the Android status bar / browser chrome color in sync
      document.querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", theme === "dark" ? "#0f172a" : "#f1f5f9");
      // wrap in try/catch for Private Browsing / QuotaExceededError.
      try { localStorage.setItem("touchAssayTheme", theme); } catch { /* storage unavailable */ }
    });
  });

  document.querySelectorAll('input[name="voiceMode"]').forEach(input => {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      stopSpeech();
      setVoiceMode(input.value);
      // wrap in try/catch for Private Browsing / QuotaExceededError.
      try { localStorage.setItem("touchAssayVoiceMode", input.value); } catch { /* storage unavailable */ }
    });
  });

  // ── Settings: audio controls ──────────────────────────────────────

  /**
   * Plays a preview tick to help the user audition the current setting.
   * Ensures the AudioContext is warmed up before playing.
   * A debounce timer ID is returned so callers can cancel pending previews.
   * @param {number|undefined} timerId - Previous debounce timer to cancel.
   * @param {number}           delay   - Debounce delay in ms.
   * @returns {number} New debounce timer ID.
   */
  function _previewTick(timerId, delay = 0) {
    clearTimeout(timerId);
    return setTimeout(() => {
      warmUpAudio()
        .then(() => playTick(null))
        .catch(() => { /* AudioContext blocked — silently skip preview */ });
    }, delay);
  }

  /**
   * Triggers the .pop CSS animation on a badge element to give tactile
   * feedback whenever its value changes while the user drags a slider.
   * @param {HTMLElement|null} el - The badge element to animate.
   */
  function _popBadge(el) {
    if (!el) return;
    el.classList.remove("pop");
    // cancel running Web Animations instead of forcing a layout
    // reflow via offsetWidth — avoids forced style recalculation on every
    // slider tick during rapid dragging.
    el.getAnimations().forEach(a => a.cancel());
    el.classList.add("pop");
  }

  /**
   * Debounce timer ID for the pitch-preview tick.
   * @type {number|undefined}
   */
  let _pitchPreviewTimer;

  if (UI.Settings.tickPitch) {
    // Slider → badge input
    UI.Settings.tickPitch.addEventListener("input", e => {
      const hz = parseInt(e.target.value, 10);
      setTickPitch(hz);
      try { localStorage.setItem("touchAssayTickPitch", hz); } catch { /* storage unavailable */ }
      if (UI.Settings.tickPitchDisplay) {
        UI.Settings.tickPitchDisplay.value = hz;
        _popBadge(UI.Settings.tickPitchDisplay);
      }
      _pitchPreviewTimer = _previewTick(_pitchPreviewTimer, 120);
    });
    // Badge input → slider
    if (UI.Settings.tickPitchDisplay) {
      const _syncTickPitchFromInput = () => {
        let v = parseInt(UI.Settings.tickPitchDisplay.value, 10);
        if (isNaN(v)) return;
        v = Math.max(200, Math.min(2000, Math.round(v / 50) * 50));  // snap to step
        UI.Settings.tickPitchDisplay.value = v;
        UI.Settings.tickPitch.value        = v;
        setTickPitch(v);
        try { localStorage.setItem("touchAssayTickPitch", v); } catch { /* storage unavailable */ }
        _pitchPreviewTimer = _previewTick(_pitchPreviewTimer, 300);
      };
      UI.Settings.tickPitchDisplay.addEventListener("change", _syncTickPitchFromInput);
      UI.Settings.tickPitchDisplay.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); _syncTickPitchFromInput(); } });
    }
  }

  // ── Settings: speech lead time ─────────────────────────────────────────
  if (UI.Settings.speechLead) {
    // Slider → badge input
    UI.Settings.speechLead.addEventListener("input", e => {
      const parsed = parseInt(e.target.value, 10);
      if (isNaN(parsed)) return;
      speechLeadMs = Math.max(0, Math.min(490, parsed));
      try { localStorage.setItem("touchAssaySpeechLeadMs", speechLeadMs); } catch { /* storage unavailable */ }
      if (UI.Settings.speechLeadDisplay) {
        UI.Settings.speechLeadDisplay.value = speechLeadMs;
        _popBadge(UI.Settings.speechLeadDisplay);
      }
      if (currentState === STATES.RUNNING) {
        showToast("Speech lead will apply from the next run.", "info", 3000);
      }
    });
    // Badge input → slider
    if (UI.Settings.speechLeadDisplay) {
      const _syncSpeechLeadFromInput = () => {
        let v = parseInt(UI.Settings.speechLeadDisplay.value, 10);
        if (isNaN(v)) return;
        v = Math.max(0, Math.min(490, Math.round(v / 10) * 10));  // snap to step
        speechLeadMs = v;
        UI.Settings.speechLeadDisplay.value = v;
        UI.Settings.speechLead.value        = v;
        try { localStorage.setItem("touchAssaySpeechLeadMs", v); } catch { /* storage unavailable */ }
        if (currentState === STATES.RUNNING) {
          showToast("Speech lead will apply from the next run.", "info", 3000);
        }
      };
      UI.Settings.speechLeadDisplay.addEventListener("change", _syncSpeechLeadFromInput);
      UI.Settings.speechLeadDisplay.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); _syncSpeechLeadFromInput(); } });
    }
  }

  // ── Settings: grace period ─────────────────────────────────────────────
  if (UI.Settings.gracePeriod) {
    // Slider → badge input
    UI.Settings.gracePeriod.addEventListener("input", e => {
      const parsed = parseInt(e.target.value, 10);
      if (isNaN(parsed)) return;
      gracePeriodMs = Math.max(0, Math.min(400, parsed));
      try { localStorage.setItem("touchAssayGracePeriodMs", gracePeriodMs); } catch { /* storage unavailable */ }
      if (UI.Settings.gracePeriodDisplay) {
        UI.Settings.gracePeriodDisplay.value = gracePeriodMs;
        _popBadge(UI.Settings.gracePeriodDisplay);
      }
      // Re-evaluate the grace×ISI warning on the setup screen whenever the
      // slider moves — gracePeriodMs is now up-to-date so updateGraceIsiWarning()
      // will reflect the correct effective value. This is the single canonical
      // place to trigger the warning; the duplicate listener that previously
      // existed near the ISI input wiring has been removed.
      updateGraceIsiWarning();
    });
    // Badge input → slider
    if (UI.Settings.gracePeriodDisplay) {
      const _syncGracePeriodFromInput = () => {
        let v = parseInt(UI.Settings.gracePeriodDisplay.value, 10);
        if (isNaN(v)) return;
        v = Math.max(0, Math.min(400, Math.round(v / 10) * 10));  // snap to step, max 400 ms
        gracePeriodMs = v;
        UI.Settings.gracePeriodDisplay.value = v;
        UI.Settings.gracePeriod.value        = v;
        try { localStorage.setItem("touchAssayGracePeriodMs", v); } catch { /* storage unavailable */ }
        // Keep the setup screen's grace×ISI warning in sync when the value is
        // typed directly instead of dragged on the slider (which already
        // calls this via its own "input" listener).
        updateGraceIsiWarning();
      };
      UI.Settings.gracePeriodDisplay.addEventListener("change", _syncGracePeriodFromInput);
      UI.Settings.gracePeriodDisplay.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); _syncGracePeriodFromInput(); } });
    }
  }

  // ── Assay Defaults sub-page: stepper buttons and input persistence ──────
  {
    /**
     * Saves a single assay default field value to localStorage.
     * @param {string} field - localStorage key suffix (e.g. "ISI").
     * @param {string} value - String value to store.
     */
    function _saveAssayDefault(field, value) {
      try { localStorage.setItem("touchAssayDefault" + field, value); } catch { /* storage unavailable */ }
    }

    /**
     * Wires a stepper button pair (+/−) for an assay default input.
     * On click: applies delta, clamps to input min/max, updates field, persists.
     * @param {HTMLInputElement} input - The number input.
     * @param {string}           storageField - Key suffix for localStorage.
     */
    function _wireDefaultStepper(input, storageField) {
      if (!input) return;

      // Track the last-valid value in a closure so that if the user types a
      // non-numeric string and blurs, we restore their previous valid value
      // instead of falling back to the HTML defaultValue attribute (which
      // would silently overwrite localStorage with the compile-time default).
      let lastValid = parseFloat(input.value);
      if (isNaN(lastValid)) lastValid = parseFloat(input.defaultValue) || 0;

      /**
       * Clamps a raw value to the input's min/max/step, writes it back to the
       * field, updates `lastValid`, and persists it. Shared by the change
       * handler and both stepper buttons below.
       * @param {number|string} raw - Candidate value before clamping.
       */
      function _applyAndSave(raw) {
        const min = input.min !== "" ? parseFloat(input.min) : -Infinity;
        const max = input.max !== "" ? parseFloat(input.max) :  Infinity;
        const step = parseFloat(input.step) || 1;
        const decimals = (step.toString().split(".")[1] || "").length;
        let val = parseFloat(raw);
        if (isNaN(val)) {
          // Restore previous valid value instead of overwriting with HTML default
          input.value = lastValid;
          return;
        }
        val = Math.max(min, Math.min(max, val));
        val = parseFloat(val.toFixed(decimals));
        input.value = val;
        lastValid = val;
        _saveAssayDefault(storageField, val);
      }

      // Persist on direct keyboard/spinner changes
      input.addEventListener("change", () => _applyAndSave(input.value));

      // Wire stepper buttons via event delegation on the wrapper
      const wrapper = input.closest(".stepper-wrapper");
      if (!wrapper) return;
      wrapper.querySelectorAll(".stepper-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          const delta    = parseFloat(btn.dataset.delta) || 0;
          const step     = parseFloat(input.step) || 1;
          const decimals = (step.toString().split(".")[1] || "").length;
          const current  = isNaN(parseFloat(input.value)) ? lastValid : parseFloat(input.value);
          const raw      = parseFloat((current + delta).toFixed(decimals));
          // Pre-clamp to [min, max] BEFORE setting input.value so that any
          // synchronous "change" listener reading input.value sees the final
          // committed value, not a transient out-of-range intermediate.
          // _applyAndSave (triggered by the change event below) will also clamp
          // and call toFixed, so this is a belt-and-suspenders guard.
          const min     = input.min !== "" ? parseFloat(input.min) : -Infinity;
          const max     = input.max !== "" ? parseFloat(input.max) :  Infinity;
          const clamped = parseFloat(Math.max(min, Math.min(max, raw)).toFixed(decimals));
          // Dispatch a change event so external listeners receive the
          // update through standard DOM event bubbling.
          input.value = clamped;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        });
      });
    }

    _wireDefaultStepper(UI.Settings.defaultISI,         "ISI");
    _wireDefaultStepper(UI.Settings.defaultStimCount,   "StimCount");
    _wireDefaultStepper(UI.Settings.defaultBinSize,     "BinSize");
    _wireDefaultStepper(UI.Settings.defaultTemperature, "Temperature");
    _wireDefaultStepper(UI.Settings.defaultHumidity,    "Humidity");
  }


  // ── Export ──────────────────────────────────────────────────────────────
  /**
   * Wraps an export action with a loading spinner state on the button.
   * Yields to the browser paint cycle before running the (potentially slow)
   * synchronous export to ensure the spinner appears before blocking.
   *
   */
  async function runWithSpinner(btn, label, fn) {
    const original = btn.textContent;
    btn.textContent = label;
    btn.classList.add("btn-loading");
    try {
      await new Promise(r => setTimeout(r, 0));  // yield one frame
      await fn();
    } finally {
      btn.textContent = original;
      btn.classList.remove("btn-loading");
    }
  }

  UI.Buttons.exportExcel.addEventListener("click", () => {
    if (!currentAssay) return;

    const configs = getExportConfigs();
    if (configs.length === 0) {
      showToast("Please select a dataset.", "info", 3000);
      return;
    }

    // If SheetJS isn't loaded (offline / CDN failure), fall back to CSV silently
    if (typeof XLSX === "undefined") {
      runWithSpinner(UI.Buttons.exportExcel, "Exporting…", () => {
        const result = performCSVExport(currentAssay, configs);
        if (!result.success) showToast("Export failed: " + result.error, "error", 6000);
      });
      return;
    }

    runWithSpinner(UI.Buttons.exportExcel, "Exporting…", async () => {
      const result = performExcelExport(currentAssay, configs);
      if (!result.success) {
        // Non-destructive alternative-format offer — "primary" styling (not "danger")
        // since accepting isn't a destructive action, unlike the modal's other call-sites.
        const useCSV = await showConfirmModal(
          "Excel export failed",
          `${result.error} Would you like to export as CSV instead?`,
          "Export CSV",
          "primary"
        );
        if (useCSV) performCSVExport(currentAssay, configs);
      }
    });
  });

  // Dedicated CSV export button
  if (UI.Buttons.exportCSV) {
    UI.Buttons.exportCSV.addEventListener("click", () => {
      if (!currentAssay) return;
      const configs = getExportConfigs();
      if (configs.length === 0) {
        showToast("Please select a dataset.", "info", 3000);
        return;
      }
      runWithSpinner(UI.Buttons.exportCSV, "Exporting…", () => {
        const result = performCSVExport(currentAssay, configs);
        if (!result.success) showToast("CSV export failed: " + result.error, "error", 6000);
      });
    });
  }

  UI.Buttons.previewExcel.addEventListener("click", () => {
    if (!currentAssay) return;

    const configs = getExportConfigs();
    if (configs.length === 0) {
      showToast("Please select a dataset to preview.", "info", 3000);
      return;
    }

    runWithSpinner(UI.Buttons.previewExcel, "Loading…", () => {
      UI.Displays.previewContainer.innerHTML = generatePreviewHTML(currentAssay, configs);
      UI.Displays.previewModal.hidden        = false;
    });
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

  // ── Export dataset list — checkbox delegation ────────────────────────────
  // Refresh button state and keep the select-all checkbox in sync whenever
  // any individual dataset checkbox changes.
  document.getElementById("exportDatasetList").addEventListener("change", () => {
    refreshExportButtonState();
    syncExportSelectAll();
  });

  // Select-all master toggle: check/uncheck all dataset checkboxes
  if (UI.Inputs.exportSelectAll) {
    UI.Inputs.exportSelectAll.addEventListener("change", e => {
      document.querySelectorAll("#exportDatasetList input[type='checkbox']")
        .forEach(cb => { cb.checked = e.target.checked; });
      refreshExportButtonState();
    });
  }

  // ── SheetJS availability detection ────────────────────────────────

  /**
   * Relabels the export buttons to reflect whether SheetJS (XLSX) loaded.
   * The SheetJS script loads with `defer`, so this is checked after the window
   * has fully loaded. If it failed to load (e.g. offline), buttons are relabeled
   * to "Export to CSV" so users are not surprised by the fallback format.
   */
  function updateExportButtonLabels() {
    const isExcel = typeof XLSX !== "undefined";
    if (!isExcel) {
      const csvLabel = "Export to CSV";
      const csvTitle = "SheetJS could not be loaded — data will export as CSV";
      [UI.Buttons.exportExcel, UI.Buttons.exportFromPreview].forEach(btn => {
        if (btn) { btn.textContent = csvLabel; btn.title = csvTitle; }
      });
    }
  }

  // Check once SheetJS has loaded (or failed) and again at window load as fallback
  const xlsxScript = document.querySelector("script[src*=\"xlsx\"]");
  if (xlsxScript) {
    xlsxScript.addEventListener("load",  updateExportButtonLabels);
    xlsxScript.addEventListener("error", updateExportButtonLabels);
  }
  window.addEventListener("load", updateExportButtonLabels);



});  // end DOMContentLoaded
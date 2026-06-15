/**
 * @file audio.js
 * @module AudioController
 * @description Manages all audio output for the assay timer.
 *
 * Responsibilities:
 *   - Web Audio API: precise hardware-scheduled metronome ticks and tones.
 *   - Web Speech API: optional voice countdown per stimulus.
 *   - Completion feedback: ascending two-tone chime at run end.
 *
 * Architecture note — the scheduler uses a two-layer approach:
 *   Layer 1 (hardware): scheduleWebAudioTick() pre-schedules beeps slightly
 *     in the future using the AudioContext clock, achieving sub-millisecond
 *     timing accuracy regardless of the JS thread being busy.
 *   Layer 2 (voice/UI): triggerImmediateSpeech() fires at the exact moment
 *     the stimulus window opens so speech aligns with the visual display.
 */


/* ==========================================================================
   Module-level State
   ========================================================================== */

/** @type {AudioContext|null} Shared audio context — created once on first use. */
let audioCtx = null;

/** @type {GainNode|null} Master gain node — all oscillators route through this. */
let masterGain = null;

/** @type {SpeechSynthesisVoice|null} The selected TTS voice, or null if unavailable. */
let selectedVoice = null;

/** @type {number} Current output volume, 0.0–1.0. */
let volume = 1.0;

/**
 * Controls which audio cues are emitted per stimulus.
 * "tick"  — play a short beep every stimulus.
 * "count" — speak the stimulus number aloud every stimulus.
 * "tens"  — speak only on multiples of 10; tick otherwise.
 * @type {"tick"|"count"|"tens"}
 */
let voiceMode = "tick";

/** @type {{ rate: number, pitch: number, lang: string }} TTS configuration. */
let speechConfig = { rate: 1.0, pitch: 1.0, lang: "en" };

/** @type {boolean} True once the AudioContext has been resumed after a user gesture. */
let isReady = false;


/* ==========================================================================
   Public Getters & Setters
   ========================================================================== */

/** @returns {boolean} Whether the audio context is running and ready for scheduling. */
export const isAudioReady = () => isReady;

/**
 * Sets the master output volume.
 * Clamped to [0, 1] to prevent distortion.
 * @param {number} level - Target volume, 0.0 (silent) to 1.0 (full).
 */
export function setVolume(level) {
  volume = Math.max(0, Math.min(1, level));
  if (masterGain) masterGain.gain.value = volume;
}

/**
 * Changes the active voice/cue mode.
 * @param {"tick"|"count"|"tens"} mode - The desired cue mode.
 */
export function setVoiceMode(mode) {
  voiceMode = mode;
}

/**
 * Merges new speech settings and refreshes the selected voice.
 * @param {{ rate?: number, pitch?: number, lang?: string }} config - Partial config to merge.
 */
export function configureSpeech(config) {
  speechConfig = { ...speechConfig, ...config };
  loadVoices();
}


/* ==========================================================================
   Voice Initialisation
   ========================================================================== */

/**
 * Selects the best available TTS voice for the configured language.
 * Prefers Google voices for higher quality; falls back to any matching
 * language, then to the first available voice on the system.
 *
 * Called on init and again when the browser's voice list changes
 * (which can happen asynchronously on some browsers).
 */
export function loadVoices() {
  const voices = speechSynthesis.getVoices();
  if (voices.length === 0) return;  // List not ready yet; will retry via onvoiceschanged

  selectedVoice =
    voices.find(v => v.lang.startsWith(speechConfig.lang) && v.name.includes("Google")) ||
    voices.find(v => v.lang.startsWith(speechConfig.lang)) ||
    voices[0] ||
    null;
}

// Browsers load voices asynchronously; listen for when the list is populated
speechSynthesis.onvoiceschanged = loadVoices;

// Synchronously attempt to load if the list is already available (common on desktop)
if (speechSynthesis.getVoices().length > 0) loadVoices();


/* ==========================================================================
   Web Audio Context
   ========================================================================== */

/**
 * Lazily creates and returns the shared AudioContext.
 * Must be called from a user gesture context on first use (or after warmUpAudio).
 *
 * @returns {AudioContext} The shared audio context.
 */
function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    // Route all oscillators through a single master gain node so volume
    // changes apply globally without touching individual oscillators.
    masterGain = audioCtx.createGain();
    masterGain.connect(audioCtx.destination);
    masterGain.gain.value = volume;
  }
  return audioCtx;
}

/**
 * Resumes the AudioContext after a user gesture.
 * Browsers suspend the context by default until user interaction.
 * Should be called on the first tap/keypress.
 */
export function warmUpAudio() {
  if (isReady) return;  // Already running — no-op
  const ctx = getAudioContext();
  ctx.resume()
    .then(() => { isReady = true; })
    .catch(err => console.warn("Audio context resume blocked by browser policy.", err));
}

/**
 * Returns the current hardware clock time from the AudioContext.
 * This is used as the reference for all scheduled audio events and
 * for recording tap timestamps in sync with audio.
 *
 * @returns {number} Current AudioContext time in seconds.
 */
export function getAudioTime() {
  return getAudioContext().currentTime;
}

// When the app returns to the foreground after backgrounding, the
// AudioContext may have been suspended. Resume it automatically.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume().catch(err =>
      console.warn("Could not resume audio context on visibility restore.", err)
    );
  }
});


/* ==========================================================================
   Speech Synthesis
   ========================================================================== */

/**
 * Speaks the given text immediately, cancelling any in-flight utterance first.
 *
 * Cancelling before speaking is intentional: if the scheduler fires before
 * the previous utterance has finished (e.g. short ISI), the old speech would
 * queue and drift out of sync with the visual display. Cancelling forces
 * immediate delivery of the new cue.
 *
 * @param {string} text - The text to speak.
 */
export function speak(text) {
  // Lazy-init guard: on Chrome, voiceschanged fires asynchronously after page load.
  // If speak() is called before the event fires, selectedVoice is still null.
  // Attempt to populate it now — this succeeds once the browser's voice list is ready.
  if (!selectedVoice) loadVoices();

  speechSynthesis.cancel();  // Flush any queued utterances to prevent lag drift

  const utterance = new SpeechSynthesisUtterance(text);
  if (selectedVoice)         utterance.voice = selectedVoice;
  utterance.rate  = speechConfig.rate;
  utterance.pitch = speechConfig.pitch;

  speechSynthesis.speak(utterance);
}

/**
 * Stops any speech that is currently being spoken or queued.
 */
export function stopSpeech() {
  speechSynthesis.cancel();
}


/* ==========================================================================
   Tone Generators
   ========================================================================== */

/**
 * Schedules a short, sharp metronome tick at a precise hardware time.
 *
 * Uses a sine oscillator with a fast exponential decay (attack-less) to
 * produce a clean click-like sound. The oscillator node is self-disposing
 * once stopped.
 *
 * @param {number|null} exactTime - AudioContext time to play the tick.
 *   If null, plays immediately at ctx.currentTime.
 */
export function playTick(exactTime = null) {
  const ctx  = getAudioContext();
  const osc  = ctx.createOscillator();
  const gain = ctx.createGain();
  const time = exactTime !== null ? exactTime : ctx.currentTime;

  osc.type            = "sine";
  osc.frequency.value = 900;  // Hz — clear and distinct from ambient noise

  gain.gain.setValueAtTime(0.25, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);  // 50ms decay

  osc.connect(gain);
  gain.connect(masterGain);

  osc.start(time);
  osc.stop(time + 0.05);  // Node auto-disconnects after stopping
}

/**
 * Schedules a warmup countdown tone at a precise hardware time.
 * Uses a higher amplitude and longer sustain than the regular tick to
 * be clearly distinguishable during the pre-run countdown.
 *
 * @param {number}      frequency - Tone frequency in Hz.
 * @param {number|null} exactTime - AudioContext time to play the tone.
 */
export function playWarmupTone(frequency, exactTime = null) {
  const ctx  = getAudioContext();
  const osc  = ctx.createOscillator();
  const gain = ctx.createGain();
  const time = exactTime !== null ? exactTime : ctx.currentTime;

  osc.type            = "sine";
  osc.frequency.value = frequency;

  gain.gain.setValueAtTime(0.2, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.3);  // 300ms sustain

  osc.connect(gain);
  gain.connect(masterGain);

  osc.start(time);
  osc.stop(time + 0.3);
}

/**
 * Plays a two-tone ascending chime to signal that a run has completed.
 *
 * The two notes are staggered by 150ms to create an ascending "ding-dong"
 * effect that is easily distinguishable from both the metronome tick and
 * the warmup beep, even in a noisy lab environment.
 */
export function playCompletionTone() {
  const ctx  = getAudioContext();
  const time = ctx.currentTime;

  // Schedule both notes relative to the current time
  [800, 1200].forEach((freq, i) => {
    const osc     = ctx.createOscillator();
    const gain    = ctx.createGain();
    const startAt = time + i * 0.15;  // 0ms and 150ms offsets

    osc.type            = "sine";
    osc.frequency.value = freq;

    gain.gain.setValueAtTime(0.3, startAt);
    gain.gain.exponentialRampToValueAtTime(0.001, startAt + 0.3);

    osc.connect(gain);
    gain.connect(masterGain);

    osc.start(startAt);
    osc.stop(startAt + 0.3);
  });
}


/* ==========================================================================
   Decoupled Metronome Controllers
   ========================================================================== */

/**
 * Layer 1 — Hardware Audio Scheduler.
 *
 * Called slightly ahead of the actual stimulus time (lookahead scheduling).
 * Schedules the beep precisely on the AudioContext hardware clock, which is
 * immune to main-thread jank and timer throttling.
 *
 * In "count" mode with a fast ISI (< 1s) the tick is always played because
 * speech would not have time to complete before the next stimulus.
 *
 * @param {number} stimulusIndex - 1-based stimulus number being scheduled.
 * @param {number} assayIsi      - ISI of the active assay in seconds.
 * @param {number} exactTime     - AudioContext timestamp to schedule the beep.
 */
export function scheduleWebAudioTick(stimulusIndex, assayIsi, exactTime) {
  // Fast ISI override: always tick even in count mode (speech can't keep up)
  if (voiceMode === "count" && assayIsi < 1) {
    playTick(exactTime);
    return;
  }

  switch (voiceMode) {
    case "tick":
      // Tick on every stimulus
      playTick(exactTime);
      break;

    case "tens":
      // Tick on all stimuli that are NOT multiples of 10
      // (multiples will have speech instead, scheduled in triggerImmediateSpeech)
      if (stimulusIndex % 10 !== 0) playTick(exactTime);
      break;

    // "count" mode: no tick — speech fires in triggerImmediateSpeech
  }
}

/**
 * Layer 2 — Immediate Speech / Voice Trigger.
 *
 * Called at the exact moment a new stimulus window opens (not pre-scheduled).
 * Speech is triggered synchronously with the UI update so both the visual
 * counter and the spoken number appear at the same instant.
 *
 * @param {number} stimulusIndex - 1-based stimulus number to announce.
 * @param {number} assayIsi      - ISI of the active assay in seconds.
 */
export function triggerImmediateSpeech(stimulusIndex, assayIsi) {
  // Fast ISI: speech can't complete before the next tick — handled by tick only
  if (voiceMode === "count" && assayIsi < 1) return;

  switch (voiceMode) {
    case "count":
      // Speak the stimulus number on every interval
      speak(String(stimulusIndex));
      break;

    case "tens":
      // Speak only on multiples of 10 (all others get a tick from scheduleWebAudioTick)
      if (stimulusIndex % 10 === 0) speak(String(stimulusIndex));
      break;

    // "tick" mode: no speech — tick only, handled in scheduleWebAudioTick
  }
}
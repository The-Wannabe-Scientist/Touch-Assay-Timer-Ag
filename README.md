# Touch Assay Timer

> **A precision stimulus–response assay timer for *C. elegans* touch sensitivity experiments.**

A fully offline-capable Progressive Web App (PWA) for recording touch assay data with sub-millisecond timing accuracy. Designed for neuroscience labs running mechanosensory habituation assays — works on any modern browser, installs to your home screen, and requires no internet connection after the first load.

Adapted by [Ag](https://github.com/The-Wannabe-Scientist) from [touch-assay-timer](https://github.com/dv-welp/touch-assay-timer) by [DV](https://github.com/dv-welp/).

🌐 **Live app:** [https://the-wannabe-scientist.github.io/Touch-Assay-Timer-Ag/](https://the-wannabe-scientist.github.io/Touch-Assay-Timer-Ag/)

---

## Table of Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [How to Use](#how-to-use)
  - [1. Assay Setup](#1-assay-setup)
  - [2. Running Trials](#2-running-trials)
  - [3. Recording Responses](#3-recording-responses)
  - [4. Exporting Data](#4-exporting-data)
- [Data Model](#data-model)
- [Audio Cues](#audio-cues)
- [Settings](#settings)
- [Offline & PWA Installation](#offline--pwa-installation)
- [Data Storage & Privacy](#data-storage--privacy)
- [Project Structure](#project-structure)
- [Browser Compatibility](#browser-compatibility)
- [License](#license)

---

## Features

| Feature | Details |
|---|---|
| 🧪 **Multi-genotype support** | Record multiple genotypes in a single assay; label them freely |
| ⏱️ **Hardware-scheduled timing** | Web Audio API pre-schedules ticks with sub-millisecond precision |
| 🔊 **Configurable audio cues** | Metronome ticks or spoken countdown; adjustable pitch and speech lead time |
| 📊 **Automated analysis** | Binned % response, Touch Index, Mean / SEM / N — computed on export |
| 📁 **Excel & CSV export** | Full per-trial and pooled sheets via SheetJS; zero-dependency CSV fallback |
| 💾 **Persistent local storage** | IndexedDB keeps all assays across sessions — no account required |
| 📴 **Fully offline** | Service worker caches all assets; works in aeroplane mode after first visit |
| 📱 **Installable PWA** | Installs to iOS / Android / desktop home screen; runs in standalone mode |
| 🌙 **Light / Dark theme** | System-aware default with manual override; preference persists |
| ♿ **Accessible** | Keyboard-navigable; ARIA live regions announce stimulus cues |
| ⌚ **Haptic Armband** | Direct BLE integration for zero-latency haptic mirroring and battery monitoring |

---

## Quick Start

The app is a **static web app** — no build step, no server, no dependencies to install.

### Option A — Use the hosted app

Just open the link in any modern browser — no installation required:

👉 **[https://the-wannabe-scientist.github.io/Touch-Assay-Timer-Ag/](https://the-wannabe-scientist.github.io/Touch-Assay-Timer-Ag/)**

### Option B — Run locally

```bash
# Clone the repo
git clone https://github.com/The-Wannabe-Scientist/Touch-Assay-Timer-Ag.git
cd Touch-Assay-Timer-Ag

# Serve with any static server (required for the Service Worker to register)
npx serve .
# or
python3 -m http.server 8080
```

Then open `http://localhost:8080` in your browser.

> **Why a server?** Service Workers (and therefore offline caching) require an `https://` or `http://localhost` origin. Opening `index.html` directly via `file://` will disable the PWA features.

### Option C — Deploy to any static host

Upload all files to GitHub Pages, Netlify, Vercel, or any static host. The app is fully self-contained.

---

## How to Use

### 1. Assay Setup

Fill in the **Assay Setup** form before beginning:

| Field | Description |
|---|---|
| **Experiment ID** | A name for this assay (saved with your data) |
| **Genotypes** | Type a genotype label and press **Enter** or **,** to add it as a chip. Add as many as needed. |
| **Temperature (°C)** | Ambient temperature; logged with the assay |
| **Humidity (% RH)** | Relative humidity; logged with the assay |
| **Inter-stimulus Interval (s)** | Time between stimuli (e.g. `1.0` for 1-second ISI) |
| **Total Number of Stimulations** | How many stimuli to deliver per animal (e.g. `100`) |
| **Bin Size** | Number of stimuli grouped into each analysis bin (e.g. `10`) |

Click **Begin Assay** to proceed.

### 2. Running Trials

On the **Assay Screen**:

1. Select the **genotype** from the dropdown for the current animal.
2. Tap **Start Timer** (or press **Space**) to begin the 3-second countdown warm-up.
3. The timer starts automatically after the warm-up.

The visual metronome bar pulses at the configured ISI. Each stimulus window is clearly marked on screen and by an audio cue.

**Controls during a run:**

| Action | Button / Key |
|---|---|
| Record a **response** | Tap the large tap zone / press **Space** |
| Record **no response** | Do nothing — the timer advances automatically |
| Stop a run early | **Stop Run** button |
| Finish the current trial | **Finish Trial** button (enabled after completing ≥ 1 run) |

> **Do not navigate away** during an active run — a banner reminds you. If you must leave, the run data up to that point is preserved in IndexedDB.

### 3. Recording Responses

- **1** is recorded when a response is logged within the stimulus window.
- **0** is recorded when the window closes with no tap.
- The live progress counter shows the current stimulus number.
- Toggle **Hide/Show Progress** to declutter the screen during recording.

### 4. Exporting Data

After finishing a trial the app moves to the **Assay Export** screen:

1. Select which **datasets** (trials / pooled) to include.
2. Click **Preview Results** to see a formatted table before exporting.
3. Click **Export to Excel** (`.xlsx`) or **Export CSV** (`.csv`, works fully offline).

**What's in the export:**

| Sheet section | Contents |
|---|---|
| Raw stimulus values | Per-run binary response array (1 = responded, 0 = no response) |
| Binned % response | Response rate per bin, plus Mean / SEM / N |
| Touch Index (binned) | Bin values normalised to Bin 1 baseline |
| Touch Index (analysed) | Mean / SEM / N across animals per genotype |

Click **Start New Trial** to record another trial within the same assay, or **New Assay** to return to setup.

---

## Data Model

Data is organised in a three-level hierarchy, persisted to IndexedDB:

```
Assay  (experimental parameters, genotype list)
└── Trial  (one recording session)
    └── Run  (one animal)
        └── values[]  (one boolean per stimulus: 1 or 0)
```

- **Assay** — holds ISI, stimCount, binSize, temperature, humidity, genotypes.
- **Trial** — status: `active` | `completed` | `abandoned`.
- **Run** — status: `active` | `completed` | `stoppedEarly` | `abandoned`; includes eligibility flags and Touch Index exclusion reason.

All objects are plain JSON — no classes — so they serialise cleanly to IndexedDB and can be inspected in DevTools.

---

## Audio Cues

The timing engine uses a **two-layer architecture** for accuracy:

- **Layer 1 (hardware):** The Web Audio API schedules beep tones slightly ahead of time using the `AudioContext` hardware clock — achieving sub-millisecond precision regardless of JS thread load.
- **Layer 2 (voice/UI):** The Web Speech API fires the spoken count at the exact moment the stimulus window opens, keeping voice in sync with the visual display.

**Available cue modes** (configurable in Settings):

| Mode | Behaviour |
|---|---|
| **Tick** | Short beep every stimulus |
| **Count** | Spoken stimulus number every stimulus |
| **Both** | Tick + spoken count |
| **Off** | Silent |

---

## Haptic Armband Integration

The timer supports an optional external **Haptic Armband** (built on the Seeed XIAO nRF52840) worn by the researcher. This allows the researcher to feel precise tactile feedback without relying on audio or screen visuals.

The armband uses a **DRV2605L haptic motor driver** (I²C) paired with an **external ERM coin vibration motor**, giving clean, consistent, and adjustable haptic output without overloading any GPIO pin.

- **Zero-Latency Mirroring:** The armband perfectly mirrors the native device haptics (a crisp 50ms pulse on tap, and an ascending pattern on trial completion) via a direct Web Bluetooth (GATT) connection.
- **Safety Watchdog:** A 2-second heartbeat ensures the armband vibrates autonomously if the app crashes or drops the connection.
- **Battery Monitoring:** Uses the standard BLE Battery Service to display the armband's battery percentage in the header, with smart threshold warnings at ≤20% and ≤10%.

> See [`armband_build_guide.md`](./armband_build_guide.md) for the full parts list, wiring diagram, and step-by-step assembly instructions.

### Armband Signals & Feedback

**Visual Indicators (XIAO Onboard RGB LED):**
- **Booting up:** Solid White
- **Advertising / Waiting to connect:** Slow Blue Blink
- **Connected:** Solid Green
- **Low Battery (< 15%):** Fast Amber (Red+Green) Blink
- **Fatal Error:** Solid Red

**Vibration Patterns:**
- **Boot Sequence:** Three escalating pulses (alive confirmation)
- **BLE Ready / Advertising:** Double tap
- **Connected:** Single tap
- **Disconnected:** Rapid buzz (6 quick pulses)
- **Low Battery:** SOS pattern (··· ─── ···)
- **Fatal Error:** Rapid infinite pulsing

*Note: The armband features require a Chromium-based browser (Chrome, Edge). On unsupported browsers like Safari or Firefox, the feature degrades gracefully and is hidden from the UI.*

---

## Settings

Access **Settings** from the ⋮ overflow menu in the header.

| Setting | Options / Range |
|---|---|
| **Display Theme** | Light / Dark (or toggle from the header) |
| **Tick Pitch** | 200 – 2000 Hz (preview plays on slider move) |
| **Speech Lead** | How many ms before stimulus the spoken count starts |
| **Audio Cue Mode** | Tick / Count / Both / Off |
| **Voice** | Select from available TTS voices in your browser |

All settings are persisted to `localStorage` and restored on next launch.

---

## Offline & PWA Installation

The service worker pre-caches all assets on first visit. After that, the app works with **no internet connection**.

### Install to home screen

| Platform | Steps |
|---|---|
| **iOS (Safari)** | Tap the Share button → "Add to Home Screen" |
| **Android (Chrome)** | Tap the ⋮ menu → "Add to Home Screen" / "Install app" |
| **Desktop (Chrome / Edge)** | Click the install icon in the address bar |

Once installed, the app opens in standalone mode (no browser chrome) and behaves like a native app.

---

## Data Storage & Privacy

- All assay data is stored **locally** in your browser's **IndexedDB** (`touch-assay-db`).
- **No data is ever sent to a server.** There is no backend, no analytics, no telemetry.
- Data persists across sessions but is **browser-local** — it will not sync between devices.
- Clearing your browser's site data will delete all saved assays. Export your data regularly.
- A banner will appear if IndexedDB is unavailable (e.g. private/incognito mode) — in that case, data is **not** saved and you should export immediately after each trial.

---

## Project Structure

```
.
├── index.html          # Single-page app shell; all screens defined here
├── styles.css          # All styling (vanilla CSS, no framework)
├── manifest.json       # PWA manifest (name, icons, display mode)
├── service-worker.js   # Offline caching via Cache API
├── icon-192.png        # PWA icon (192×192)
├── icon-512.png        # PWA icon (512×512, maskable)
└── js/
    ├── main.js         # App controller — state machine, event handling, UI updates
    ├── models.js       # Data model factories (createAssay, createTrial, createRun)
    ├── db.js           # IndexedDB persistence layer
    ├── audio.js        # Web Audio API metronome + Web Speech API countdown
    ├── haptic-armband.js # Web Bluetooth GATT module for wearable integration
    ├── export.js       # Excel (SheetJS) / CSV / HTML preview generation
    ├── utils.js        # Binning, Touch Index, pooled-run computation
    ├── toast.js        # Non-blocking notification toasts
    └── timer-worker.js # Web Worker — drift-compensated ISI scheduler
```

---

## Browser Compatibility

| Feature | Requirement |
|---|---|
| Core app | Any modern browser (Chrome 90+, Firefox 90+, Safari 15+, Edge 90+) |
| IndexedDB persistence | All modern browsers (disabled in some private modes) |
| Web Audio API (ticks) | Chrome, Firefox, Safari, Edge |
| Web Speech API (voice) | Chrome, Edge (limited in Firefox/Safari) |
| Web Bluetooth (Armband) | Chrome, Edge, Android Chrome (Not supported in Safari/Firefox) |
| PWA install | Chrome, Edge, Safari 16.4+ |
| Offline mode | All browsers with Service Worker support |

> **iOS note:** Add to Home Screen from Safari for the best PWA experience. Other iOS browsers may have limited PWA support.

---

## License

MIT © 2026 Abhinav Gupta — see [LICENSE](./LICENSE) for full text.

Forked from [dv-welp/touch-assay-timer](https://github.com/dv-welp/touch-assay-timer).

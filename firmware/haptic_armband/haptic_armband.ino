// ============================================================
//  haptic_armband.ino  —  BLE Haptic Armband Firmware
//  Board: Seeed XIAO BLE nRF52840
//  Libraries: ArduinoBLE, Adafruit DRV2605
//
//  Hardware: DRV2605L haptic driver (I²C) + LRA motor
//    DRV2605L SDA → D4 (XIAO I²C SDA)
//    DRV2605L SCL → D5 (XIAO I²C SCL)
//    DRV2605L VIN → 3.3V (logic supply)
//    DRV2605L VM  → LiPo BAT+ (motor supply, up to 3.7V)
//    DRV2605L GND → GND
//    LRA motor    → DRV2605L OUTP / OUTN (polarity-sensitive!)
//
//  GATT layout (must match js/haptic-armband.js exactly):
//    Service UUID:    12345678-1234-1234-1234-123456789012
//    Haptic char:     12345678-1234-1234-1234-000000000001  (Write)
//    Heartbeat char:  12345678-1234-1234-1234-000000000002  (Write)
//    Battery char:    0x2A19 / 0x180F service              (Read+Notify)
//
//  Command bytes (haptic characteristic):
//    0x01  →  single tap    (vibrate 50 ms)
//    0x02  →  run complete  (vibrate 100–50–200 ms ascending)
//
//  Heartbeat characteristic:
//    JS writes 0x01 every 2 s during a run.
//    If no heartbeat arrives for >3 s the firmware fires
//    a stutter warning pattern autonomously.
// ============================================================

#include <ArduinoBLE.h>
#include <Wire.h>
#include <Adafruit_DRV2605.h>

// ── DRV2605L Driver Instance ─────────────────────────────────
Adafruit_DRV2605 drv;

// XIAO nRF52840 battery monitoring
// PIN_VBAT  = P0.31, routed through an on-board 1MΩ/1MΩ divider.
// Pin 14 (P0.14) gates the divider FET — must be driven HIGH before reading.
// If PIN_VBAT is not defined by your BSP version, we fall back to pin 32 (P0.31).
#ifndef PIN_VBAT
  #define PIN_VBAT 32
#endif
#define VBAT_ENABLE_PIN 14   // pull HIGH to connect divider, LOW when done

// ── Onboard RGB LED ──────────────────────────────────────────
// XIAO nRF52840 built-in RGB is ACTIVE LOW (write LOW to turn ON)
#define LED_R  LED_RED
#define LED_G  LED_GREEN
#define LED_B  LED_BLUE

inline void setLED(bool r, bool g, bool b) {
  digitalWrite(LED_R, r ? LOW : HIGH);
  digitalWrite(LED_G, g ? LOW : HIGH);
  digitalWrite(LED_B, b ? LOW : HIGH);
}
inline void ledOff() { setLED(false, false, false); }

// ── Board State Machine ──────────────────────────────────────
enum BoardState {
  STATE_BOOTING,
  STATE_ADVERTISING,
  STATE_CONNECTED,
  STATE_LOW_BATTERY,
  STATE_BLE_ERROR
};
BoardState boardState = STATE_BOOTING;

// Blink timing (non-blocking)
unsigned long lastBlinkTime  = 0;
bool          blinkLedState  = false;
const unsigned long BLINK_INTERVAL_MS = 1000; // 1 s slow-blink while advertising

// ── BLE Service & Characteristics ───────────────────────────
// Canonical UUIDs — must match js/haptic-armband.js exactly
BLEService hapticService("12345678-1234-1234-1234-123456789012");

// Haptic command: JS writes 0x01 (tap) or 0x02 (run complete)
BLEByteCharacteristic hapticChar(
  "12345678-1234-1234-1234-000000000001",
  BLEWrite | BLEWriteWithoutResponse
);

// Heartbeat: JS writes 0x01 every 2 s during a run
BLEByteCharacteristic heartbeatChar(
  "12345678-1234-1234-1234-000000000002",
  BLEWrite | BLEWriteWithoutResponse
);

// Standard Battery Level (0x180F service / 0x2A19 characteristic)
BLEService           batteryService("180F");
BLEByteCharacteristic batteryChar("2A19", BLERead | BLENotify);

// ── Heartbeat watchdog ───────────────────────────────────────
unsigned long lastHeartbeatMs    = 0;
bool          heartbeatActive    = false;  // true once first HB received
const unsigned long HB_TIMEOUT_MS = 3000; // >3 s with no HB → stutter warning

// ── Battery update interval ──────────────────────────────────
unsigned long lastBatteryUpdate   = 0;   // init'd to millis() at end of setup()
const unsigned long BATTERY_INTERVAL_MS = 30000;

// ── Non-Blocking Motor State Machine ─────────────────────────
// All motor timing is tracked here — no delay() calls anywhere in the
// main loop. A new pulse sequence immediately preempts any in-progress one.
//
// A "sequence" is a flat array of alternating on/off durations (ms):
//   { onMs, offMs, onMs, offMs, ... }
// The machine steps through them one phase at a time.

// Maximum phases in a single sequence (on+off counts as 2 phases each pulse)
#define MAX_MOTOR_PHASES 16

static int           motorPhases[MAX_MOTOR_PHASES];  // durations in ms
static int           motorPhaseCount  = 0;           // how many phases are loaded
static int           motorPhaseIndex  = 0;           // which phase is active
static unsigned long motorPhaseStart  = 0;           // when the current phase began
static bool          motorRunning     = false;       // true while a sequence is active

// Load a new sequence and start it immediately (preempts anything running).
// phases: alternating on/off durations, e.g. {50, 0} for a 50ms single tap.
// count:  number of entries in phases[].
void motorStart(const int* phases, int count) {
  // Stop motor immediately if one was running
  drv.setRealtimeValue(0);
  drv.setMode(DRV2605_MODE_INTTRIG);

  // Clamp to buffer size
  if (count > MAX_MOTOR_PHASES) count = MAX_MOTOR_PHASES;
  for (int i = 0; i < count; i++) motorPhases[i] = phases[i];
  motorPhaseCount = count;
  motorPhaseIndex = 0;
  motorPhaseStart = millis();
  motorRunning    = true;

  // Start first phase (ON)
  drv.setMode(DRV2605_MODE_REALTIME);
  drv.setRealtimeValue(127);  // full LRA amplitude (signed 8-bit: 0=off, 127=max)
}

// Stop the motor immediately and clear the sequence.
void motorStop() {
  drv.setRealtimeValue(0);
  drv.setMode(DRV2605_MODE_INTTRIG);
  motorRunning    = false;
  motorPhaseCount = 0;
  motorPhaseIndex = 0;
}

// Call every loop iteration — advances phase timing without blocking.
void motorUpdate() {
  if (!motorRunning) return;

  unsigned long elapsed = millis() - motorPhaseStart;
  if (elapsed < (unsigned long)motorPhases[motorPhaseIndex]) return; // still in this phase

  // Advance to next phase
  motorPhaseIndex++;
  if (motorPhaseIndex >= motorPhaseCount) {
    // Sequence complete — ensure motor is off
    motorStop();
    return;
  }

  motorPhaseStart = millis();
  bool isOnPhase  = (motorPhaseIndex % 2 == 0); // even indices = ON, odd = OFF
  if (isOnPhase) {
    drv.setMode(DRV2605_MODE_REALTIME);
    drv.setRealtimeValue(127);
  } else {
    drv.setRealtimeValue(0);
    drv.setMode(DRV2605_MODE_INTTRIG);
  }
}

// ── Vibration Pattern Helpers ────────────────────────────────
// Each function encodes its pulse sequence as a flat on/off array and
// passes it to motorStart(). The motor state machine handles the rest
// without blocking.

// 0x01 — tap registered (mirrors navigator.vibrate(50))
void vibrateTap() {
  static const int seq[] = { 50, 0 };
  motorStart(seq, 2);
}

// 0x02 — run complete (mirrors navigator.vibrate([100,50,200]))
void vibrateRunComplete() {
  static const int seq[] = { 100, 50, 200, 0 };
  motorStart(seq, 4);
}

// Stutter warning — fired by watchdog when heartbeat is lost
void vibrateStutterWarning() {
  static const int seq[] = { 40, 40, 40, 40, 40, 0 };
  motorStart(seq, 6);
}

// Boot sequence — three escalating pulses (alive confirmation)
// NOTE: Called from setup() before BLE is running. A brief blocking
// startup is acceptable here since no BLE events exist yet.
void startupVibrationSequence() {
  static const int seq[] = { 60, 120, 120, 120, 250, 80 };
  motorStart(seq, 6);
  // Block until startup sequence finishes — safe here because BLE isn't
  // up yet and no events can be dropped.
  while (motorRunning) motorUpdate();
}

// Disconnect buzz — rapid 6-pulse burst.
// Called only AFTER BLE.advertise() so device is already discoverable
// while the pattern plays non-blockingly.
void vibrateDisconnect() {
  static const int seq[] = { 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 0 };
  motorStart(seq, 12);
}

// BLE-ready confirmation double-tap (called from setup)
void vibrateBleReady() {
  static const int seq[] = { 80, 70, 80, 0 };
  motorStart(seq, 4);
  while (motorRunning) motorUpdate(); // finish before entering loop
}

// Connect-confirm single tap (called on new central connection)
void vibrateConnected() {
  vibrateTap();
}

// ── Battery Reading ──────────────────────────────────────────
// Reads the WLY 602040 3.7V 400mAh LiPo via the XIAO nRF52840's on-board
// 1MΩ/1MΩ voltage divider on PIN_VBAT (P0.31).
//
//   • Use PIN_VBAT (P0.31), not A0 — A0 is floating/unconnected.
//   • Drive VBAT_ENABLE_PIN HIGH to switch on the divider FET before reading.
//   • Use AR_INTERNAL2V4 — the 2.4V internal reference available in the
//     Seeed nRF52 BSP. This is stable and independent of VDD.
//     (The generic AR_INTERNAL_3_0 / AR_DEFAULT names do not exist in this BSP.)
//   • Use 12-bit resolution (nRF52840 ADC max) for ~0.6 mV/LSB accuracy.
//   • Divider factor is ×2 (1MΩ : 1MΩ), so VBAT = ADC_voltage × 2.
//     LiPo pin voltage range: 1.5 V (empty) → 2.1 V (full) — well within 2.4V ref.
//   • LiPo discharge curve: 3.0V (0%) → 4.2V (100%).
int readBatteryPercent() {
  // Enable the voltage divider FET
  pinMode(VBAT_ENABLE_PIN, OUTPUT);
  digitalWrite(VBAT_ENABLE_PIN, HIGH);
  delayMicroseconds(500); // allow divider to settle

  // AR_INTERNAL2V4 = 2.4V internal reference (Seeed nRF52 BSP constant)
  analogReference(AR_INTERNAL2V4);
  analogReadResolution(12); // 12-bit: 0–4095

  int raw = analogRead(PIN_VBAT);

  // Disable divider FET to save power between reads
  digitalWrite(VBAT_ENABLE_PIN, LOW);

  // VBAT = raw_voltage × 2  (undo the 1:1 divider)
  // raw_voltage = raw * (2.4V / 4095)
  float volt = raw * (2.4f / 4095.0f) * 2.0f;

  // LiPo: 3.0V = 0%, 4.2V = 100%
  int pct = (int)((volt - 3.0f) / 1.2f * 100.0f);
  return constrain(pct, 0, 100);
}

// ── LED State (call every loop iteration) ────────────────────
void updateLED() {
  unsigned long now = millis();
  switch (boardState) {
    case STATE_BOOTING:
      setLED(true, true, true);        // solid white
      break;
    case STATE_ADVERTISING:
      if (now - lastBlinkTime >= BLINK_INTERVAL_MS) {
        lastBlinkTime = now;
        blinkLedState = !blinkLedState;
      }
      setLED(false, false, blinkLedState); // slow blue blink
      break;
    case STATE_CONNECTED:
      setLED(false, true, false);      // solid green
      break;
    case STATE_LOW_BATTERY:
      if (now - lastBlinkTime >= 300) {
        lastBlinkTime = now;
        blinkLedState = !blinkLedState;
      }
      setLED(blinkLedState, blinkLedState, false); // fast amber blink
      break;
    case STATE_BLE_ERROR:
      setLED(true, false, false);      // solid red
      break;
  }
}

// ── Setup ────────────────────────────────────────────────────
void setup() {
  // LED — start all OFF (ACTIVE LOW)
  pinMode(LED_R, OUTPUT); digitalWrite(LED_R, HIGH);
  pinMode(LED_G, OUTPUT); digitalWrite(LED_G, HIGH);
  pinMode(LED_B, OUTPUT); digitalWrite(LED_B, HIGH);
  boardState = STATE_BOOTING;
  updateLED(); // solid white

  // Serial (optional)
  Serial.begin(115200);
  unsigned long t = millis();
  while (!Serial && millis() - t < 2000) {}

  // ── DRV2605L Init (LRA mode) ──────────────────────────────
  // The DRV2605L communicates over I²C at fixed address 0x5A.
  // Wire.begin() uses XIAO D4 (SDA) and D5 (SCL) by default.
  Wire.begin();
  if (!drv.begin()) {
    Serial.println("ERROR: DRV2605L not found! Check I²C wiring (D4=SDA, D5=SCL).");
    boardState = STATE_BLE_ERROR;
    updateLED(); // solid red — motor unavailable, keep LED on for diagnosis
    while (1) {} // halt — do NOT buzz; DRV2605L is unreachable
  }

  // ── LRA-specific register configuration ───────────────────
  //
  // Step 1: Select LRA ROM waveform library.
  //   Library 6 = LRA. This is different from ERM libraries 1–5.
  drv.selectLibrary(6);

  // Step 2: Set N_ERM_LRA bit in register 0x1A (CTRL1) — tells
  //   the driver this is an LRA, not an ERM motor.
  //   Bit 7 of 0x1A: 0 = ERM, 1 = LRA
  drv.writeRegister8(0x1A, drv.readRegister8(0x1A) | 0x80);

  // Step 3: Enable closed-loop LRA (auto-resonance tracking).
  //   Register 0x1D (CTRL4), bit 2 = LRA_OPEN_LOOP.
  //   Clear this bit → closed-loop (auto-resonance ON). This is
  //   critical: open-loop drives at a fixed freq and wastes power;
  //   closed-loop locks onto the motor's true resonant frequency.
  drv.writeRegister8(0x1D, drv.readRegister8(0x1D) & ~0x04);

  // Step 4: Set RATED_VOLTAGE register (0x16).
  //   Formula: RATED_VOLTAGE = V_rated_rms * 255 / (1.8 * sqrt(2))
  //                          = V_rated_rms * 255 / 2.5456
  //   Motor is rated at 1.8V RMS → 1.8 * 255 / 2.5456 ≈ 180 = 0xB4
  //   ↓ Adjust this value if using a different motor:
  drv.writeRegister8(0x16, 0xB4);   // ≈ 1.8V RMS for 1.8V-rated LRA
                                     // Decrease for lower-rated motors (e.g.
                                     // 0x78 for 1.2V, 0x96 for 1.5V)

  // Step 5: Set OD_CLAMP register (0x17) — overdrive clamp voltage.
  //   This limits the peak drive voltage during the attack phase.
  //   Formula: OD_CLAMP = V_od * 255 / (1.8 * sqrt(2))
  //   Typically set 10–20% above rated. For 1.8V rated → ~2.1V → 0xCB.
  drv.writeRegister8(0x17, 0x89);   // ≈ 3.0V overdrive clamp

  // Step 6: Set drive mode to internal trigger (default). The motor
  //   state machine switches to RTP mode per-phase as needed.
  drv.setMode(DRV2605_MODE_INTTRIG);

  Serial.println("DRV2605L initialised in LRA closed-loop mode.");
  Serial.print(  "  RATED_VOLTAGE (0x16): 0x"); Serial.println(drv.readRegister8(0x16), HEX);
  Serial.print(  "  OD_CLAMP      (0x17): 0x"); Serial.println(drv.readRegister8(0x17), HEX);
  Serial.print(  "  CTRL1         (0x1A): 0x"); Serial.println(drv.readRegister8(0x1A), HEX);
  Serial.print(  "  CTRL4         (0x1D): 0x"); Serial.println(drv.readRegister8(0x1D), HEX);

  Serial.println("Startup vibration sequence...");
  startupVibrationSequence(); // blocks until complete (safe — BLE not yet running)

  // BLE init
  if (!BLE.begin()) {
    Serial.println("ERROR: BLE init failed!");
    boardState = STATE_BLE_ERROR;
    updateLED(); // solid red
    // BUG 6 FIX: Play SOS every 10 s then return to silent solid-red LED.
    // This alerts the user without draining the battery to zero.
    static const int sosPulses[] = {
      100, 80, 100, 80, 100, 80,   // · · ·
      300, 80, 300, 80, 300, 80,   // — — —
      100, 80, 100, 80, 100, 0     // · · ·
    };
    unsigned long lastSos = millis() - 10001UL; // fire immediately on first entry
    while (1) {
      unsigned long now = millis();
      if (now - lastSos > 10000UL) {
        lastSos = now;
        motorStart(sosPulses, 18);
      }
      motorUpdate();
      updateLED(); // keep solid red LED updated
    }
  }

  // ── Build GATT table ────────────────────────────────────────
  // Haptic service
  hapticService.addCharacteristic(hapticChar);
  hapticService.addCharacteristic(heartbeatChar);
  BLE.addService(hapticService);

  // Battery service
  batteryService.addCharacteristic(batteryChar);
  BLE.addService(batteryService);

  // Set initial values
  hapticChar.writeValue(0);
  heartbeatChar.writeValue(0);
  batteryChar.writeValue((uint8_t)readBatteryPercent());

  // Advertise the haptic service UUID so Chrome's filter finds it
  BLE.setLocalName("TouchAssayArmband");
  BLE.setAdvertisedService(hapticService);
  BLE.advertise();

  boardState = STATE_ADVERTISING;
  Serial.println("BLE Haptic Armband ready. Advertising...");
  Serial.println("Service UUID: 12345678-1234-1234-1234-123456789012");

  // BLE-ready double-tap confirmation (blocks until done — safe here)
  vibrateBleReady();

  // BUG 3 FIX: Initialise lastBatteryUpdate to NOW so the first periodic
  // battery read fires after a full BATTERY_INTERVAL_MS, not immediately.
  lastBatteryUpdate = millis();
}

// ── Loop ─────────────────────────────────────────────────────
void loop() {
  // Advance the non-blocking motor state machine on every tick.
  // This ensures motor timing is honoured regardless of BLE activity.
  motorUpdate();

  updateLED();

  BLEDevice central = BLE.central();

  if (central) {
    Serial.print("Connected to: ");
    Serial.println(central.address());

    boardState         = STATE_CONNECTED;
    heartbeatActive    = false;
    lastHeartbeatMs    = millis();
    updateLED(); // immediately go green
    vibrateConnected(); // single connect-confirm pulse (non-blocking)

    while (central.connected()) {
      // BLE.poll() MUST be called on every iteration of the inner loop.
      // ArduinoBLE only processes incoming packets (writes, disconnects, etc.)
      // during a poll. Without this, hapticChar.written() never returns true
      // and all touch commands are silently dropped.
      BLE.poll();

      // Advance motor state machine (replaces all delay() inside old pulse()).
      // BLE.poll() + motorUpdate() together ensure both BLE responsiveness
      // and accurate motor timing with zero blocking.
      motorUpdate();

      updateLED();

      unsigned long now = millis();

      // ── Handle haptic commands ──────────────────────────────
      if (hapticChar.written()) {
        uint8_t cmd = hapticChar.value();
        // BUG 1 FIX: Use "0x" prefix — "0x0" would corrupt logs for cmd >= 0x10
        Serial.print("CMD: 0x"); Serial.println(cmd, HEX);
        switch (cmd) {
          case 0x01: vibrateTap();        break; // tap registered
          case 0x02: vibrateRunComplete(); break; // run complete
          default:
            Serial.print("Unknown cmd: 0x"); Serial.println(cmd, HEX);
            break;
        }
      }

      // ── Handle heartbeat ────────────────────────────────────
      if (heartbeatChar.written()) {
        lastHeartbeatMs = now;
        heartbeatActive = true;
      }

      // BUG 2 FIX: Watchdog — if HB was active and >3 s has lapsed → stutter.
      // After firing, reset lastHeartbeatMs to NOW so the watchdog cannot
      // immediately re-trigger the moment heartbeat resumes after a dropout.
      if (heartbeatActive && (now - lastHeartbeatMs > HB_TIMEOUT_MS)) {
        Serial.println("Heartbeat lost! Stutter warning.");
        vibrateStutterWarning();
        heartbeatActive = false; // one warning per dropout; re-arms on next HB
        lastHeartbeatMs = millis(); // prevent instant re-trigger on HB resume
      }

      // ── Periodic battery update ─────────────────────────────
      if (now - lastBatteryUpdate > BATTERY_INTERVAL_MS) {
        int pct = readBatteryPercent();
        batteryChar.writeValue((uint8_t)pct);
        Serial.print("Battery: "); Serial.print(pct); Serial.println("%");
        lastBatteryUpdate = now;

        if (pct < 15) {
          boardState = STATE_LOW_BATTERY;
          // SOS: three shorts, three longs, three shorts (non-blocking)
          static const int sosSeq[] = {
            100, 80, 100, 80, 100, 80,   // · · ·
            300, 80, 300, 80, 300, 80,   // — — —
            100, 80, 100, 80, 100, 0     // · · ·
          };
          motorStart(sosSeq, 18);
        } else {
          boardState = STATE_CONNECTED;
        }
      }
    }

    // BUG 7 FIX: Call BLE.advertise() FIRST so the device is immediately
    // discoverable while the disconnect buzz plays non-blockingly.
    Serial.println("Disconnected.");
    heartbeatActive = false;
    boardState = STATE_ADVERTISING;
    updateLED();
    BLE.advertise();       // re-start advertising immediately
    vibrateDisconnect();   // non-blocking — plays while device is already visible
  }
}

// ============================================================
//  haptic_armband.ino  —  BLE Haptic Armband Firmware
//  Board: Seeed XIAO BLE nRF52840
//  Libraries: ArduinoBLE, Adafruit DRV2605
//
//  ── MOTOR TYPE ──────────────────────────────────────────────
//  Select your motor type by keeping ONE of the two lines below:
//#define MOTOR_LRA   // Linear Resonant Actuator (closed-loop, 1.8V RMS typical)
#define MOTOR_ERM   // Eccentric Rotating Mass coin motor (open-loop, 3V typical)
//
//  ── DRIVE LEVELS ────────────────────────────────────────────
//  Written to RATED_VOLTAGE (0x16) and OD_CLAMP (0x17) by
//  configureMotorRegisters(). These defaults drive HARDER than the BOM
//  motors are rated for, for a stronger buzz; use the BOM-rated values in
//  the comments for a by-the-datasheet build. (haptic_test.ino uses lower
//  values than these, but still above the BOM ratings.)
//  Formulas: TI SLOS854D, eq. 5 (LRA) and eq. 6 (ERM).
#ifdef MOTOR_LRA
  // LRA closed loop: V_rms = 0x16 × 20.71 mV / sqrt(1 − (4·t_SAMPLE + 300 µs)·f_LRA)
  // 0x78 ≈ 3.1 V RMS at 235 Hz. BOM 1.8 V RMS LRA: 0x46 / 0x60.
  // (haptic_test.ino: 0x57 ≈ 2.2 V RMS / 0x60.)
  #define DRV_RATED_VOLTAGE 0x78
  #define DRV_OD_CLAMP      0xA4
#else
  // ERM open loop: only OD_CLAMP sets the drive, 21.59 mV per LSB → 0xD0 ≈ 4.5 V
  // (capped by the supply rail). BOM 3 V ERM: 0x8B. (haptic_test.ino: 0x96 ≈ 3.2 V.)
  // RATED_VOLTAGE is not used in open loop.
  #define DRV_RATED_VOLTAGE 0xC0
  #define DRV_OD_CLAMP      0xD0
#endif
//
//  ── WIRING ──────────────────────────────────────────────────
//    DRV2605L SDA → D4 (XIAO I²C SDA)
//    DRV2605L SCL → D5 (XIAO I²C SCL)
//    DRV2605L VIN → Dual-voltage OR loop (5V USB + LiPo BAT+ directly via Schottky diodes)
//                   220µF–470µF decoupling cap across VIN/GND. Do NOT use XIAO 3.3V pin.
//    DRV2605L GND → GND
//    DRV2605L EN  → D3  (clone boards only; or hardwire EN to 3.3V)
//    Motor        → DRV2605L OUTP / OUTN
//                   (LRA: observe +/− polarity. ERM: polarity only affects spin direction)
//
//  ── EXTERNAL RGB LED (optional) ─────────────────────────────
//    R anode → 270Ω → D6      Green  = connected
//    G anode → 100Ω → D7      Blue   = advertising
//    B anode → 100Ω → D8      Amber  = low battery
//    Cathode → GND             Red    = error
//    NOTE: Use per-channel resistors — green/blue Vf ≈ 2.8V on a 3.3V rail
//    needs ≤100Ω to reach 5mA. A single 220Ω on all channels will produce
//    near-zero current through green and blue.
//
//  ── GATT layout (must match js/haptic-armband.js exactly) ───
//    Service UUID:   12345678-1234-1234-1234-123456789012
//    Haptic char:    12345678-1234-1234-1234-000000000001  (Write)
//    Heartbeat char: 12345678-1234-1234-1234-000000000002  (Write)
//    Battery char:   0x2A19 / 0x180F service              (Read+Notify)
//
//  ── COMMAND BYTES (haptic characteristic, UUID ...000000000001) ──────
//    0x01 → single tap    (50 ms)
//    0x02 → run complete  (100 ms – 50 ms gap – 200 ms)
//
//  ── HEARTBEAT (separate characteristic, UUID ...000000000002) ─────────
//    JS writes 0x03 every 2 s during a run to the heartbeat characteristic.
//    The firmware only checks that a write occurred — the value is validated
//    (must equal 0x03) as a sanity guard against stray BLE writes.
//    No heartbeat for >3 s → firmware fires stutter warning.
// ============================================================

#include <ArduinoBLE.h>
#include <Wire.h>
#include <Adafruit_DRV2605.h>

// ── Motor type validation ────────────────────────────────────
#if defined(MOTOR_LRA) && defined(MOTOR_ERM)
  #error "Define only one of MOTOR_LRA or MOTOR_ERM, not both."
#endif
#if !defined(MOTOR_LRA) && !defined(MOTOR_ERM)
  #error "Define either MOTOR_LRA or MOTOR_ERM at the top of this file."
#endif

// ── DRV2605L Driver Instance ─────────────────────────────────
Adafruit_DRV2605 drv;

// ── XIAO nRF52840 battery monitoring ─────────────────────────
// PIN_VBAT = P0.31, the midpoint of an on-board 1MΩ (top) / 510kΩ (bottom)
// divider across the battery. The divider's low side is P0.14: drive it
// LOW to enable reading, and KEEP it LOW — HIGH or floating puts P0.31 at
// or above VDD (Seeed wiki warning). Use the core's own pin names: on the
// mbed core, digital pin 14 is the blue LED, not P0.14.
#ifndef PIN_VBAT
  #define PIN_VBAT P0_31
#endif
#ifdef PIN_VBAT_ENABLE
  #define VBAT_ENABLE_PIN PIN_VBAT_ENABLE   // mbed core: index 32 = P0.14
#else
  #define VBAT_ENABLE_PIN P0_14             // PinName overload
#endif

// ── DRV2605L EN pin (clone boards only) ─────────────────────
// Clone boards float EN low, disabling OUTP/OUTN completely.
// Connect EN → D3 on the XIAO and firmware drives it HIGH.
// If you hardwire EN to 3.3V instead, comment out this define.
#define DRV_EN_PIN D3

// ── Onboard RGB LED ──────────────────────────────────────────
// XIAO nRF52840 built-in RGB is ACTIVE LOW (LOW = ON)
#define LED_R  LED_RED
#define LED_G  LED_GREEN
#define LED_B  LED_BLUE

// ── External RGB LED (optional) ──────────────────────────────
// Mirrors onboard LED exactly on external pins D6/D7/D8.
// Comment out USE_EXTERNAL_RGB to disable.
// Uncomment EXT_RGB_COMMON_ANODE if your LED is common-anode.
#define USE_EXTERNAL_RGB
// #define EXT_RGB_COMMON_ANODE

#ifdef USE_EXTERNAL_RGB
  #define EXT_LED_R  D6
  #define EXT_LED_G  D7
  #define EXT_LED_B  D8
  #ifdef EXT_RGB_COMMON_ANODE
    // Common-anode: LOW = ON
    inline void setExtLED(bool r, bool g, bool b) {
      digitalWrite(EXT_LED_R, r ? LOW : HIGH);
      digitalWrite(EXT_LED_G, g ? LOW : HIGH);
      digitalWrite(EXT_LED_B, b ? LOW : HIGH);
    }
  #else
    // Common-cathode (default): HIGH = ON
    inline void setExtLED(bool r, bool g, bool b) {
      digitalWrite(EXT_LED_R, r ? HIGH : LOW);
      digitalWrite(EXT_LED_G, g ? HIGH : LOW);
      digitalWrite(EXT_LED_B, b ? HIGH : LOW);
    }
  #endif
#else
  inline void setExtLED(bool, bool, bool) {}
#endif

// Drive both onboard (active-low) and external LED simultaneously.
inline void setLED(bool r, bool g, bool b) {
  digitalWrite(LED_R, r ? LOW : HIGH);
  digitalWrite(LED_G, g ? LOW : HIGH);
  digitalWrite(LED_B, b ? LOW : HIGH);
  setExtLED(r, g, b);
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

unsigned long lastBlinkTime  = 0;
bool          blinkLedState  = false;
const unsigned long BLINK_INTERVAL_MS = 1000;

// ── BLE Service & Characteristics ───────────────────────────
BLEService hapticService("12345678-1234-1234-1234-123456789012");

BLEByteCharacteristic hapticChar(
  "12345678-1234-1234-1234-000000000001",
  BLEWrite | BLEWriteWithoutResponse
);

BLEByteCharacteristic heartbeatChar(
  "12345678-1234-1234-1234-000000000002",
  BLEWrite | BLEWriteWithoutResponse
);

BLEService            batteryService("180F");
BLEByteCharacteristic batteryChar("2A19", BLERead | BLENotify);

// ── Heartbeat watchdog ───────────────────────────────────────
unsigned long lastHeartbeatMs  = 0;
bool          heartbeatActive  = false;
const unsigned long HB_TIMEOUT_MS = 3000;

// ── Battery update interval ──────────────────────────────────
unsigned long lastBatteryUpdate = 0;
const unsigned long BATTERY_INTERVAL_MS = 30000;

// ── Non-Blocking Motor State Machine ─────────────────────────
// Two drive modes share motorRunning:
//
//  RTP mode (default):
//    motorStart() — alternating on/off phases in motorPhases[]
//    motorUpdate() steps through phases using millis() timing.
//
//  Waveform mode (INTTRIG, selected patterns only):
//    motorWaveformStart() — loads up to 4 chained DRV2605L ROM effects and fires GO.
//    motorUpdate() polls the GO bit (reg 0x0C) every 20 ms to detect completion.
//    Used for vibrateTap() and vibrateRunComplete() because the internal effect ROM
//    includes proper resonant frequency sweeps, braking pulses, and pre-optimised
//    timings that make LRA taps feel sharper than raw RTP square waves.
#define MAX_MOTOR_PHASES 18

static int           motorPhases[MAX_MOTOR_PHASES];
static int           motorPhaseCount    = 0;
static int           motorPhaseIndex    = 0;
static unsigned long motorPhaseStart    = 0;
static bool          motorRunning       = false;
static bool          motorWaveformMode  = false;  // true = INTTRIG waveform playback active
static unsigned long motorWaveformPollMs = 0;     // last GO-bit poll timestamp (throttle)

void motorStart(const int* phases, int count) {
  // Clear a stale motorWaveformMode flag left by an in-progress waveform
  // effect (vibrateTap()/vibrateRunComplete()/etc.) — without this,
  // motorUpdate() keeps polling the GO bit (waveform-mode branch) even
  // though the driver is switched to REALTIME below, reads it cleared on
  // the very next poll, and stops tracking before ever stepping through
  // the phases[] on/off pattern this function is meant to play.
  motorWaveformMode = false;

  drv.setRealtimeValue(0);
  drv.setMode(DRV2605_MODE_INTTRIG);

  if (count > MAX_MOTOR_PHASES) count = MAX_MOTOR_PHASES;
  for (int i = 0; i < count; i++) motorPhases[i] = phases[i];
  motorPhaseCount = count;
  motorPhaseIndex = 0;
  motorPhaseStart = millis();
  motorRunning    = true;

  drv.setMode(DRV2605_MODE_REALTIME);
  drv.setRealtimeValue(127); // full amplitude (RTP signed 8-bit: 127 = max)
}

void motorStop() {
  if (motorWaveformMode) {
    drv.writeRegister8(0x0C, 0);  // clear GO bit — aborts in-progress waveform immediately
    motorWaveformMode = false;
  }
  drv.setRealtimeValue(0);
  drv.setMode(DRV2605_MODE_INTTRIG);
  motorRunning    = false;
  motorPhaseCount = 0;
  motorPhaseIndex = 0;
}

void motorUpdate() {
  if (!motorRunning) return;

  // ── Waveform mode: poll GO bit to detect playback completion ──
  // Throttled to one I²C read every 20 ms to keep loop overhead negligible.
  if (motorWaveformMode) {
    unsigned long now = millis();
    if (now - motorWaveformPollMs >= 20) {
      motorWaveformPollMs = now;
      if (!(drv.readRegister8(0x0C) & 0x01)) {  // GO bit cleared → playback done
        motorRunning      = false;
        motorWaveformMode = false;
      }
    }
    return;
  }

  // ── RTP mode: step through on/off phase array ──────────────
  unsigned long elapsed = millis() - motorPhaseStart;
  if (elapsed < (unsigned long)motorPhases[motorPhaseIndex]) return;

  motorPhaseIndex++;
  if (motorPhaseIndex >= motorPhaseCount) {
    motorStop();
    return;
  }

  // Accumulate phase start to prevent timing drift
  motorPhaseStart += motorPhases[motorPhaseIndex - 1];
  bool isOnPhase = (motorPhaseIndex % 2 == 0); // even indices = ON, odd = OFF
  if (isOnPhase) {
    drv.setMode(DRV2605_MODE_REALTIME);
    drv.setRealtimeValue(127);
  } else {
    drv.setRealtimeValue(0);
    drv.setMode(DRV2605_MODE_INTTRIG);
  }
}

// Arms up to 4 chained DRV2605L internal ROM effects and fires GO non-blockingly.
// Effect numbers (1–123) index TI's pre-optimised waveform library.
// Terminate the chain early with 0 (unused slots auto-terminated at slot 4).
// Compatible with both MOTOR_LRA (library 6) and MOTOR_ERM (library 1) builds;
// the same effect index uses waveform data matched to whichever library initMotor() selected.
void motorWaveformStart(uint8_t e0, uint8_t e1 = 0, uint8_t e2 = 0, uint8_t e3 = 0) {
  motorStop();                          // abort any in-progress RTP or waveform sequence
  drv.setMode(DRV2605_MODE_INTTRIG);
  drv.setWaveform(0, e0);
  drv.setWaveform(1, e1);
  drv.setWaveform(2, e2);
  drv.setWaveform(3, e3);
  drv.setWaveform(4, 0);               // end-of-sequence sentinel (belt-and-suspenders)
  drv.go();
  motorRunning        = true;
  motorWaveformMode   = true;
  motorWaveformPollMs = millis();
}

// ── Vibration Pattern Helpers ────────────────────────────────
// NOTE: LRA physics — the resonant mass needs ~20–30 ms to ring up to full amplitude
// and ~80 ms to fully damp. Pulses shorter than ~80 ms feel weak; gaps shorter than
// ~80 ms blur consecutive bursts together. ERM has no such constraint.
// The durations below are shared by both MOTOR_LRA and MOTOR_ERM builds and are
// already tuned for LRA; the ERM will tolerate them fine.

void vibrateTap() {                    // 0x01 — tap registered
  // Effect 1: Strong Click 100%
  // TI's waveform ROM hits the resonant frequency with a precise sweep + active braking
  // pulse — far sharper attack and stop than an RTP square wave can produce.
  motorWaveformStart(1);
}

void vibrateRunComplete() {            // 0x02 — run complete
  // Effect 10 (Double Click 100%) chained into Effect 47 (Long Buzz 100%):
  // two sharp knocks → sustained buzz = unambiguous "run finished" signal.
  // The DRV2605L plays both in sequence autonomously; GO bit clears when done.
  motorWaveformStart(10, 47);
}

void vibrateStutterWarning() {         // heartbeat watchdog
  // 3-pulse rapid-fire; 90 ms on / 80 ms off preserves LRA inter-pulse clarity
  static const int seq[] = { 90, 80, 90, 80, 90, 0 };
  motorStart(seq, 6);
}

void startupVibrationSequence() {      // boot alive confirmation (blocking — BLE not up yet)
  // Ascending ramp: short→medium→long so the user feels amplitude building at boot
  static const int seq[] = { 80, 100, 150, 100, 300, 80 };
  motorStart(seq, 6);
  while (motorRunning) motorUpdate();
}

void vibrateDisconnect() {             // rapid 6-pulse burst
  // 80 ms on / 80 ms off: fastest clean cadence an LRA can produce distinctly
  static const int seq[] = { 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 0 };
  motorStart(seq, 12);
}

void vibrateBleReady() {               // double-tap on BLE ready (blocking — safe here)
  // 120 ms taps with 80 ms gap: strong, unmistakable ready signal
  static const int seq[] = { 120, 80, 120, 0 };
  motorStart(seq, 4);
  while (motorRunning) motorUpdate();
}

void vibrateConnected() { vibrateTap(); }

void vibrateSOS() {                    // Morse "SOS": BLE-init failure, critical battery
  static const int seq[] = {
    100, 80, 100, 80, 100, 80,
    300, 80, 300, 80, 300, 80,
    100, 80, 100, 80, 100, 0
  };
  motorStart(seq, 18);
}

// ── Battery Reading ──────────────────────────────────────────
// Reads WLY 602040 3.7V LiPo via XIAO on-board 1MΩ/510kΩ divider, which
// setup() leaves enabled (VBAT_ENABLE_PIN LOW).
// AR_INTERNAL2V4 = 2.4V internal reference (Seeed nRF52 BSP).
// 12-bit ADC, divider factor ×2.96 (1510/510), LiPo range: 3.0V (0%) → 4.2V (100%).
// The nominal factor can be a few percent off per board (≈2.88 has been
// measured); calibrate against a multimeter if the percentages matter.
int readBatteryPercent() {
  int raw = analogRead(PIN_VBAT);

  float volt = raw * (2.4f / 4095.0f) * (1510.0f / 510.0f);
  int pct = (int)((volt - 3.0f) / 1.2f * 100.0f);
  return constrain(pct, 0, 100);
}

// ── LED State (call every loop iteration) ────────────────────
void updateLED() {
  unsigned long now = millis();
  switch (boardState) {
    case STATE_BOOTING:
      setLED(true, true, true);                        // solid white
      break;
    case STATE_ADVERTISING:
      if (now - lastBlinkTime >= BLINK_INTERVAL_MS) {
        lastBlinkTime = now;
        blinkLedState = !blinkLedState;
      }
      setLED(false, false, blinkLedState);             // slow blue blink
      break;
    case STATE_CONNECTED:
      setLED(false, true, false);                      // solid green
      break;
    case STATE_LOW_BATTERY:
      if (now - lastBlinkTime >= 300) {
        lastBlinkTime = now;
        blinkLedState = !blinkLedState;
      }
      setLED(blinkLedState, blinkLedState, false);     // fast amber blink
      break;
    case STATE_BLE_ERROR:
      setLED(true, false, false);                      // solid red
      break;
  }
}

// ── DRV2605L motor init (LRA) ────────────────────────────────
#ifdef MOTOR_LRA
// Configures the DRV2605L's library, feedback mode, resonance tracking, and
// haptic strength registers for LRA closed-loop drive. Shared by initMotor()
// (first boot) and recoverMotor() (post I2C-fault reinit) so a value tuned
// here applies to both paths.
void configureMotorRegisters() {
  drv.selectLibrary(6);                                          // library 6 = LRA
  drv.writeRegister8(0x1A, drv.readRegister8(0x1A) | 0x80);    // N_ERM_LRA = 1 (LRA)
  drv.writeRegister8(0x1D, drv.readRegister8(0x1D) & ~0x04);   // closed-loop (auto-resonance tracking)
  drv.writeRegister8(0x22, 0x00);  // LRARESON_PERIOD = 0 → let closed-loop track resonant freq freely
  // ── Haptic strength (LRA) — see DRIVE LEVELS at the top of the file ──
  // The defaults are above the BOM LRA's rating; higher values only suit
  // motors rated for them.
  drv.writeRegister8(0x16, DRV_RATED_VOLTAGE);  // RATED_VOLTAGE
  drv.writeRegister8(0x17, DRV_OD_CLAMP);       // OD_CLAMP
}

// Auto-calibration results, kept so recoverMotor() can put them back: a chip
// that really lost power comes back with default calibration otherwise.
static bool    calValid    = false;
static uint8_t calComp     = 0;  // A_CAL_COMP (0x18)
static uint8_t calBemf     = 0;  // A_CAL_BEMF (0x19)
static uint8_t calBemfGain = 0;  // BEMF_GAIN, bits 1:0 of 0x1A

void initMotor() {
  configureMotorRegisters();

  drv.setMode(DRV2605_MODE_AUTOCAL);
  drv.go();
  unsigned long calStart = millis();
  while ((drv.readRegister8(0x0C) & 0x01) && (millis() - calStart < 2000)) delay(10);

  if (drv.readRegister8(0x00) & 0x08) {
    Serial.println("WARNING: LRA auto-calibration failed. Check motor wiring.");
  } else {
    Serial.println("LRA auto-calibration OK (high-drive).");
    calComp     = drv.readRegister8(0x18);
    calBemf     = drv.readRegister8(0x19);
    calBemfGain = drv.readRegister8(0x1A) & 0x03;
    calValid    = true;
    Serial.print("  A_CAL_COMP (0x18): 0x"); Serial.println(calComp, HEX);
    Serial.print("  A_CAL_BEMF (0x19): 0x"); Serial.println(calBemf, HEX);
  }
  drv.setMode(DRV2605_MODE_INTTRIG);
  Serial.println("DRV2605L: LRA closed-loop mode (high-drive).");
}

// I2C recovery restores full LRA config, including the calibration.
// Returns whether the chip answered. Callers must not call drv.begin() again
// to find out: begin() re-runs the library's init, which switches the chip
// back to ERM open-loop mode.
bool recoverMotor() {
  if (!drv.begin()) return false;
  configureMotorRegisters();
  if (calValid) {
    drv.writeRegister8(0x18, calComp);
    drv.writeRegister8(0x19, calBemf);
    drv.writeRegister8(0x1A, (drv.readRegister8(0x1A) & ~0x03) | calBemfGain);
  }
  drv.setMode(DRV2605_MODE_INTTRIG);
  return true;
}
#endif

// ── DRV2605L motor init (ERM) ────────────────────────────────
#ifdef MOTOR_ERM
// Configures the DRV2605L's library, feedback mode, and haptic strength
// registers for ERM open-loop drive. Shared by initMotor() (first boot) and
// recoverMotor() (post I2C-fault reinit) so a value tuned here applies to
// both paths.
void configureMotorRegisters() {
  drv.selectLibrary(1);                                          // library 1 = ERM
  drv.useERM();                                                  // clears N_ERM_LRA bit
  drv.writeRegister8(0x1D, drv.readRegister8(0x1D) | 0x20);    // ERM open-loop
  // ── Haptic strength (ERM) — see DRIVE LEVELS at the top of the file ──
  // The default OD_CLAMP is above the BOM ERM's rating; higher values only
  // suit motors rated for them.
  drv.writeRegister8(0x16, DRV_RATED_VOLTAGE);  // RATED_VOLTAGE (unused in open loop)
  drv.writeRegister8(0x17, DRV_OD_CLAMP);       // OD_CLAMP: sets the open-loop drive
}

void initMotor() {
  configureMotorRegisters();
  drv.setMode(DRV2605_MODE_INTTRIG);
  Serial.println("DRV2605L: ERM open-loop mode (high-drive).");
}

// I2C recovery restores full ERM config. Returns whether the chip answered
// (see the LRA variant for why callers must not call drv.begin() again).
bool recoverMotor() {
  if (!drv.begin()) return false;
  configureMotorRegisters();
  drv.setMode(DRV2605_MODE_INTTRIG);
  return true;
}
#endif

// ── Setup ────────────────────────────────────────────────────
void setup() {
  // LED — start all OFF
  pinMode(LED_R, OUTPUT); digitalWrite(LED_R, HIGH);
  pinMode(LED_G, OUTPUT); digitalWrite(LED_G, HIGH);
  pinMode(LED_B, OUTPUT); digitalWrite(LED_B, HIGH);
#ifdef USE_EXTERNAL_RGB
  #ifdef EXT_RGB_COMMON_ANODE
    pinMode(EXT_LED_R, OUTPUT); digitalWrite(EXT_LED_R, HIGH);
    pinMode(EXT_LED_G, OUTPUT); digitalWrite(EXT_LED_G, HIGH);
    pinMode(EXT_LED_B, OUTPUT); digitalWrite(EXT_LED_B, HIGH);
  #else
    pinMode(EXT_LED_R, OUTPUT); digitalWrite(EXT_LED_R, LOW);
    pinMode(EXT_LED_G, OUTPUT); digitalWrite(EXT_LED_G, LOW);
    pinMode(EXT_LED_B, OUTPUT); digitalWrite(EXT_LED_B, LOW);
  #endif
#endif
  boardState = STATE_BOOTING;
  updateLED(); // solid white

  Serial.begin(115200);
  unsigned long t = millis();
  while (!Serial && millis() - t < 2000) {}

  // Configure ADC for battery monitoring
  analogReference(AR_INTERNAL2V4);
  analogReadResolution(12);
  // Enable the battery divider once and leave it on (a few µA through
  // 1.5 MΩ) — see VBAT_ENABLE_PIN above for why it must never go HIGH.
  pinMode(VBAT_ENABLE_PIN, OUTPUT);
  digitalWrite(VBAT_ENABLE_PIN, LOW);
  // The divider's ~338 kΩ source impedance needs the longest acquisition
  // time; the 10 µs default under-reads.
  analogAcquisitionTime(AT_40_US);

  // Enable DRV2605L output stage (EN pin on clone boards)
  pinMode(DRV_EN_PIN, OUTPUT);
  digitalWrite(DRV_EN_PIN, HIGH);
  delay(10);

  Wire.begin();
  Wire.setClock(400000);

  if (!drv.begin()) {
    Serial.println("ERROR: DRV2605L not found! Check I²C wiring (SDA=D4, SCL=D5).");
    boardState = STATE_BLE_ERROR;
    updateLED(); // solid red
    while (1) {}
  }

  initMotor();

  Serial.println("Startup vibration sequence...");
  startupVibrationSequence();

  if (!BLE.begin()) {
    Serial.println("ERROR: BLE init failed!");
    boardState = STATE_BLE_ERROR;
    updateLED();
    unsigned long lastSos = millis() - 10001UL;
    while (1) {
      unsigned long now = millis();
      if (now - lastSos > 10000UL) { lastSos = now; vibrateSOS(); }
      motorUpdate();
      updateLED();
    }
  }

  hapticService.addCharacteristic(hapticChar);
  hapticService.addCharacteristic(heartbeatChar);
  BLE.addService(hapticService);

  batteryService.addCharacteristic(batteryChar);
  BLE.addService(batteryService);

  hapticChar.writeValue(0);
  heartbeatChar.writeValue(0);
  batteryChar.writeValue((uint8_t)readBatteryPercent());

  BLE.setLocalName("TouchAssayArmband");
  BLE.setAdvertisedService(hapticService);
  BLE.setAdvertisingInterval(800);   // 500 ms — saves ~15% power vs default 100 ms
  BLE.setConnectionInterval(24, 40); // 30–50 ms — haptic commands arrive at ≤1 Hz

  BLE.advertise();

  boardState = STATE_ADVERTISING;
  Serial.println("BLE Haptic Armband ready. Advertising...");
  Serial.println("Service UUID: 12345678-1234-1234-1234-123456789012");

  vibrateBleReady(); // double-tap — blocks until done (safe here, BLE up but no central yet)

  lastBatteryUpdate = millis();
}

// ── Loop ─────────────────────────────────────────────────────
void loop() {
  motorUpdate();
  updateLED();

  BLEDevice central = BLE.central();

  if (central) {
    Serial.print("Connected to: ");
    Serial.println(central.address());

    boardState      = STATE_CONNECTED;
    heartbeatActive = false;
    lastHeartbeatMs = millis();

    int initPct = readBatteryPercent();
    batteryChar.writeValue((uint8_t)initPct);
    Serial.print("Initial battery: "); Serial.print(initPct); Serial.println("%");
    if (initPct <= 20) boardState = STATE_LOW_BATTERY;
    lastBatteryUpdate = millis();

    updateLED();
    vibrateConnected();

    while (central.connected()) {
      BLE.poll();
      motorUpdate();
      updateLED();

      unsigned long now = millis();

      // ── Haptic commands ──────────────────────────────────
      if (hapticChar.written()) {
        uint8_t cmd = hapticChar.value();
        Serial.print("CMD: 0x"); Serial.println(cmd, HEX);
        switch (cmd) {
          case 0x01: vibrateTap();         break;
          case 0x02: vibrateRunComplete(); break;
          // 0x03 is the heartbeat byte — it belongs on heartbeatChar, not here,
          // but ignore it silently as a belt-and-suspenders guard so a
          // misdirected write doesn't spam the Serial log as "Unknown cmd".
          case 0x03: /* heartbeat no-op */  break;
          default:
            Serial.print("Unknown cmd: 0x"); Serial.println(cmd, HEX);
        }
      }

      // ── Heartbeat watchdog ───────────────────────────────
      // Validate the written value is 0x03 (the heartbeat byte used by
      // js/haptic-armband.js). Any other value is a stray write and must
      // not suppress a real dropout.
      if (heartbeatChar.written()) {
        uint8_t hbCmd = heartbeatChar.value();
        if (hbCmd == 0x03) {
          lastHeartbeatMs = now;
          heartbeatActive = true;
        } else if (hbCmd == 0x04) {
          // CMD_HEARTBEAT_STOP: the run ended intentionally (armbandStopHeartbeat()
          // in js/haptic-armband.js). Disarm the watchdog now instead of waiting
          // for it to time out and fire a false "connection lost" alert.
          heartbeatActive = false;
        }
      }
      if (heartbeatActive && (now - lastHeartbeatMs > HB_TIMEOUT_MS)) {
        Serial.println("Heartbeat lost! Stutter warning.");
        vibrateStutterWarning();
        // Deliberately leave heartbeatActive true and just push the deadline
        // forward, instead of disarming — if the paired app crashed and never
        // resumes sending heartbeats, this makes the watchdog re-fire every
        // HB_TIMEOUT_MS for as long as the dropout continues, rather than
        // warning once and then going silent for the rest of the run. A real
        // 0x03 heartbeat arriving in the meantime (case above) still refreshes
        // lastHeartbeatMs normally, so this has no effect once the link recovers.
        lastHeartbeatMs = millis();
      }

      // ── Periodic battery update ──────────────────────────
      if (now - lastBatteryUpdate > BATTERY_INTERVAL_MS) {
        int pct = readBatteryPercent();
        batteryChar.writeValue((uint8_t)pct);
        Serial.print("Battery: "); Serial.print(pct); Serial.println("%");
        lastBatteryUpdate = now;

        if (pct <= 10) {
          boardState = STATE_LOW_BATTERY;
          vibrateSOS();
          Serial.println("CRITICAL: Battery <=10%!");
        } else if (pct <= 20) {
          boardState = STATE_LOW_BATTERY;
          static const int warnSeq[] = { 80, 100, 80, 100, 80, 0 };
          motorStart(warnSeq, 6);
          Serial.println("WARNING: Battery <=20%");
        } else {
          boardState = STATE_CONNECTED;
        }
      }

      // ── I²C health check (every 5 s) ────────────────────
      // Checks the DRV2605L is still on the bus. If lost, attempts
      // full recovery including re-asserting the EN pin.
      static unsigned long lastI2cCheck = 0;
      if (now - lastI2cCheck > 5000UL) {
        lastI2cCheck = now;
        Wire.beginTransmission(0x5A);
        if (Wire.endTransmission() != 0) {
          Serial.println("ERROR: DRV2605L I2C lost! Attempting recovery...");
          // Re-assert EN in case it glitched low
          digitalWrite(DRV_EN_PIN, LOW);
          delay(1);
          digitalWrite(DRV_EN_PIN, HIGH);
          delay(10);
          Wire.end();
          delay(1);
          Wire.begin();
          Wire.setClock(400000);
          Serial.println(recoverMotor() ? "DRV2605L recovered." : "ERROR: DRV2605L recovery failed!");
        }
      }
    }

    // Disconnect — re-advertise first so device is immediately visible,
    // then play disconnect buzz non-blockingly while advertising.
    Serial.println("Disconnected.");
    heartbeatActive = false;
    boardState = STATE_ADVERTISING;
    updateLED();
    BLE.advertise();
    vibrateDisconnect();
  }
}

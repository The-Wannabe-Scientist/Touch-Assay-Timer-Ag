// ============================================================
//  haptic_armband.ino  —  BLE Haptic Armband Firmware
//  Board: Seeed XIAO BLE nRF52840
//  Libraries: ArduinoBLE, Adafruit DRV2605
//
//  ── MOTOR TYPE ──────────────────────────────────────────────
//  Select your motor type by keeping ONE of the two lines below:
#define MOTOR_LRA   // Linear Resonant Actuator (closed-loop, 1.8V RMS typical)
// #define MOTOR_ERM   // Eccentric Rotating Mass coin motor (open-loop, 3V typical)
//
//  ── WIRING ──────────────────────────────────────────────────
//    DRV2605L SDA → D4 (XIAO I²C SDA)
//    DRV2605L SCL → D5 (XIAO I²C SCL)
//    DRV2605L VIN → Dual-voltage OR loop (5V USB + 3.3V battery via Schottky diodes)
//    DRV2605L GND → GND
//    DRV2605L EN  → D3  (clone boards only; or hardwire EN to 3.3V)
//    Motor        → DRV2605L OUTP / OUTN
//                   (LRA: observe +/− polarity. ERM: polarity only affects spin direction)
//
//  ── EXTERNAL RGB LED (optional) ─────────────────────────────
//    R anode → 220Ω → D6      Green  = connected
//    G anode → 220Ω → D7      Blue   = advertising
//    B anode → 220Ω → D8      Amber  = low battery
//    Cathode → GND             Red    = error
//
//  ── GATT layout (must match js/haptic-armband.js exactly) ───
//    Service UUID:   12345678-1234-1234-1234-123456789012
//    Haptic char:    12345678-1234-1234-1234-000000000001  (Write)
//    Heartbeat char: 12345678-1234-1234-1234-000000000002  (Write)
//    Battery char:   0x2A19 / 0x180F service              (Read+Notify)
//
//  ── COMMAND BYTES (haptic characteristic) ───────────────────
//    0x01 → single tap    (50 ms)
//    0x02 → run complete  (100 ms – 50 ms gap – 200 ms)
//
//  ── HEARTBEAT ───────────────────────────────────────────────
//    JS writes 0x01 every 2 s during a run.
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
// PIN_VBAT = P0.31, routed through an on-board 1MΩ/1MΩ divider.
// Pin 14 (P0.14) gates the divider FET — drive HIGH before reading.
#ifndef PIN_VBAT
  #define PIN_VBAT 32
#endif
#define VBAT_ENABLE_PIN 14

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
// Sequences are flat arrays of alternating on/off durations (ms):
//   { onMs, offMs, onMs, offMs, ... , lastOnMs, 0 }
// The final 0 signals end-of-sequence.
#define MAX_MOTOR_PHASES 18

static int           motorPhases[MAX_MOTOR_PHASES];
static int           motorPhaseCount = 0;
static int           motorPhaseIndex = 0;
static unsigned long motorPhaseStart = 0;
static bool          motorRunning    = false;

void motorStart(const int* phases, int count) {
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
  drv.setRealtimeValue(0);
  drv.setMode(DRV2605_MODE_INTTRIG);
  motorRunning    = false;
  motorPhaseCount = 0;
  motorPhaseIndex = 0;
}

void motorUpdate() {
  if (!motorRunning) return;

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

// ── Vibration Pattern Helpers ────────────────────────────────

void vibrateTap() {                    // 0x01 — tap registered
  static const int seq[] = { 50, 0 };
  motorStart(seq, 2);
}

void vibrateRunComplete() {            // 0x02 — run complete
  static const int seq[] = { 100, 50, 200, 0 };
  motorStart(seq, 4);
}

void vibrateStutterWarning() {         // heartbeat watchdog
  static const int seq[] = { 40, 40, 40, 40, 40, 0 };
  motorStart(seq, 6);
}

void startupVibrationSequence() {      // boot alive confirmation (blocking — BLE not up yet)
  static const int seq[] = { 60, 120, 120, 120, 250, 80 };
  motorStart(seq, 6);
  while (motorRunning) motorUpdate();
}

void vibrateDisconnect() {             // rapid 6-pulse burst
  static const int seq[] = { 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 0 };
  motorStart(seq, 12);
}

void vibrateBleReady() {               // double-tap on BLE ready (blocking — safe here)
  static const int seq[] = { 80, 70, 80, 0 };
  motorStart(seq, 4);
  while (motorRunning) motorUpdate();
}

void vibrateConnected() { vibrateTap(); }

// ── Battery Reading ──────────────────────────────────────────
// Reads WLY 602040 3.7V LiPo via XIAO on-board 1MΩ/1MΩ divider.
// AR_INTERNAL2V4 = 2.4V internal reference (Seeed nRF52 BSP).
// 12-bit ADC, divider factor ×2, LiPo range: 3.0V (0%) → 4.2V (100%).
int readBatteryPercent() {
  pinMode(VBAT_ENABLE_PIN, OUTPUT);
  digitalWrite(VBAT_ENABLE_PIN, HIGH);
  delayMicroseconds(500);

  int raw = analogRead(PIN_VBAT);
  digitalWrite(VBAT_ENABLE_PIN, LOW);

  float volt = raw * (2.4f / 4095.0f) * 2.0f;
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
void initMotor() {
  drv.selectLibrary(6);                                          // library 6 = LRA
  drv.writeRegister8(0x1A, drv.readRegister8(0x1A) | 0x80);    // N_ERM_LRA = 1 (LRA)
  drv.writeRegister8(0x1D, drv.readRegister8(0x1D) & ~0x04);   // closed-loop (auto-resonance)
  drv.writeRegister8(0x16, 0x57);  // RATED_VOLTAGE: 1.8V RMS × 255/5.3 ≈ 87
  drv.writeRegister8(0x17, 0x60);  // OD_CLAMP:      2.1V × 255/5.6 ≈ 96

  drv.setMode(DRV2605_MODE_AUTOCAL);
  drv.go();
  unsigned long calStart = millis();
  while ((drv.readRegister8(0x0C) & 0x01) && (millis() - calStart < 2000)) delay(10);

  if (drv.readRegister8(0x00) & 0x08) {
    Serial.println("WARNING: LRA auto-calibration failed. Check motor wiring.");
  } else {
    Serial.println("LRA auto-calibration OK.");
    Serial.print("  A_CAL_COMP (0x18): 0x"); Serial.println(drv.readRegister8(0x18), HEX);
    Serial.print("  A_CAL_BEMF (0x19): 0x"); Serial.println(drv.readRegister8(0x19), HEX);
  }
  drv.setMode(DRV2605_MODE_INTTRIG);
  Serial.println("DRV2605L: LRA closed-loop mode.");
}

// I2C recovery restores full LRA config
void recoverMotor() {
  if (!drv.begin()) return;
  drv.selectLibrary(6);
  drv.writeRegister8(0x1A, drv.readRegister8(0x1A) | 0x80);
  drv.writeRegister8(0x1D, drv.readRegister8(0x1D) & ~0x04);
  drv.writeRegister8(0x16, 0x57);
  drv.writeRegister8(0x17, 0x60);
  drv.setMode(DRV2605_MODE_INTTRIG);
}
#endif

// ── DRV2605L motor init (ERM) ────────────────────────────────
#ifdef MOTOR_ERM
void initMotor() {
  drv.selectLibrary(1);                                          // library 1 = ERM
  drv.useERM();                                                  // clears N_ERM_LRA bit
  drv.writeRegister8(0x1D, drv.readRegister8(0x1D) | 0x20);    // ERM open-loop
  drv.writeRegister8(0x16, 0x90);  // RATED_VOLTAGE: 3.0V × 255/5.3 ≈ 144
  drv.writeRegister8(0x17, 0x96);  // OD_CLAMP:      3.3V × 255/5.6 ≈ 150
  drv.setMode(DRV2605_MODE_INTTRIG);
  Serial.println("DRV2605L: ERM open-loop mode.");
}

// I2C recovery restores full ERM config
void recoverMotor() {
  if (!drv.begin()) return;
  drv.selectLibrary(1);
  drv.useERM();
  drv.writeRegister8(0x1D, drv.readRegister8(0x1D) | 0x20);
  drv.writeRegister8(0x16, 0x90);
  drv.writeRegister8(0x17, 0x96);
  drv.setMode(DRV2605_MODE_INTTRIG);
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
    static const int sosPulses[] = {
      100, 80, 100, 80, 100, 80,
      300, 80, 300, 80, 300, 80,
      100, 80, 100, 80, 100, 0
    };
    unsigned long lastSos = millis() - 10001UL;
    while (1) {
      unsigned long now = millis();
      if (now - lastSos > 10000UL) { lastSos = now; motorStart(sosPulses, 18); }
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
          default:
            Serial.print("Unknown cmd: 0x"); Serial.println(cmd, HEX);
        }
      }

      // ── Heartbeat watchdog ───────────────────────────────
      if (heartbeatChar.written()) {
        lastHeartbeatMs = now;
        heartbeatActive = true;
      }
      if (heartbeatActive && (now - lastHeartbeatMs > HB_TIMEOUT_MS)) {
        Serial.println("Heartbeat lost! Stutter warning.");
        vibrateStutterWarning();
        heartbeatActive = false;
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
          static const int sosSeq[] = {
            100, 80, 100, 80, 100, 80,
            300, 80, 300, 80, 300, 80,
            100, 80, 100, 80, 100, 0
          };
          motorStart(sosSeq, 18);
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
          recoverMotor();
          Serial.println(drv.begin() ? "DRV2605L recovered." : "ERROR: DRV2605L recovery failed!");
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

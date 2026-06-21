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

// ── DRV2605L Vibration Helpers (LRA) ────────────────────────
// For LRA motors, Real-Time Playback (RTP) mode is used for
// precise duration control. The DRV2605L auto-resonance loop
// (closed-loop LRA mode, CTRL3 bit 0 = 0) continuously tracks
// the motor's resonant frequency, so RTP amplitude is applied
// at the correct drive frequency automatically.
//
// RTP value range: 0 (off) → 127 (full scale in signed mode).
// LRA motors respond sharply — 127 is full rated amplitude.
// Lower values (e.g. 80) give reduced intensity haptics.

// Drive the LRA at full amplitude for onMs, then stop.
// Uses real-time playback (RTP) mode for exact duration control.
void pulse(int onMs, int offMs = 0) {
  drv.setMode(DRV2605_MODE_REALTIME);
  drv.setRealtimeValue(127);  // 127 = full LRA amplitude (signed 8-bit)
  delay(onMs);
  drv.setRealtimeValue(0);    // stop motor (brake)
  drv.setMode(DRV2605_MODE_INTTRIG); // return to trigger mode
  if (offMs > 0) delay(offMs);
}

// 0x01 — tap registered (mirrors navigator.vibrate(50))
void vibrateTap() {
  pulse(50);
}

// 0x02 — run complete (mirrors navigator.vibrate([100,50,200]))
void vibrateRunComplete() {
  pulse(100, 50);
  pulse(200);
}

// Stutter warning — fired by watchdog when heartbeat is lost
void vibrateStutterWarning() {
  for (int i = 0; i < 3; i++) {
    pulse(40, 40);
  }
}

// ── Startup Vibration Sequence ───────────────────────────────
void startupVibrationSequence() {
  pulse(60,  120);
  pulse(120, 120);
  pulse(250,  80);
}

// ── Disconnect Vibration ─────────────────────────────────────
void vibrateDisconnect() {
  for (int i = 0; i < 6; i++) pulse(50, 50);
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
    updateLED();
    while (1) {
      setLED(true, false, false); delay(100);
      setLED(false, false, false); delay(200);
    }
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
  //   Formula: RATED_VOLTAGE = V_rated * 255 / (1.8 * sqrt(2))
  //   For a 3.0V LRA: 3.0 * 255 / 2.546 ≈ 301 → capped to 255.
  //   For a 2.0V LRA (common 10mm coin): 2.0 * 255 / 2.546 ≈ 200.
  //   ↓ Adjust this value to match YOUR motor's rated voltage:
  drv.writeRegister8(0x16, 0x50);   // ≈ 1.8V RMS — safe default for 3V LRA
                                     // Increase toward 0xFF for higher amplitude

  // Step 5: Set OD_CLAMP register (0x17) — overdrive clamp voltage.
  //   This limits the peak drive voltage during the attack phase.
  //   Formula: OD_CLAMP = V_od * 255 / (1.8 * sqrt(2))
  //   Typically set 10–20% above rated. For 3V motor → ~3.3V → 0xC8.
  drv.writeRegister8(0x17, 0x89);   // ≈ 3.0V overdrive clamp

  // Step 6: Set drive mode to internal trigger (default). The pulse()
  //   function switches to RTP mode when needed and returns here.
  drv.setMode(DRV2605_MODE_INTTRIG);

  Serial.println("DRV2605L initialised in LRA closed-loop mode.");
  Serial.print(  "  RATED_VOLTAGE (0x16): 0x"); Serial.println(drv.readRegister8(0x16), HEX);
  Serial.print(  "  OD_CLAMP      (0x17): 0x"); Serial.println(drv.readRegister8(0x17), HEX);
  Serial.print(  "  CTRL1         (0x1A): 0x"); Serial.println(drv.readRegister8(0x1A), HEX);
  Serial.print(  "  CTRL4         (0x1D): 0x"); Serial.println(drv.readRegister8(0x1D), HEX);

  Serial.println("Startup vibration sequence...");
  startupVibrationSequence();

  // BLE init
  if (!BLE.begin()) {
    Serial.println("ERROR: BLE init failed!");
    boardState = STATE_BLE_ERROR;
    updateLED();
    while (1) { pulse(50, 200); } // rapid distress buzz
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

  // BLE-ready double-tap confirmation
  pulse(80, 70); pulse(80);
}

// ── Loop ─────────────────────────────────────────────────────
unsigned long lastBatteryUpdate = 0;
const unsigned long BATTERY_INTERVAL_MS = 30000;

void loop() {
  updateLED();

  BLEDevice central = BLE.central();

  if (central) {
    Serial.print("Connected to: ");
    Serial.println(central.address());

    boardState         = STATE_CONNECTED;
    heartbeatActive    = false;
    lastHeartbeatMs    = millis();
    updateLED(); // immediately go green
    vibrateTap(); // single connect-confirm pulse

    while (central.connected()) {
      // BUG FIX: BLE.poll() MUST be called on every iteration of the inner loop.
      // ArduinoBLE only processes incoming packets (writes, disconnects, etc.)
      // during a poll. Without this, hapticChar.written() never returns true
      // and all touch commands are silently dropped.
      BLE.poll();

      updateLED();

      unsigned long now = millis();

      // ── Handle haptic commands ──────────────────────────────
      if (hapticChar.written()) {
        uint8_t cmd = hapticChar.value();
        Serial.print("CMD: 0x0"); Serial.println(cmd, HEX);
        switch (cmd) {
          case 0x01: vibrateTap();        break; // tap registered
          case 0x02: vibrateRunComplete(); break; // run complete
          default:
            Serial.print("Unknown cmd: "); Serial.println(cmd);
            break;
        }
      }

      // ── Handle heartbeat ────────────────────────────────────
      if (heartbeatChar.written()) {
        lastHeartbeatMs = now;
        heartbeatActive = true;
      }

      // Watchdog: if HB was ever active and now >3 s has lapsed → stutter
      if (heartbeatActive && (now - lastHeartbeatMs > HB_TIMEOUT_MS)) {
        Serial.println("Heartbeat lost! Stutter warning.");
        vibrateStutterWarning();
        heartbeatActive = false; // one warning per dropout, re-arms on next HB
      }

      // ── Periodic battery update ─────────────────────────────
      if (now - lastBatteryUpdate > BATTERY_INTERVAL_MS) {
        int pct = readBatteryPercent();
        batteryChar.writeValue((uint8_t)pct);
        Serial.print("Battery: "); Serial.print(pct); Serial.println("%");
        lastBatteryUpdate = now;

        if (pct < 15) {
          boardState = STATE_LOW_BATTERY;
          // SOS: three shorts, three longs, three shorts
          for (int i = 0; i < 3; i++) pulse(100, 80);
          for (int i = 0; i < 3; i++) pulse(300, 80);
          for (int i = 0; i < 3; i++) pulse(100, 80);
        } else {
          boardState = STATE_CONNECTED;
        }
      }
    }

    // Central disconnected
    Serial.println("Disconnected.");
    heartbeatActive = false;
    boardState = STATE_ADVERTISING;
    updateLED();
    vibrateDisconnect(); // rapid buzz on disconnect
    BLE.advertise();     // re-start advertising
  }
}

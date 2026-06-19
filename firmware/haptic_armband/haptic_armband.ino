// ============================================================
//  haptic_armband.ino  —  BLE Haptic Armband Firmware
//  Board: Seeed XIAO BLE nRF52840
//  Library: ArduinoBLE
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

// ── Pin Definitions ─────────────────────────────────────────
#define VIBRATION_PIN   D0    // Grove Vibration Motor signal

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

// ── Vibration helpers ────────────────────────────────────────

// Single blocking pulse: on for onMs, then off for offMs
void pulse(int onMs, int offMs = 0) {
  digitalWrite(VIBRATION_PIN, HIGH);
  delay(onMs);
  digitalWrite(VIBRATION_PIN, LOW);
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
// Key corrections vs. the naive A0 approach:
//   • Use PIN_VBAT (P0.31), not A0 — A0 is floating/unconnected.
//   • Drive VBAT_ENABLE_PIN HIGH to switch on the divider FET before reading.
//   • Use the internal 3.0V fixed reference (AR_INTERNAL_3_0) so the reading
//     is independent of VDD, which itself fluctuates on battery power.
//   • Use 12-bit resolution (nRF52840 ADC max) for ~0.7 mV/LSB accuracy.
//   • Divider factor is ×2 (1MΩ : 1MΩ), so VBAT = ADC_voltage × 2.
//   • LiPo discharge curve: 3.0V (0%) → 4.2V (100%).
int readBatteryPercent() {
  // Enable the voltage divider
  pinMode(VBAT_ENABLE_PIN, OUTPUT);
  digitalWrite(VBAT_ENABLE_PIN, HIGH);
  delayMicroseconds(500); // allow divider to settle

  // Configure ADC for accurate absolute measurement
  analogReference(AR_INTERNAL_3_0); // 3.0V internal reference (stable)
  analogReadResolution(12);          // 12-bit: 0–4095

  int raw = analogRead(PIN_VBAT);

  // Restore defaults so other analogRead calls are unaffected
  analogReadResolution(10);
  analogReference(AR_DEFAULT);

  // Disable divider FET to save power between reads
  digitalWrite(VBAT_ENABLE_PIN, LOW);

  // VBAT = raw_voltage × 2  (undo the 1:1 divider)
  float volt = raw * (3.0f / 4095.0f) * 2.0f;

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

  // Motor
  pinMode(VIBRATION_PIN, OUTPUT);
  digitalWrite(VIBRATION_PIN, LOW);

  // Serial (optional)
  Serial.begin(115200);
  unsigned long t = millis();
  while (!Serial && millis() - t < 2000) {}

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

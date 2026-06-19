// ============================================================
//  haptic_armband.ino  —  BLE Haptic Armband Firmware
//  Board: Seeed XIAO BLE nRF52840
//  Library: ArduinoBLE
// ============================================================

#include <ArduinoBLE.h>

// ── Pin Definitions ─────────────────────────────────────────
#define VIBRATION_PIN   D0    // Grove Vibration Motor signal
#define BATTERY_ADC_PIN A0    // Optional: voltage divider for battery %
// (XIAO nRF52840 has built-in charge state LED,
//  battery ADC requires a resistor divider on A0)

// ── Onboard RGB LED ──────────────────────────────────────────
// XIAO nRF52840 built-in RGB is ACTIVE LOW (write LOW to turn ON)
#define LED_R  LED_RED    // built-in red   channel (active LOW)
#define LED_G  LED_GREEN  // built-in green channel (active LOW)
#define LED_B  LED_BLUE   // built-in blue  channel (active LOW)

// Helper: set RGB LED colour (true = ON, false = OFF for each channel)
inline void setLED(bool r, bool g, bool b) {
  digitalWrite(LED_R, r ? LOW : HIGH);
  digitalWrite(LED_G, g ? LOW : HIGH);
  digitalWrite(LED_B, b ? LOW : HIGH);
}
inline void ledOff() { setLED(false, false, false); }

// ── Board State Machine ──────────────────────────────────────
enum BoardState {
  STATE_BOOTING,       // startup sequence running
  STATE_ADVERTISING,   // BLE advertising, waiting for central
  STATE_CONNECTED,     // central device connected
  STATE_LOW_BATTERY,   // battery < 15 %
  STATE_BLE_ERROR      // BLE init failed — fatal
};

BoardState boardState = STATE_BOOTING;

// Blink timing for advertising state (non-blocking)
unsigned long lastBlinkTime   = 0;
bool          blinkLedState   = false;
const unsigned long BLINK_INTERVAL_MS = 1000; // 1 s slow-blink while advertising

// ── BLE Service & Characteristics ───────────────────────────
// Using standard "Haptic" / custom 128-bit UUIDs
BLEService hapticService("19B10000-E8F2-537E-4F6C-D104768A1214");

// Pattern command: write 0–4 to trigger pattern
BLEByteCharacteristic patternChar(
  "19B10001-E8F2-537E-4F6C-D104768A1214",
  BLEWrite
);

// Battery level 0–100 (read + notify)
BLEByteCharacteristic batteryChar(
  "2A19",   // Standard Battery Level UUID
  BLERead | BLENotify
);

// ── Vibration Patterns ───────────────────────────────────────
struct Pulse { int onMs; int offMs; int reps; };

const Pulse PATTERNS[][5] = {
  // 0: Single short tap  — connect confirmation
  {{50, 0, 1}, {0,0,0}, {0,0,0}, {0,0,0}, {0,0,0}},
  // 1: Double tap        — generic confirm / boot
  {{80, 70, 2}, {0,0,0}, {0,0,0}, {0,0,0}, {0,0,0}},
  // 2: Long pulse        — disconnect
  {{600, 0, 1}, {0,0,0}, {0,0,0}, {0,0,0}, {0,0,0}},
  // 3: SOS (··· ─── ···) — low battery / error alert
  {{100,80,3},{300,80,3},{100,80,3},{0,0,0},{0,0,0}},
  // 4: Rapid buzz        — disconnect buzz
  {{50, 50, 6}, {0,0,0}, {0,0,0}, {0,0,0}, {0,0,0}},
};

// ── Battery Reading ──────────────────────────────────────────
int readBatteryPercent() {
  // Simple voltage divider: 100kΩ from BAT+ to A0, 100kΩ from A0 to GND
  // Full scale 4.2V → 2.1V at A0 → 3.3V ref → ~65% of ADC range
  int raw = analogRead(BATTERY_ADC_PIN);
  float voltage = raw * (3.3f / 1023.0f) * 2.0f;  // ×2 for divider
  // LiPo: 3.0V = 0%, 4.2V = 100%
  int pct = (int)((voltage - 3.0f) / 1.2f * 100.0f);
  return constrain(pct, 0, 100);
}

// ── Run a vibration pattern (blocking) ──────────────────────
void runPattern(int id) {
  if (id < 0 || id > 4) return;
  const Pulse* p = PATTERNS[id];
  for (int i = 0; i < 5; i++) {
    if (p[i].reps == 0) break;
    for (int r = 0; r < p[i].reps; r++) {
      digitalWrite(VIBRATION_PIN, HIGH);
      delay(p[i].onMs);
      digitalWrite(VIBRATION_PIN, LOW);
      if (p[i].offMs > 0) delay(p[i].offMs);
    }
  }
}

// ── Startup Vibration Sequence ───────────────────────────────
// Plays a distinctive triple-escalating buzz so the user knows
// the board is alive and initialising successfully.
void startupVibrationSequence() {
  // Three escalating pulses: short → medium → long
  // Pulse 1: 60 ms
  digitalWrite(VIBRATION_PIN, HIGH); delay(60);
  digitalWrite(VIBRATION_PIN, LOW);  delay(120);
  // Pulse 2: 120 ms
  digitalWrite(VIBRATION_PIN, HIGH); delay(120);
  digitalWrite(VIBRATION_PIN, LOW);  delay(120);
  // Pulse 3: 250 ms (firm confirmation)
  digitalWrite(VIBRATION_PIN, HIGH); delay(250);
  digitalWrite(VIBRATION_PIN, LOW);  delay(80);
}

// ── LED State Update (call every loop iteration) ─────────────
// Implements non-blocking blink logic for ADVERTISING state and
// solid colours for all other states.
void updateLED() {
  unsigned long now = millis();

  switch (boardState) {

    case STATE_BOOTING:
      // Solid white while booting
      setLED(true, true, true);
      break;

    case STATE_ADVERTISING:
      // Slow blue blink: 1 s on / 1 s off  →  "searching for host"
      if (now - lastBlinkTime >= BLINK_INTERVAL_MS) {
        lastBlinkTime = now;
        blinkLedState = !blinkLedState;
      }
      setLED(false, false, blinkLedState);  // blue only
      break;

    case STATE_CONNECTED:
      // Solid green  →  "all good, connected"
      setLED(false, true, false);
      break;

    case STATE_LOW_BATTERY:
      // Fast amber (red + green) blink: 300 ms on/off  →  "charge me"
      if (now - lastBlinkTime >= 300) {
        lastBlinkTime = now;
        blinkLedState = !blinkLedState;
      }
      setLED(blinkLedState, blinkLedState, false);  // amber = R+G
      break;

    case STATE_BLE_ERROR:
      // Solid red  →  fatal, needs reflash / reset
      setLED(true, false, false);
      break;
  }
}

// ── Setup ────────────────────────────────────────────────────
void setup() {
  // ── LED init (ACTIVE LOW — start with all OFF) ──────────────
  pinMode(LED_R, OUTPUT); digitalWrite(LED_R, HIGH);
  pinMode(LED_G, OUTPUT); digitalWrite(LED_G, HIGH);
  pinMode(LED_B, OUTPUT); digitalWrite(LED_B, HIGH);

  boardState = STATE_BOOTING;
  updateLED();  // solid white immediately

  // ── Motor init ──────────────────────────────────────────────
  pinMode(VIBRATION_PIN, OUTPUT);
  digitalWrite(VIBRATION_PIN, LOW);

  // ── Serial (optional — remove for battery-only use) ─────────
  Serial.begin(115200);
  unsigned long t = millis();
  while (!Serial && millis() - t < 2000) {}

  // ── Startup Vibration UX ────────────────────────────────────
  // Runs while LED is still solid white so user gets both
  // tactile + visual confirmation that the board is alive.
  Serial.println("Startup vibration sequence...");
  startupVibrationSequence();

  // ── BLE Init ────────────────────────────────────────────────
  if (!BLE.begin()) {
    Serial.println("ERROR: BLE init failed!");
    boardState = STATE_BLE_ERROR;
    updateLED();  // solid red

    // Distress pattern: rapid vibro + red LED forever
    while (1) {
      digitalWrite(VIBRATION_PIN, HIGH); delay(50);
      digitalWrite(VIBRATION_PIN, LOW);  delay(200);
    }
  }

  // Advertise device
  BLE.setLocalName("TouchAssayArmband");
  BLE.setAdvertisedService(hapticService);

  // Add characteristics to service
  hapticService.addCharacteristic(patternChar);
  hapticService.addCharacteristic(batteryChar);

  // Add service to BLE stack
  BLE.addService(hapticService);

  // Set initial values
  patternChar.writeValue(0);
  batteryChar.writeValue(readBatteryPercent());

  // Start advertising
  BLE.advertise();
  boardState = STATE_ADVERTISING;
  Serial.println("BLE Haptic Armband ready. Advertising...");

  // BLE-ready confirmation: double-tap vibration
  runPattern(1);
}

// ── Loop ─────────────────────────────────────────────────────
unsigned long lastBatteryUpdate = 0;
const unsigned long BATTERY_INTERVAL_MS = 30000; // 30 s

void loop() {
  // Keep LED updated on every iteration (non-blocking blink logic)
  updateLED();

  BLEDevice central = BLE.central();

  if (central) {
    Serial.print("Connected to: ");
    Serial.println(central.address());

    boardState = STATE_CONNECTED;
    updateLED();        // immediately show solid green
    runPattern(0);      // single tap on connect

    while (central.connected()) {
      updateLED();      // keep running blink/solid logic

      // Handle pattern commands
      if (patternChar.written()) {
        int id = patternChar.value();
        Serial.print("Pattern: "); Serial.println(id);
        runPattern(id);
      }

      // Periodic battery update
      unsigned long now = millis();
      if (now - lastBatteryUpdate > BATTERY_INTERVAL_MS) {
        int pct = readBatteryPercent();
        batteryChar.writeValue(pct);
        Serial.print("Battery: "); Serial.print(pct); Serial.println("%");
        lastBatteryUpdate = now;

        // Low battery — change LED state + haptic alert
        if (pct < 15) {
          boardState = STATE_LOW_BATTERY;
          runPattern(3);  // SOS pattern
        } else {
          boardState = STATE_CONNECTED;  // restore green if recovered
        }
      }
    }

    // Central disconnected
    Serial.println("Disconnected.");
    boardState = STATE_ADVERTISING;  // back to blue blink
    updateLED();
    runPattern(4);  // rapid buzz on disconnect
  }
}

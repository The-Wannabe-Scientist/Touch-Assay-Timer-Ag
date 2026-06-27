// ============================================================
//  haptic_test.ino  —  DRV2605L Vibration Pattern Test
//  Board: Seeed XIAO BLE nRF52840
//  Hardware: DRV2605L haptic driver (I²C) + LRA or ERM motor
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
//    R anode → 220Ω → D6
//    G anode → 220Ω → D7
//    B anode → 220Ω → D8
//    Cathode → GND
//    Green = init OK.  Red = DRV2605L not found.
// ============================================================

#include <Wire.h>
#include <Adafruit_DRV2605.h>

Adafruit_DRV2605 drv;

// ── Motor type validation ────────────────────────────────────
#if defined(MOTOR_LRA) && defined(MOTOR_ERM)
  #error "Define only one of MOTOR_LRA or MOTOR_ERM, not both."
#endif
#if !defined(MOTOR_LRA) && !defined(MOTOR_ERM)
  #error "Define either MOTOR_LRA or MOTOR_ERM at the top of this file."
#endif

// ── DRV2605L EN pin (clone boards only) ─────────────────────
// Clone DRV2605L breakout boards float EN low, disabling OUTP/OUTN.
// Connect EN → D3 on the XIAO and the firmware drives it HIGH.
// If you hardwire EN to 3.3V instead, comment out this define.
#define DRV_EN_PIN D3

// ── External RGB LED (optional) ──────────────────────────────
// Comment out USE_EXTERNAL_RGB to disable.
// Uncomment EXT_RGB_COMMON_ANODE if your LED is common-anode.
#define USE_EXTERNAL_RGB
// #define EXT_RGB_COMMON_ANODE

#ifdef USE_EXTERNAL_RGB
  #define EXT_LED_R D6
  #define EXT_LED_G D7
  #define EXT_LED_B D8
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
  void initExtLED() {
    #ifdef EXT_RGB_COMMON_ANODE
      pinMode(EXT_LED_R, OUTPUT); digitalWrite(EXT_LED_R, HIGH); // OFF
      pinMode(EXT_LED_G, OUTPUT); digitalWrite(EXT_LED_G, HIGH);
      pinMode(EXT_LED_B, OUTPUT); digitalWrite(EXT_LED_B, HIGH);
    #else
      pinMode(EXT_LED_R, OUTPUT); digitalWrite(EXT_LED_R, LOW);  // OFF
      pinMode(EXT_LED_G, OUTPUT); digitalWrite(EXT_LED_G, LOW);
      pinMode(EXT_LED_B, OUTPUT); digitalWrite(EXT_LED_B, LOW);
    #endif
  }
#else
  inline void setExtLED(bool, bool, bool) {}
  void initExtLED() {}
#endif

// ── DRV2605L motor init (LRA) ────────────────────────────────
#ifdef MOTOR_LRA
void initMotor() {
  // Library 6 = LRA waveform library
  drv.selectLibrary(6);

  // Set N_ERM_LRA bit (0x1A bit 7 = 1 → LRA mode)
  drv.writeRegister8(0x1A, drv.readRegister8(0x1A) | 0x80);

  // Enable closed-loop auto-resonance (0x1D bit 2 = LRA_OPEN_LOOP; clear = closed-loop)
  drv.writeRegister8(0x1D, drv.readRegister8(0x1D) & ~0x04);

  // RATED_VOLTAGE: 1.8V RMS × 255 / 5.3 ≈ 87 = 0x57
  // Adjust if your LRA has a different rated voltage.
  drv.writeRegister8(0x16, 0x57);

  // OD_CLAMP: 2.1V × 255 / 5.6 ≈ 96 = 0x60  (≈17% above rated)
  drv.writeRegister8(0x17, 0x60);

  // Auto-calibration — populates A_CAL_COMP (0x18) and A_CAL_BEMF (0x19)
  drv.setMode(DRV2605_MODE_AUTOCAL);
  drv.go();
  unsigned long calStart = millis();
  while ((drv.readRegister8(0x0C) & 0x01) && (millis() - calStart < 2000)) {
    delay(10);
  }
  if (drv.readRegister8(0x00) & 0x08) {
    Serial.println("WARNING: LRA auto-calibration failed. Check motor wiring and voltage values.");
  } else {
    Serial.println("LRA auto-calibration complete.");
  }
  Serial.print("  A_CAL_COMP (0x18): 0x"); Serial.println(drv.readRegister8(0x18), HEX);
  Serial.print("  A_CAL_BEMF (0x19): 0x"); Serial.println(drv.readRegister8(0x19), HEX);

  drv.setMode(DRV2605_MODE_INTTRIG);
  Serial.println("DRV2605L initialised: LRA closed-loop mode.");
}
#endif

// ── DRV2605L motor init (ERM) ────────────────────────────────
#ifdef MOTOR_ERM
void initMotor() {
  // Library 1 = ERM waveform library
  drv.selectLibrary(1);

  // ERM mode helper (clears N_ERM_LRA bit 7 of 0x1A)
  drv.useERM();

  // Open-loop ERM: set ERM_OPEN_LOOP bit (0x1D bit 5 = 1)
  // Recommended for coin ERMs — closed-loop back-EMF tracking causes 0V output
  // on many small motors due to noisy or weak back-EMF signal.
  drv.writeRegister8(0x1D, drv.readRegister8(0x1D) | 0x20);

  // RATED_VOLTAGE: 3.0V × 255 / 5.3 ≈ 144 = 0x90
  // Adjust for your specific ERM motor.
  drv.writeRegister8(0x16, 0x90);

  // OD_CLAMP: 3.3V × 255 / 5.6 ≈ 150 = 0x96
  drv.writeRegister8(0x17, 0x96);

  drv.setMode(DRV2605_MODE_INTTRIG);
  Serial.println("DRV2605L initialised: ERM open-loop mode.");
}
#endif

// ── Drive motor for onMs, silent for offMs, repeated reps times ─
void pulseVibrate(int onMs, int offMs, int reps) {
  for (int i = 0; i < reps; i++) {
    drv.setMode(DRV2605_MODE_REALTIME);
    drv.setRealtimeValue(127); // max amplitude (RTP signed 8-bit: 127 = full scale)
    delay(onMs);
    drv.setRealtimeValue(0);
    drv.setMode(DRV2605_MODE_INTTRIG);
    if (offMs > 0) delay(offMs);
  }
}

void setup() {
  // Init external LED first — gives immediate visual feedback before Serial opens
  initExtLED();

  Serial.begin(115200);
  unsigned long t = millis();
  while (!Serial && millis() - t < 2000) {}

  // ── Enable DRV2605L output stage (EN pin on clone boards) ───
  // Must be driven HIGH before Wire.begin() to ungate the H-bridge output.
  pinMode(DRV_EN_PIN, OUTPUT);
  digitalWrite(DRV_EN_PIN, HIGH);
  delay(10); // allow EN to settle

  Wire.begin();
  Wire.setClock(400000); // 400 kHz Fast Mode

  Serial.println("\nRunning I2C scanner...");
  int nDevices = 0;
  for (byte addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.print("  Found: 0x");
      if (addr < 16) Serial.print("0");
      Serial.println(addr, HEX);
      nDevices++;
    }
  }
  Serial.println(nDevices ? "I2C scan complete.\n" : "No I2C devices found.\n");

  if (!drv.begin()) {
    Serial.println("ERROR: DRV2605L not found! Check I2C wiring (SDA=D4, SCL=D5).");
    setExtLED(true, false, false); // solid red
    while (1);
  }

  initMotor();

  Serial.println("Haptic test ready.");
  setExtLED(false, true, false); // solid green — init OK
}

void loop() {
  // Double-tap pattern
  pulseVibrate(100, 80, 2);
  delay(2000);

  // Long pulse
  pulseVibrate(500, 0, 1);
  delay(2000);
}

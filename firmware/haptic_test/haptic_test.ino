// ============================================================
//  haptic_test.ino  —  DRV2605L Diagnostic + Vibration Test
//  Board: Seeed XIAO BLE nRF52840
//  Hardware: DRV2605L haptic driver (I²C) + ERM coin motor
//
//  ── WHAT THIS DOES ──────────────────────────────────────────
//  1. Dumps all key DRV2605L registers BEFORE and AFTER init.
//  2. Holds RTP output ON continuously for 10 s so you can
//     measure OUT+/OUT- with a multimeter without chasing pulses.
//  3. Prints STATUS register every second during the ON phase.
//
//  ── MOTOR TYPE ──────────────────────────────────────────────
//  Select your motor type by keeping ONE of the two lines below:
// #define MOTOR_LRA   // Linear Resonant Actuator (closed-loop, 1.8V RMS typical)
#define MOTOR_ERM   // Eccentric Rotating Mass coin motor (open-loop, 3V typical)
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
//    R anode → 270Ω → D6
//    G anode → 100Ω → D7
//    B anode → 100Ω → D8
//    Cathode → GND
//    NOTE: Per-channel values. Green/blue Vf ≈ 2.8V — on 3.3V rail, 220Ω
//    leaves barely 2mA. 100Ω gives a proper 5mA brightness.
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


// ── Register dump helper ────────────────────────────────────
void dumpRegisters(const char* label) {
  Serial.println();
  Serial.print("=== Register dump ["); Serial.print(label); Serial.println("] ===");

  uint8_t status  = drv.readRegister8(0x00);
  uint8_t mode    = drv.readRegister8(0x01);
  uint8_t rtpIn   = drv.readRegister8(0x02);
  uint8_t rated   = drv.readRegister8(0x16);
  uint8_t odClamp = drv.readRegister8(0x17);
  uint8_t feedBk  = drv.readRegister8(0x1A); // FEEDBACK_CTRL
  uint8_t ctrl3   = drv.readRegister8(0x1D); // CONTROL3

  Serial.print("  0x00 STATUS       : 0x"); Serial.print(status, HEX);
  Serial.print("  DIAG_RESULT="); Serial.print((status >> 3) & 1);
  Serial.print("  OC_DETECT=");   Serial.print((status >> 4) & 1);
  Serial.print("  OVER_TEMP=");   Serial.println((status >> 5) & 1);

  Serial.print("  0x01 MODE         : 0x"); Serial.print(mode, HEX);
  Serial.print("  STANDBY=");     Serial.print((mode >> 6) & 1);
  Serial.print("  MODE_BITS=");   Serial.println(mode & 0x07);
  // MODE: 0=INTTRIG 1=EXTTRIG_EDGE 2=EXTTRIG_LEVEL 3=PWM 4=AUDIO 5=RTP 6=DIAG 7=AUTOCAL

  Serial.print("  0x02 RTP_INPUT    : 0x"); Serial.println(rtpIn, HEX);

  Serial.print("  0x16 RATED_VOLTAGE: 0x"); Serial.print(rated, HEX);
  Serial.print(" (~"); Serial.print((float)rated * 5.3f / 255.0f, 2); Serial.println(" V)");

  Serial.print("  0x17 OD_CLAMP     : 0x"); Serial.print(odClamp, HEX);
  Serial.print(" (~"); Serial.print((float)odClamp * 5.6f / 255.0f, 2); Serial.println(" V)");

  Serial.print("  0x1A FEEDBACK_CTRL: 0x"); Serial.print(feedBk, HEX);
  Serial.print("  N_ERM_LRA(bit7)="); Serial.println((feedBk >> 7) & 1);
  // 0=ERM, 1=LRA

  Serial.print("  0x1D CONTROL3     : 0x"); Serial.print(ctrl3, HEX);
  Serial.print("  ERM_OPEN_LOOP(bit5)="); Serial.println((ctrl3 >> 5) & 1);
  // ERM_OPEN_LOOP bit5=1 → open-loop (required for small ERMs)
  Serial.println("===========================================");
}

void setup() {
  initExtLED();

  Serial.begin(115200);
  unsigned long t = millis();
  while (!Serial && millis() - t < 2000) {}

  // ── EN pin HIGH before Wire.begin() ─────────────────────────
  pinMode(DRV_EN_PIN, OUTPUT);
  digitalWrite(DRV_EN_PIN, HIGH);
  delay(10);

  Wire.begin();
  Wire.setClock(400000);

  Serial.println("\n>>> DIAGNOSTIC HAPTIC TEST");
  Serial.println("Running I2C scanner...");
  for (byte addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.print("  Found: 0x");
      if (addr < 16) Serial.print("0");
      Serial.println(addr, HEX);
    }
  }
  Serial.println("I2C scan complete.");

  if (!drv.begin()) {
    Serial.println("ERROR: DRV2605L not found!");
    setExtLED(true, false, false);
    while (1);
  }
  Serial.println("DRV2605L responded to begin().");

  dumpRegisters("AFTER begin(), BEFORE manual init");

  // ── ERM open-loop setup — explicit, step by step ─────────────
  Serial.println("\n--- Configuring ERM open-loop ---");

  drv.selectLibrary(1);                    // Library 1 = ERM
  drv.useERM();                            // clear N_ERM_LRA bit

  uint8_t c3 = drv.readRegister8(0x1D);
  c3 |= 0x20;                              // set ERM_OPEN_LOOP bit5
  drv.writeRegister8(0x1D, c3);

  drv.writeRegister8(0x16, 0x90);          // RATED_VOLTAGE ~3.0 V
  drv.writeRegister8(0x17, 0x96);          // OD_CLAMP ~3.3 V

  // Explicitly clear STANDBY (bit6) and set MODE=0 (INTTRIG)
  uint8_t modeReg = drv.readRegister8(0x01);
  modeReg &= ~0x40;  // clear STANDBY
  modeReg &= ~0x07;  // MODE = 0 (INTTRIG)
  drv.writeRegister8(0x01, modeReg);

  dumpRegisters("AFTER manual init");

  // ── Switch to RTP and hold ON for 10 s ───────────────────────
  Serial.println("\n>>> OUTPUT ON — measure OUT+ to GND now.");
  Serial.println(">>> Expect ~3.0 to 3.3 V and motor vibrating.");
  Serial.println();

  drv.setMode(DRV2605_MODE_REALTIME);  // 0x05 = RTP mode
  drv.setRealtimeValue(127);           // 0x7F = max amplitude

  for (int i = 1; i <= 10; i++) {
    delay(1000);
    uint8_t s = drv.readRegister8(0x00);
    uint8_t m = drv.readRegister8(0x01);
    uint8_t r = drv.readRegister8(0x02);
    Serial.print("  t="); Serial.print(i);
    Serial.print("s  STATUS=0x"); Serial.print(s, HEX);
    Serial.print("  MODE=0x");   Serial.print(m, HEX);
    Serial.print("  RTP=0x");    Serial.print(r, HEX);
    if (s & 0x08) Serial.print("  *** DIAG FAULT ***");
    if (m & 0x40) Serial.print("  *** STANDBY ACTIVE ***");
    Serial.println();
  }

  drv.setRealtimeValue(0);
  drv.setMode(DRV2605_MODE_INTTRIG);
  Serial.println("\n>>> Output OFF. Paste the full log above for analysis.");
  setExtLED(false, true, false);
}

void loop() {
  // Diagnostic runs once in setup() — nothing here.
}

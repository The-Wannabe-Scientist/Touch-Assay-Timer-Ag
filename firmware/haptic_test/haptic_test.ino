// ============================================================
//  haptic_test.ino  —  Basic vibration pattern test
//  Board: Seeed XIAO BLE nRF52840
//  Hardware: DRV2605L haptic driver (I²C) + LRA motor
//
//  Wiring (Dual-Voltage OR Loop):
//    DRV2605L SDA → D4 (XIAO I²C SDA)
//    DRV2605L SCL → D5 (XIAO I²C SCL)
//    DRV2605L VIN → Dual-voltage OR loop (5V USB + 3.3V battery via Schottky diodes)
//    DRV2605L GND → GND
//    LRA motor (+) → DRV2605L OUTP
//    LRA motor (−) → DRV2605L OUTN  (observe polarity for LRA!)
//
//  This test sketch mirrors the LRA configuration used in haptic_armband.ino.
//  If auto-calibration prints a WARNING, check motor wiring and register values.
// ============================================================

#include <Wire.h>
#include <Adafruit_DRV2605.h>

Adafruit_DRV2605 drv;

void setup() {
  Serial.begin(115200);
  // L3: Wait for Serial with 2-second timeout (needed on XIAO nRF52840 with mbed core)
  unsigned long t = millis();
  while (!Serial && millis() - t < 2000) {}

  Wire.begin();
  Wire.setClock(400000);  // 400 kHz Fast Mode

  if (!drv.begin()) {
    Serial.println("ERROR: DRV2605L not found! Check I2C wiring (D4=SDA, D5=SCL).");
    while (1);
  }

  // ── LRA-specific register configuration (matches haptic_armband.ino) ──────
  // Step 1: Select LRA ROM waveform library (6 = LRA, not 1 = ERM)
  drv.selectLibrary(6);

  // Step 2: Set N_ERM_LRA bit (Feedback Control register 0x1A, bit 7 = 1 for LRA)
  drv.writeRegister8(0x1A, drv.readRegister8(0x1A) | 0x80);

  // Step 3: Enable closed-loop LRA — clear LRA_OPEN_LOOP bit (Control3 0x1D, bit 2)
  drv.writeRegister8(0x1D, drv.readRegister8(0x1D) & ~0x04);

  // Step 4: Set RATED_VOLTAGE (0x16) — Formula (LRA): V_rms * 255 / 5.3
  //   1.8V RMS → 1.8 * 255 / 5.3 ≈ 87 = 0x57
  drv.writeRegister8(0x16, 0x57);

  // Step 5: Set OD_CLAMP (0x17) — Formula (LRA): V_od * 255 / 5.6
  //   2.1V (~17% above rated) → 2.1 * 255 / 5.6 ≈ 96 = 0x60
  drv.writeRegister8(0x17, 0x60);

  // Step 6: Auto-calibration — measures back-EMF, populates A_CAL_COMP/BEMF
  drv.setMode(DRV2605_MODE_AUTOCAL);
  drv.go();
  unsigned long calStart = millis();
  while ((drv.readRegister8(0x0C) & 0x01) && (millis() - calStart < 2000)) {
    delay(10);
  }
  uint8_t calStatus = drv.readRegister8(0x00);
  if (calStatus & 0x08) {
    Serial.println("WARNING: DRV2605L auto-calibration failed (DIAG_RESULT set).");
    Serial.println("  Check motor wiring and RATED_VOLTAGE/OD_CLAMP values.");
  } else {
    Serial.println("DRV2605L auto-calibration complete.");
  }
  Serial.print("  A_CAL_COMP (0x18): 0x"); Serial.println(drv.readRegister8(0x18), HEX);
  Serial.print("  A_CAL_BEMF (0x19): 0x"); Serial.println(drv.readRegister8(0x19), HEX);

  // Step 7: Internal trigger mode for normal operation
  drv.setMode(DRV2605_MODE_INTTRIG);

  Serial.println("Haptic Armband - DRV2605L LRA Vibration Test");
}

// Drive LRA at full amplitude for onMs, then silent for offMs
void pulseVibrate(int onMs, int offMs, int reps) {
  for (int i = 0; i < reps; i++) {
    drv.setMode(DRV2605_MODE_REALTIME);
    drv.setRealtimeValue(127);  // full LRA amplitude (RTP signed 8-bit: 0=off, 127=max)
    delay(onMs);
    drv.setRealtimeValue(0);
    drv.setMode(DRV2605_MODE_INTTRIG);
    if (offMs > 0) delay(offMs);
  }
}

void loop() {
  // Double-tap pattern
  pulseVibrate(100, 80, 2);
  delay(2000);

  // Long pulse
  pulseVibrate(500, 0, 1);
  delay(2000);
}

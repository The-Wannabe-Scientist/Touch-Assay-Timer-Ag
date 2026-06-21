// ============================================================
//  haptic_test.ino  —  Basic vibration pattern test
//  Board: Seeed XIAO BLE nRF52840
//  Hardware: DRV2605L haptic driver (I²C) + external ERM motor
//
//  Wiring:
//    DRV2605L SDA → D4 (XIAO I²C SDA)
//    DRV2605L SCL → D5 (XIAO I²C SCL)
//    DRV2605L VIN → 3.3V
//    DRV2605L GND → GND
//    ERM motor    → DRV2605L OUTP / OUTN terminals
// ============================================================

#include <Wire.h>
#include <Adafruit_DRV2605.h>

Adafruit_DRV2605 drv;

void setup() {
  Serial.begin(115200);
  Wire.begin();

  if (!drv.begin()) {
    Serial.println("ERROR: DRV2605L not found! Check I2C wiring.");
    while (1);
  }

  drv.selectLibrary(1);              // ERM library (use 6 for LRA motors)
  drv.setMode(DRV2605_MODE_INTTRIG); // internal trigger mode

  Serial.println("Haptic Armband - DRV2605L Vibration Test");
}

// Drive ERM at full amplitude for onMs, then silent for offMs
void pulseVibrate(int onMs, int offMs, int reps) {
  for (int i = 0; i < reps; i++) {
    drv.setMode(DRV2605_MODE_REALTIME);
    drv.setRealtimeValue(127);  // full amplitude (RTP is signed 8-bit: 0 = off, 127 = max)
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

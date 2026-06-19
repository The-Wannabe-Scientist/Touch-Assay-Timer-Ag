// ============================================================
//  haptic_test.ino  —  Basic vibration pattern test
//  Board: Seeed XIAO BLE nRF52840
// ============================================================

#define VIBRATION_PIN D0   // Grove SIG pin → D0

void setup() {
  Serial.begin(115200);
  pinMode(VIBRATION_PIN, OUTPUT);
  digitalWrite(VIBRATION_PIN, LOW);
  Serial.println("Haptic Armband - Vibration Test");
}

void pulseVibrate(int onMs, int offMs, int reps) {
  for (int i = 0; i < reps; i++) {
    digitalWrite(VIBRATION_PIN, HIGH);
    delay(onMs);
    digitalWrite(VIBRATION_PIN, LOW);
    delay(offMs);
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

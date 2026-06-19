# 🦾 BLE Haptic Armband Build Guide

**Components:** Seeed Studio XIAO BLE nRF52840 · WLY602040 3.7V 400mAh LiPo · Seeed Grove Vibration Motor

---

## 📦 Full Bill of Materials

| Component | Qty | Notes |
|---|---|---|
| Seeed Studio XIAO BLE nRF52840 | 1 | **Not** the Sense variant unless you want IMU |
| WLY602040 3.7V 400mAh LiPo battery | 1 | 6×20×40 mm, ~PCM protected |
| Seeed Grove Vibration Motor (v1.2+) | 1 | **Must be v1.2+** — has built-in S9013 transistor |
| Grove to Dupont/Bare-Wire cable | 1 | Or cut a 4-pin Grove cable |
| Elastic armband strap (~30mm wide) | 1 | Nylon or silicone |
| Velcro strip | 1 pair | ~30 mm × 60 mm |
| Small enclosure / 3D-printed shell | 1 | ~50×25×12 mm |
| Kapton tape or hot glue | — | For strain relief & insulation |
| USB-C cable | 1 | For programming & charging |
| **Optional:** On/off toggle switch (SPDT) | 1 | Wired in series on BAT+ line |

**Tools:** Soldering iron + solder, wire strippers, multimeter, Arduino IDE

---

## ⚠️ Critical Safety Notes

> [!CAUTION]
> **LiPo polarity is fatal to the board.** Always verify BAT+ (red wire) and BAT− (black wire) with a multimeter BEFORE soldering. Reversing polarity will instantly destroy the XIAO.

> [!WARNING]
> The Grove Vibration Motor **must be v1.2 or later** (has the S9013 transistor on-board). Earlier v1.0 modules drive the motor directly from the I/O pin and can pull too much current. Check the PCB silkscreen.

> [!NOTE]
> The XIAO nRF52840 runs at **3.3V logic**. The Grove Vibration Motor module accepts 3.0–5.5V on VCC and logic-level signal, so it is fully compatible at 3.3V.

---

## 🗺️ XIAO BLE nRF52840 Pinout Reference

```
         USB-C
    ┌─────────────┐
D0  │ 1         14│ 3.3V
D1  │ 2         13│ GND
D2  │ 3         12│ RST
D3  │ 4         11│ GND (also bottom)
D4/SDA│ 5      10│ BAT- (bottom pad)
D5/SCL│ 6       9│ BAT+ (bottom pad)
D6/TX│ 7        8│ VIN (5V from USB)
    └─────────────┘
```

**Bottom pads (must be soldered for battery):**
- `BAT+` → Red wire of LiPo
- `BAT−` → Black wire of LiPo

---

## 🔌 Wiring Diagram

### Grove Vibration Motor → XIAO BLE

The Grove connector has 4 wires:

| Grove Wire | Color | Connect To | XIAO Pin |
|---|---|---|---|
| Signal (SIG) | Yellow | D0 | Pin 1 |
| NC | White | (leave unconnected) | — |
| VCC | Red | 3.3V pad | Pin 14 |
| GND | Black | GND pad | Pin 13 |

> [!TIP]
> If using a bare-ended Grove cable, strip ~5mm of insulation, tin the ends, and solder directly to the XIAO pads or use a breadboard for prototyping first.

### LiPo Battery → XIAO BLE (bottom pads)

```
  LiPo Red (+)  ──→ BAT+ (bottom pad)
  LiPo Black (−) ──→ BAT− (bottom pad)
```

**Optional power switch:**  
Insert a single-pole switch in series on the BAT+ line:
```
  LiPo Red (+) ──→ [SWITCH] ──→ BAT+
```

---

## 💻 Software Setup

### Step 1 — Install Arduino IDE
Download Arduino IDE 2.x from [arduino.cc](https://www.arduino.cc/en/software).

### Step 2 — Add Seeed Board Package

1. Open **Arduino IDE → Preferences**
2. In *Additional Boards Manager URLs* add:
   ```
   https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json
   ```
3. Go to **Tools → Board → Boards Manager**
4. Search **"seeed nrf52"**, install **Seeed nRF52 mbed-enabled Boards** (recommended — Serial works out of the box)

### Step 3 — Select Board & Port

- **Tools → Board → Seeed nRF52 mbed-enabled Boards → Seeed XIAO nRF52840**
- **Tools → Port → (your USB-C port)**

> [!NOTE]
> If the board is not detected, **double-tap the Reset button**. The orange LED will fade — this is bootloader mode. Try uploading again.

### Step 4 — Install ArduinoBLE Library

1. **Sketch → Include Library → Manage Libraries**
2. Search **"ArduinoBLE"**, click **Install**

---

## 🖥️ Firmware Code

### Basic Standalone Vibration Pattern

This sketch runs a haptic heartbeat pattern on boot — no BLE required. Great for testing wiring.

```cpp
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
```

---

### Full BLE-Controlled Haptic Armband

This is the main firmware. It exposes a **BLE GATT service** with:
- **Characteristic 1** — Trigger a vibration pattern (write 0–4)
- **Characteristic 2** — Battery voltage (read/notify)

```cpp
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
  // 0: Single short tap
  {{50, 0, 1}, {0,0,0}, {0,0,0}, {0,0,0}, {0,0,0}},
  // 1: Double tap
  {{80, 70, 2}, {0,0,0}, {0,0,0}, {0,0,0}, {0,0,0}},
  // 2: Long pulse
  {{600, 0, 1}, {0,0,0}, {0,0,0}, {0,0,0}, {0,0,0}},
  // 3: SOS (··· ─── ···)
  {{100,80,3},{300,80,3},{100,80,3},{0,0,0},{0,0,0}},
  // 4: Rapid buzz
  {{50, 50, 6}, {0,0,0}, {0,0,0}, {0,0,0}, {0,0,0}},
};

// ── Battery Reading ──────────────────────────────────────────
int readBatteryPercent() {
  // Simple voltage divider: 100kΩ from BAT+ to A0, 100kΩ from A0 to GND
  // Full scale 4.2V → 2.1V at A0 → 3.3V ref → ~65% of ADC range
  // Adjust R1/R2 or calibrate for your specific divider
  int raw = analogRead(BATTERY_ADC_PIN);
  float voltage = raw * (3.3f / 1023.0f) * 2.0f;  // ×2 for divider
  // LiPo: 3.0V = 0%, 4.2V = 100%
  int pct = (int)((voltage - 3.0f) / 1.2f * 100.0f);
  return constrain(pct, 0, 100);
}

// ── Run a vibration pattern ──────────────────────────────────
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

// ── Setup ────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  // Wait up to 2s for Serial monitor (remove for battery-only use)
  unsigned long t = millis();
  while (!Serial && millis() - t < 2000) {}

  pinMode(VIBRATION_PIN, OUTPUT);
  digitalWrite(VIBRATION_PIN, LOW);

  // Init BLE
  if (!BLE.begin()) {
    Serial.println("ERROR: BLE init failed!");
    while (1) {
      // Blink vibrate to signal error
      digitalWrite(VIBRATION_PIN, HIGH); delay(50);
      digitalWrite(VIBRATION_PIN, LOW);  delay(200);
    }
  }

  // Advertise device
  BLE.setLocalName("HapticArmband");
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
  Serial.println("BLE Haptic Armband ready. Advertising...");

  // Boot confirmation pulse
  runPattern(1);  // double-tap on boot
}

// ── Loop ─────────────────────────────────────────────────────
unsigned long lastBatteryUpdate = 0;
const unsigned long BATTERY_INTERVAL_MS = 30000; // 30s

void loop() {
  BLEDevice central = BLE.central();

  if (central) {
    Serial.print("Connected to: ");
    Serial.println(central.address());
    runPattern(0);  // single tap on connect

    while (central.connected()) {
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

        // Low battery warning
        if (pct < 15) runPattern(3);  // SOS pattern
      }
    }

    Serial.println("Disconnected.");
    runPattern(4);  // rapid buzz on disconnect
  }
}
```

---

## 📱 Connecting via Phone (No App Needed)

Use **nRF Connect** (iOS/Android) or **LightBlue** (iOS):

1. Open the app → Scan → find **"HapticArmband"**
2. Connect
3. Navigate to the custom service UUID `19B10000-...`
4. Write a **byte value (0–4)** to the Pattern characteristic
5. The armband vibrates the corresponding pattern

| Value | Pattern |
|---|---|
| `0` | Single short tap |
| `1` | Double tap |
| `2` | Long pulse (600 ms) |
| `3` | SOS (··· ─── ···) |
| `4` | Rapid buzz (6×) |

---

## 🏗️ Physical Assembly — Step by Step

### Step 1: Solder Battery to XIAO

1. Tin the `BAT+` and `BAT−` pads on the underside of the XIAO
2. **Verify polarity with multimeter** — red wire measures positive relative to black
3. Solder red wire to `BAT+`, black to `BAT−`
4. Apply Kapton tape over the solder joints for insulation
5. **Optional:** solder the on/off switch in-line on the red wire

### Step 2: Prepare Grove Motor Cable

1. Cut the Grove-to-Grove cable in half, or use a Grove-to-bare-wire cable
2. Strip ~5mm from each wire end
3. Identify: Yellow = SIG, Red = VCC, Black = GND, White = NC
4. Solder:
   - Yellow → D0 pad
   - Red → 3.3V pad
   - Black → GND pad
   - White → leave untouched (tape the end)
5. Hot-glue or Kapton tape wires to XIAO for strain relief

### Step 3: Test Electronics (Before Enclosing)

1. Connect XIAO via USB-C
2. Upload the `haptic_test.ino` sketch first
3. Verify the motor buzzes the double-tap + long-pulse pattern
4. Open Serial Monitor at 115200 baud to confirm messages
5. Then upload `haptic_armband.ino` and test BLE from your phone

### Step 4: Enclosure

**Option A — 3D Printed Shell (Recommended)**
- Print a 50×25×12mm box with snap-fit lid
- Add cutouts for: USB-C port, optional power switch, motor wire exit
- Dimensions to fit XIAO (21×17.5 mm) + LiPo (6×20×40 mm) side-by-side

**Option B — Heat-Shrink / Fabric Pouch**
- Wrap in bubble foam, slide into a sewn nylon pouch
- Velcro the pouch to the strap

### Step 5: Attach to Armband

1. Cut elastic strap to wrist circumference + ~40mm overlap
2. Sew or glue Velcro: loop side on one strap end, hook side on the other
3. Attach enclosure to the center of the strap using:
   - Hook-and-loop (removable, for charging)
   - Double-sided foam tape (permanent)
4. Route the vibration motor cable alongside the strap
5. Position the vibration motor disc at the underside (skin-contact face) of the band for best haptic sensation

### Step 6: Charging

1. Remove the enclosure from the strap (or expose the USB-C port)
2. Plug in any USB-C cable
3. The **orange CHG LED** on the XIAO will illuminate during charging
4. LED turns **off** when fully charged (~1.5–2 hours for 400mAh)
5. Charge current is ~50mA by default (safe for the 400mAh cell)

---

## 🔋 Estimated Battery Life

| Usage | Estimated Runtime |
|---|---|
| BLE advertising + idle | ~18–22 hours |
| BLE connected + occasional vibrations | ~10–14 hours |
| Continuous vibration (worst case) | ~2–3 hours |

---

## 🐛 Troubleshooting

| Issue | Solution |
|---|---|
| Board not detected in Arduino IDE | Double-tap Reset; use USB-C **data** cable (not charge-only) |
| Upload fails | Select mbed-enabled board package; check port selection |
| Motor doesn't vibrate | Check SIG wire on D0; verify VCC is 3.3V; probe with multimeter |
| BLE doesn't advertise | Call `BLE.begin()` before any other BLE function |
| Serial Monitor blank | Add `while(!Serial){}` with timeout; use mbed board package |
| Battery draining fast | Add `delay()` in loop; use `BLE.poll()` instead of blocking |
| Vibration feels weak at 3.3V | Power motor VCC from VIN (5V from USB) only when plugged in; not available from battery |

---

## ⚡ Power Optimization (for extended battery life)

Add these to your sketch for production use:

```cpp
#include <ArduinoBLE.h>

// Low-power advertising interval (saves ~15% power vs default)
void setup() {
  // ...
  BLE.setAdvertisingInterval(800);  // 500ms (units of 0.625ms)
  // ...
}

// In loop — use BLE.poll() instead of BLE.central() blocking
void loop() {
  BLE.poll(1000);  // poll with 1s timeout, CPU can sleep between
  // ...
}
```

For deep-sleep between events (advanced), use the `nrf52` SDK sleep calls or the `Adafruit_nRF52_Arduino` sleep library.

---

## 📐 Enclosure Dimensions Guide

```
┌──────────────────────────────────────┐
│         50mm × 25mm × 12mm           │
│                                      │
│  ┌────────┐  ┌───────────────────┐  │
│  │  XIAO  │  │   LiPo Battery    │  │
│  │21×17mm │  │   6×20×40mm       │  │
│  └────────┘  └───────────────────┘  │
│                                      │
│  ← USB-C cutout on short end →       │
│  ← Motor wire exit on long side →    │
└──────────────────────────────────────┘
```

Place the **vibration motor disc** external to the enclosure on the skin-facing side, attached with adhesive foam tape.

---

*Build time estimate: ~2–3 hours including soldering, programming, and assembly.*

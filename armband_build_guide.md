# 🦾 BLE Haptic Armband Build Guide

**Components:** Seeed Studio XIAO BLE nRF52840 · WLY602040 3.7V 400mAh LiPo · DRV2605L Haptic Driver · External ERM or LRA Vibration Motor

---

## 📦 Full Bill of Materials

| Component | Qty | Notes |
|---|---|---|
| Seeed Studio XIAO BLE nRF52840 | 1 | **Not** the Sense variant unless you want IMU |
| WLY602040 3.7V 400mAh LiPo battery | 1 | 6×20×40 mm, ~PCM protected |
| DRV2605L Haptic Motor Driver breakout | 1 | Adafruit #2305 or equivalent; I²C, 3.3V-compatible |
| External ERM or LRA vibration motor | 1 | 3V ERM (e.g. coin motor) or LRA (e.g. Z-axis linear actuator) |
| 1N5819 Schottky Diode | 2 | For dual-voltage OR loop to prevent brownouts |
| 10µF to 100µF Capacitor | 1 | Electrolytic or ceramic. Decoupling capacitor across DRV2605L VIN/GND |
| 4× pin header / jumper wires (female–female) | — | For SDA, SCL, VIN, GND from XIAO to DRV2605L breakout |
| 2× thin motor leads (~5 cm) | — | Solder from DRV2605L OUTP/OUTN pads to motor terminals |
| Elastic armband strap (~30mm wide) | 1 | Nylon or silicone |
| Velcro strip | 1 pair | ~30 mm × 60 mm |
| Small enclosure / 3D-printed shell | 1 | ~55×25×14 mm (slightly deeper to fit DRV2605L breakout) |
| Kapton tape or hot glue | — | For strain relief & insulation |
| USB-C cable | 1 | For programming & charging |
| **Optional:** On/off toggle switch (SPDT) | 1 | Wired in series on BAT+ line |

**Tools:** Soldering iron + solder, wire strippers, multimeter, Arduino IDE

---

## ⚠️ Critical Safety Notes

> [!CAUTION]
> **LiPo polarity is fatal to the board.** Always verify BAT+ (red wire) and BAT− (black wire) with a multimeter BEFORE soldering. Reversing polarity will instantly destroy the XIAO.

> [!WARNING]
> The DRV2605L is a **dedicated haptic driver IC** — do NOT connect the motor directly to any GPIO pin. The DRV2605L controls motor current via its internal H-bridge; the GPIO pins of the XIAO can only handle 4 mA and will be damaged or produce very weak vibration if used directly.

> [!NOTE]
> The XIAO nRF52840 runs at **3.3V logic**. The DRV2605L breakout board (Adafruit #2305) includes a 3.3V regulator and level-shifter, so it accepts both 3.3V and 5V power on VIN — power it from the XIAO **3.3V** pad.

> [!TIP]
> The DRV2605L I²C address is fixed at **0x5A**. If you use another I²C device (e.g. an IMU), ensure there is no address conflict.

---

## 🗺️ XIAO BLE nRF52840 Pinout Reference

```
         USB-C
    ┌─────────────┐
D0  │ 1         14│ 3.3V
D1  │ 2         13│ GND
D2  │ 3         12│ RST
D3  │ 4         11│ GND (also bottom)
D4/SDA│ 5      10│ BAT- (bottom pad)  ← verify against official Seeed schematic
D5/SCL│ 6       9│ BAT+ (bottom pad)  ← verify against official Seeed schematic
D6/TX│ 7        8│ VIN (5V from USB)
    └─────────────┘
```

**Bottom pads (must be soldered for battery):**
- `BAT+` → Red wire of LiPo
- `BAT−` → Black wire of LiPo

---

## 🔌 Wiring Diagram

### DRV2605L Haptic Driver → XIAO BLE (Dual-Voltage OR Loop)

To prevent the motor from causing voltage drops (brownouts) on the 3.3V line when running, we use a dual-voltage OR loop with two 1N5819 Schottky diodes. This allows the driver to pull from the 5V USB line when plugged in, and gracefully fall back to 3.3V battery power when unplugged.

| DRV2605L Pin | Connect To | XIAO Pin |
|---|---|---|
| VIN | Diode OR Loop Output | Pin 8 (5V) & Pin 14 (3.3V) |
| GND | GND pad | Pin 13 |
| SDA | D4/SDA | Pin 5 |
| SCL | D5/SCL | Pin 6 |
| OUTP | Motor (+) terminal | — |
| OUTN | Motor (−) terminal | — |

**OR Loop & Power Wiring:**
- Connect the **Anode** of Diode 1 to XIAO **Pin 8 (5V)**.
- Connect the **Anode** of Diode 2 to XIAO **Pin 14 (3.3V)**.
- Twist both **Cathodes** (the striped ends) together and connect them to DRV2605L **VIN**.
- Connect a **10µF to 100µF capacitor** directly across the DRV2605L **VIN** and **GND** pins. *(If using polarized electrolytic, positive leg to VIN, negative to GND).*

> [!TIP]
> Use short (~5 cm) silicone-insulated wires between the DRV2605L OUTP/OUTN pads and the motor leads. Twist the two motor wires together to minimise EMI and strain on the solder joints.

> [!NOTE]
> Many ERM coin motors have **no polarity marking** — reversing OUTP/OUTN only changes spin direction and has no electrical impact. If your motor doesn't spin, swap the two motor leads. **Note:** LRA motors often DO have polarity. If your LRA is marked +/-, connect + to OUTP and - to OUTN.

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

### Complete Wiring at a Glance

```text
  ┌────────────────┐                        ┌──────────────────┐
  │  XIAO nRF52840 │                        │   DRV2605L       │
  │                │                        │                  │
  │   5V VIN (8) ──┼───[>| 1N5819 ]────┐    │                  │
  │                │                   ├───┼─ VIN              │
  │   3.3V  (14) ──┼───[>| 1N5819 ]────┘    │  │               │
  │                │                        │  ┴ 10-100µF Cap  │
  │    GND  (13) ──┼────────────────────────┼─ GND             │
  │  D4/SDA  (5) ──┼────────────────────────┼─ SDA             │
  │  D5/SCL  (6) ──┼────────────────────────┼─ SCL             │
  │                │                        │                  │
  │                │                        │  OUTP ───────────┼──→ Motor (+)
  │                │                        │  OUTN ───────────┼──→ Motor (−)
  └────────────────┘                        └──────────────────┘
        │
  BAT+ (bottom) ──→ LiPo Red (+)
  BAT− (bottom) ──→ LiPo Black (−)
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

### Step 4 — Install Required Libraries

You need **two** libraries:

#### ArduinoBLE
1. **Sketch → Include Library → Manage Libraries**
2. Search **"ArduinoBLE"**, click **Install**

#### Adafruit DRV2605 Library
1. **Sketch → Include Library → Manage Libraries**
2. Search **"Adafruit DRV2605"**, click **Install**
3. When prompted to install dependencies, click **Install All** (installs Adafruit BusIO)

> [!IMPORTANT]
> Both libraries are required. The sketch will fail to compile without `Adafruit_DRV2605.h` and `Adafruit_BusIO`.

---

## 🖥️ Firmware Code

### Basic Standalone Vibration Pattern

This sketch runs a haptic heartbeat pattern on boot — no BLE required. Great for testing wiring.

```cpp
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
```

---

### Full BLE-Controlled Haptic Armband

This is the main firmware. It exposes a **BLE GATT service** that the Touch Assay Timer web app connects to. The DRV2605L is controlled over I²C using real-time playback (RTP) mode for precise custom pulse durations.

See [`firmware/haptic_armband/haptic_armband.ino`](./firmware/haptic_armband/haptic_armband.ino) for the complete sketch — summarised key points below:

| Feature | Implementation |
|---|---|
| Motor driver | DRV2605L via I²C (Wire.h + Adafruit_DRV2605) |
| Vibration control | `drv.setMode(DRV2605_MODE_REALTIME)` + `setRealtimeValue(127)` |
| Amplitude | 127 = full rated amplitude (RTP is signed 8-bit, not unsigned) |
| Motor library | ERM = `drv.selectLibrary(1)`; LRA = `drv.selectLibrary(6)` |
| BLE service UUID | `12345678-1234-1234-1234-123456789012` |
| Tap command | Write `0x01` to haptic characteristic → 50 ms pulse |
| Run complete | Write `0x02` → ascending 100 ms + 200 ms pattern |
| Heartbeat watchdog | No HB for >3 s → 3× stutter pattern |

> [!TIP]
> To increase vibration intensity, raise the `setRealtimeValue()` argument (max 255). Start at 127 and adjust to taste — higher values draw more current but feel stronger.

---

## 🔋 DRV2605L Driver Notes

### ERM vs LRA Motor Selection

The DRV2605L supports two motor types:

| Motor Type | Library Constant | `selectLibrary()` |
|---|---|---|
| **ERM** (coin/pager, DC motor) | `DRV2605_LIBRARY_ERM_CLOSED_LOOP` | `drv.selectLibrary(1)` |
| **LRA** (linear resonant actuator) | `DRV2605_LIBRARY_LRA` | `drv.selectLibrary(6)` |

This firmware targets **LRA motors** (library 6) in closed-loop auto-resonance mode by default. If you use an ERM motor instead, change `drv.selectLibrary(6)` to `drv.selectLibrary(1)` and remove the `N_ERM_LRA` (0x1A bit 7) and `LRA_OPEN_LOOP` (0x1D bit 2) register writes in `setup()`. For reference, here is the correct LRA configuration block:

```cpp
  drv.selectLibrary(6); // 6 = LRA library

  // Set N_ERM_LRA bit (register 0x1A, bit 7): 1 = LRA, 0 = ERM
  // NOTE: drv.useLRA() does NOT exist in the Adafruit library — use the
  // raw register write below.
  drv.writeRegister8(0x1A, drv.readRegister8(0x1A) | 0x80);

  // Enable closed-loop auto-resonance (register 0x1D, bit 2 = LRA_OPEN_LOOP)
  // Clear bit → closed-loop ON (tracks motor's true resonant frequency)
  drv.writeRegister8(0x1D, drv.readRegister8(0x1D) & ~0x04);

  // Set Rated Voltage & Overdrive Clamp for your specific LRA
  // Formula: value = V_rms * 255 / (1.8 * sqrt(2)) = V_rms * 255 / 2.5456
  // (Values below are examples for a 1.8V RMS rated LRA)
  drv.writeRegister8(DRV2605_REG_RATEDV, 0xB4); // ≈ 1.8V RMS
  // NOTE: DRV2605_REG_CLAMPV is NOT defined in the Adafruit library — use
  // the raw register address 0x17 for the OD_CLAMP register.
  drv.writeRegister8(0x17, 0x89);               // ≈ 3.0V overdrive clamp
```

### Waveform ROM Effects (Alternative to RTP)

The DRV2605L includes 123 pre-programmed haptic waveforms in ROM. These run entirely in hardware (no `delay()` needed) and are ideal for consistent, timed patterns. Example:
```cpp
// Play ROM effect #14 (sharp click) then stop
drv.setWaveform(0, 14);  // slot 0: effect #14
drv.setWaveform(1, 0);   // slot 1: end
drv.go();
```
See the [DRV2605L datasheet](https://www.ti.com/lit/ds/symlink/drv2605l.pdf) for the full effect library table.

---

## 🚥 LED and Vibration Signals Reference

The armband provides hardware-level feedback via the onboard RGB LED and the vibration motor to indicate its current state.

**Visual Indicators (XIAO Onboard RGB LED):**
- **Booting up:** Solid White
- **Advertising / Waiting to connect:** Slow Blue Blink
- **Connected:** Solid Green
- **Low Battery (< 15%):** Fast Amber (Red+Green) Blink
- **Fatal Error:** Solid Red

**Vibration Patterns:**
- **Boot Sequence:** Three escalating pulses (alive confirmation)
- **BLE Ready / Advertising:** Double tap
- **Connected:** Single tap
- **Disconnected:** Rapid buzz (6 quick pulses)
- **Low Battery:** SOS pattern (··· ─── ···)
- **Fatal Error:** Rapid infinite pulsing

---

## 📱 Connecting via Phone (No App Needed)

Use **nRF Connect** (iOS/Android) or **LightBlue** (iOS):

1. Open the app → Scan → find **"TouchAssayArmband"**
2. Connect
3. Navigate to the custom service UUID `12345678-1234-1234-1234-123456789012`
4. Write a **byte value** to the Haptic characteristic:

| Value | Pattern |
|---|---|
| `0x01` | Single tap (50 ms) |
| `0x02` | Run complete (100 ms pause 200 ms) |

---

## 🏗️ Physical Assembly — Step by Step

### Step 1: Solder Battery to XIAO

1. Tin the `BAT+` and `BAT−` pads on the underside of the XIAO
2. **Verify polarity with multimeter** — red wire measures positive relative to black
3. Solder red wire to `BAT+`, black to `BAT−`
4. Apply Kapton tape over the solder joints for insulation
5. **Optional:** solder the on/off switch in-line on the red wire

### Step 2: Connect DRV2605L to XIAO

1. Build the Dual-Voltage OR Loop for **VIN**:
   - Solder the anode (non-striped end) of a 1N5819 diode to XIAO **Pin 8 (5V)**.
   - Solder the anode of a second 1N5819 diode to XIAO **Pin 14 (3.3V)**.
   - Join the cathodes (striped ends) of both diodes and connect to DRV2605L **VIN**.
2. Add a **Decoupling Capacitor**:
   - Solder a 10µF–100µF capacitor across the **VIN** and **GND** pins on the DRV2605L. (Positive to VIN, negative to GND).
3. Connect the remaining pins with short wires:
   - DRV2605L **GND** → XIAO **GND** (pin 13)
   - DRV2605L **SDA** → XIAO **D4** (pin 5)
   - DRV2605L **SCL** → XIAO **D5** (pin 6)
4. Secure the DRV2605L breakout flat against the XIAO with double-sided foam tape
5. Apply hot glue or Kapton tape for extra strain relief on the wires

### Step 3: Attach Motor to DRV2605L

1. Strip ~5 mm from each motor lead
2. Tin both leads and the DRV2605L **OUTP** and **OUTN** pads
3. Solder motor leads to OUTP and OUTN. (For ERMs, polarity only affects spin direction. For LRAs, observe +/- markings if present).
4. Apply a small drop of hot glue at the solder joint for strain relief
5. Twist the two motor leads together to reduce EMI

### Step 4: Test Electronics (Before Enclosing)

1. Connect XIAO via USB-C
2. Upload the `haptic_test.ino` sketch first
3. Open **Serial Monitor at 115200 baud** — confirm "DRV2605L Vibration Test" appears
4. Verify the motor buzzes the double-tap + long-pulse pattern
5. If Serial prints "ERROR: DRV2605L not found!" — check SDA/SCL wiring and ensure `Wire.begin()` is called
6. Then upload `haptic_armband.ino` and test BLE from your phone

> [!TIP]
> If the motor makes noise but doesn't vibrate strongly, increase `setRealtimeValue()` from 127 toward 200 in `haptic_test.ino`. If there is no response at all, check the OUTP/OUTN solder joints with a multimeter (should read ~3 V when active).

### Step 5: Enclosure

**Option A — 3D Printed Shell (Recommended)**
- Print a 55×25×14mm box with snap-fit lid
- Add cutouts for: USB-C port, optional power switch, motor wire exit
- Dimensions to fit XIAO (21×17.5 mm) + DRV2605L breakout (~20×20 mm) + LiPo (6×20×40 mm)

**Option B — Heat-Shrink / Fabric Pouch**
- Wrap in bubble foam, slide into a sewn nylon pouch
- Velcro the pouch to the strap

### Step 6: Attach to Armband

1. Cut elastic strap to wrist circumference + ~40mm overlap
2. Sew or glue Velcro: loop side on one strap end, hook side on the other
3. Attach enclosure to the center of the strap using:
   - Hook-and-loop (removable, for charging)
   - Double-sided foam tape (permanent)
4. Route the motor cable alongside the strap
5. Position the motor at the underside (skin-contact face) of the band for best haptic sensation — attach with a small adhesive foam pad

### Step 7: Charging

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
| Serial: "DRV2605L not found!" | Check SDA→D4 and SCL→D5; confirm VIN=3.3V and GND connected; verify `Wire.begin()` is called before `drv.begin()` |
| Motor doesn't vibrate | Check OUTP/OUTN solder joints; confirm DRV2605L enumerated on Serial; try swapping motor leads |
| Motor vibrates but very weakly | Increase `setRealtimeValue()` argument (e.g. 200); ensure motor coil resistance ~1–1.5Ω |
| BLE doesn't advertise | Call `BLE.begin()` before any other BLE function |
| Serial Monitor blank | Add `while(!Serial){}` with timeout; use mbed board package |
| Battery draining fast | Add `delay()` in loop; use `BLE.poll()` instead of blocking |
| Compile error: Adafruit_DRV2605.h not found | Install "Adafruit DRV2605" library + dependencies via Library Manager |

---

## ⚡ Power Optimization (for extended battery life)

Add these to your sketch for production use:

```cpp
#include <ArduinoBLE.h>

// Low-power advertising interval (saves ~15% power vs default)
void setup() {
  // ...
  BLE.setAdvertisingInterval(800);  // = 500 ms (BLE spec unit = 0.625 ms; 800 × 0.625 ms = 500 ms)
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
│         55mm × 25mm × 14mm           │
│                                      │
│  ┌──────┐  ┌───────┐  ┌──────────┐  │
│  │ XIAO │  │DRV2605│  │  LiPo    │  │
│  │21×17mm│ │~20×20mm│ │6×20×40mm │  │
│  └──────┘  └───────┘  └──────────┘  │
│                                      │
│  ← USB-C cutout on short end →       │
│  ← Motor wire exit on long side →    │
└──────────────────────────────────────┘
```

Place the **ERM motor disc** external to the enclosure on the skin-facing side, attached with adhesive foam tape or a 3D-printed motor pocket.

---

*Build time estimate: ~2–3 hours including soldering, programming, and assembly.*

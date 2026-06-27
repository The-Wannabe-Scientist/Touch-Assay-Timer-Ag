# 🦾 BLE Haptic Armband Build Guide

**Components:** Seeed Studio XIAO BLE nRF52840 · WLY602040 3.7V 400mAh LiPo · DRV2605L Haptic Driver · LRA or ERM Vibration Motor

---

## 📦 Bill of Materials

| Component | Qty | Notes |
|---|---|---|
| Seeed Studio XIAO BLE nRF52840 | 1 | **Not** the Sense variant unless you want the IMU |
| WLY602040 3.7V 400mAh LiPo battery | 1 | 6×20×40 mm, PCM protected |
| DRV2605L Haptic Motor Driver breakout | 1 | Adafruit #2305 or clone; I²C, 3.3V-compatible |
| **Option A:** LRA motor, 1.8V RMS | 1 | Z-axis linear resonant actuator (e.g. Jinlong G0832012D). Observe +/− polarity. |
| **Option B:** ERM coin motor, 3V | 1 | Eccentric rotating mass (standard coin vibration motor). No strict polarity. |
| 1N5819 Schottky Diode | 2 | Dual-voltage OR loop for DRV2605L VIN |
| 10µF–100µF Capacitor | 1 | Decoupling cap across DRV2605L VIN/GND |
| **Optional:** External RGB LED (common-cathode) | 1 | For visible status outside enclosure. See wiring below. |
| 220Ω resistor | 3 | One per LED colour channel (only if using external RGB LED) |
| Jumper wires / pin headers | — | SDA, SCL, VIN, GND, EN from XIAO to DRV2605L |
| Thin motor leads (~5 cm) | 2 | Solder to DRV2605L OUTP / OUTN |
| Elastic armband strap (~30 mm wide) | 1 | Nylon or silicone |
| Velcro strip | 1 pair | ~30 mm × 60 mm |
| Small enclosure / 3D-printed shell | 1 | ~55×25×14 mm |
| Kapton tape or hot glue | — | Strain relief & insulation |
| USB-C cable | 1 | Programming & charging |
| **Optional:** SPDT on/off switch | 1 | Wired in series on BAT+ line |

**Tools:** Soldering iron + solder, wire strippers, multimeter, Arduino IDE

---

## ⚠️ Critical Safety Notes

> [!CAUTION]
> **LiPo polarity is fatal to the board.** Always verify BAT+ (red) and BAT− (black) with a multimeter BEFORE soldering. Reversing polarity destroys the XIAO instantly.

> [!WARNING]
> The DRV2605L is a **dedicated haptic driver** — never connect the motor directly to a GPIO pin. XIAO GPIO pins handle ≤15 mA; the motor requires up to 200 mA and must be driven via the DRV2605L's internal H-bridge.

> [!NOTE]
> The XIAO nRF52840 runs at **3.3V logic**. The Adafruit DRV2605L breakout includes a 3.3V regulator and level-shifter, accepting both 3.3V and 5V on VIN. Power it via the dual-voltage OR loop described below.

> [!IMPORTANT]
> **Clone DRV2605L boards** (non-Adafruit) have an **EN pin** that floats LOW by default, disabling the output stage entirely. Connect EN → XIAO D3 (firmware drives it HIGH) or hardwire EN → 3.3V. If you skip this, the motor will never vibrate regardless of correct register settings.

> [!TIP]
> The DRV2605L I²C address is fixed at **0x5A**. If adding another I²C device (e.g. IMU), ensure no address conflict.

---

## 🗺️ XIAO BLE nRF52840 Pinout Reference

```
         USB-C
    ┌─────────────┐
D0  │ 1         14│ 3.3V
D1  │ 2         13│ GND
D2  │ 3         12│ RST
D3  │ 4         11│ GND
D4/SDA│ 5      10│ BAT− (bottom pad)
D5/SCL│ 6       9│ BAT+ (bottom pad)
D6  │ 7         8│ VIN (5V from USB)
    └─────────────┘
       D7  D8  (additional pads on back, near USB-C)
```

> [!NOTE]
> D7 and D8 are exposed on the back pads. Verify against the [official Seeed schematic](https://wiki.seeedstudio.com/XIAO_BLE/) before soldering.

**Bottom pads (required for battery):**
- `BAT+` → LiPo red wire
- `BAT−` → LiPo black wire

---

## 🔌 Wiring

### DRV2605L → XIAO (Dual-Voltage OR Loop)

The dual-voltage OR loop prevents brownouts when the motor draws current peaks. It lets the DRV2605L draw from 5V USB when plugged in and fall back to 3.3V battery when unplugged.

| DRV2605L Pin | Connect To | XIAO Pin |
|---|---|---|
| VIN | OR loop output (cathodes of both diodes) | Pin 8 (5V) & Pin 14 (3.3V) via 1N5819s |
| GND | GND | Pin 13 |
| SDA | D4/SDA | Pin 5 |
| SCL | D5/SCL | Pin 6 |
| **EN** | **D3** | Pin 4 *(clone boards only — see caution above)* |
| OUTP | Motor (+) terminal | — |
| OUTN | Motor (−) terminal | — |

**OR loop wiring:**
1. Anode of Diode 1 → XIAO **Pin 8 (5V)**
2. Anode of Diode 2 → XIAO **Pin 14 (3.3V)**
3. Cathodes (striped ends) of both → DRV2605L **VIN**
4. 10µF–100µF cap across DRV2605L **VIN** and **GND** (positive leg to VIN)

```text
  ┌────────────────┐                        ┌──────────────────┐
  │  XIAO nRF52840 │                        │   DRV2605L       │
  │                │                        │                  │
  │   5V VIN (8) ──┼───[>| 1N5819 ]────┐    │                  │
  │                │                   ├───┼─ VIN              │
  │   3.3V  (14) ──┼───[>| 1N5819 ]────┘    │  │               │
  │                │                        │  ┴ 10–100µF Cap  │
  │    GND  (13) ──┼────────────────────────┼─ GND             │
  │  D4/SDA  (5) ──┼────────────────────────┼─ SDA             │
  │  D5/SCL  (6) ──┼────────────────────────┼─ SCL             │
  │      D3  (4) ──┼────────────────────────┼─ EN  (clone only)│
  │                │                        │                  │
  │                │                        │  OUTP ───────────┼──→ Motor (+)
  │                │                        │  OUTN ───────────┼──→ Motor (−)
  └────────────────┘                        └──────────────────┘
        │
  BAT+ (bottom) ──→ LiPo Red (+)
  BAT− (bottom) ──→ LiPo Black (−)
```

### Motor Selection & Polarity

| Motor Type | OUTP | OUTN | Polarity |
|---|---|---|---|
| **LRA** | Motor (+) | Motor (−) | **Sensitive** — must match markings |
| **ERM** | Either wire | Either wire | Not sensitive (only affects spin direction) |

> [!TIP]
> Twist the two motor leads together to minimise EMI. Keep leads short (≤5 cm).

### External RGB LED (optional)

An external RGB LED can be mounted anywhere on the enclosure or strap to show the same status as the onboard LED.

```
  XIAO D6 ──→ 220Ω ──→ R anode  ┐
  XIAO D7 ──→ 220Ω ──→ G anode  ├─ Common-Cathode RGB LED
  XIAO D8 ──→ 220Ω ──→ B anode  ┘
  GND ───────────────→ Cathode
```

If your LED is **common-anode** instead, uncomment `#define EXT_RGB_COMMON_ANODE` in the firmware.

### LiPo Battery → XIAO (bottom pads)

```
  LiPo Red (+)   ──→ BAT+ (bottom pad)
  LiPo Black (−) ──→ BAT− (bottom pad)
```

**Optional power switch:** Insert a SPDT switch in-line on the red (BAT+) wire.

---

## 🚥 LED & Vibration Status Reference

### LED states (both onboard and external LED, identical behaviour)

| State | LED |
|---|---|
| Booting | **Solid white** |
| Advertising / waiting to connect | **Slow blue blink** (1 s period) |
| BLE connected | **Solid green** |
| Low battery (≤ 20%) | **Fast amber blink** (300 ms period) |
| Fatal error (BLE or driver failed) | **Solid red** |

### Vibration patterns

| Event | Pattern |
|---|---|
| Boot alive confirmation | Three escalating pulses |
| BLE ready to connect | Double tap |
| Central device connected | Single tap |
| Central device disconnected | Rapid 6-pulse burst |
| Tap registered (cmd 0x01) | 50 ms pulse |
| Run complete (cmd 0x02) | 100 ms · pause · 200 ms |
| Heartbeat lost (>3 s) | 3× stutter |
| Battery ≤ 20% | Three short pulses |
| Battery ≤ 10% (critical) | SOS (··· ─── ···) |
| BLE init failed | SOS loop every 10 s |

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
4. Search **"seeed nrf52"** → install **Seeed nRF52 mbed-enabled Boards**

### Step 3 — Select Board & Port

- **Tools → Board → Seeed nRF52 mbed-enabled Boards → Seeed XIAO nRF52840**
- **Tools → Port → (your USB-C port)**

> [!NOTE]
> If the board is not detected, **double-tap the Reset button**. The orange LED fades — this is bootloader mode. Try uploading again.

### Step 4 — Install Required Libraries

#### ArduinoBLE
**Sketch → Include Library → Manage Libraries** → search **"ArduinoBLE"** → Install

#### Adafruit DRV2605
**Sketch → Include Library → Manage Libraries** → search **"Adafruit DRV2605"** → Install → **Install All** (includes Adafruit BusIO dependency)

> [!IMPORTANT]
> Both libraries are required. Compilation will fail without `Adafruit_DRV2605.h` and `Adafruit_BusIO`.

---

## 🖥️ Firmware Files

All firmware lives in the [`firmware/`](./firmware/) directory. There are two sketches:

| File | Purpose |
|---|---|
| [`firmware/haptic_test/haptic_test.ino`](./firmware/haptic_test/haptic_test.ino) | Hardware verification — runs vibration patterns on boot, no BLE needed |
| [`firmware/haptic_armband/haptic_armband.ino`](./firmware/haptic_armband/haptic_armband.ino) | Full BLE firmware — connects to the Touch Assay Timer web app |

### Choosing LRA or ERM motor

Both sketches support both motor types via a single switch at the **top of the file**. Open the sketch and keep only one of:

```cpp
#define MOTOR_LRA   // ← keep this for an LRA motor
// #define MOTOR_ERM   // ← keep this for an ERM coin motor
```

Swap the comments to change motor type. The correct registers, voltages, and calibration routines are applied automatically.

### Choosing external LED type

Also at the top of each file:

```cpp
#define USE_EXTERNAL_RGB        // comment out to disable external LED entirely
// #define EXT_RGB_COMMON_ANODE // uncomment only if your LED is common-anode
```

### Voltage values — adjusting for your motor

If your specific motor has different ratings, change these two register values in the `initMotor()` function:

**LRA:**
```
RATED_VOLTAGE (0x16) = V_rms × 255 / 5.3   (default: 0x57 = 1.8V RMS)
OD_CLAMP      (0x17) = V_od  × 255 / 5.6   (default: 0x60 = 2.1V, ~17% above rated)
```

**ERM:**
```
RATED_VOLTAGE (0x16) = V_rated × 255 / 5.3  (default: 0x90 = 3.0V)
OD_CLAMP      (0x17) = V_peak  × 255 / 5.6  (default: 0x96 = 3.3V)
```

---

## 🏗️ Physical Assembly

### Step 1: Solder Battery to XIAO

1. Tin the `BAT+` and `BAT−` pads on the underside of the XIAO
2. **Verify polarity with multimeter** before soldering
3. Solder red wire to `BAT+`, black to `BAT−`
4. Apply Kapton tape over joints for insulation
5. *(Optional)* Solder on/off switch in-line on the red wire

### Step 2: Connect DRV2605L to XIAO

1. **OR Loop (VIN):** Solder anodes of two 1N5819 diodes to XIAO **Pin 8 (5V)** and **Pin 14 (3.3V)**. Twist cathodes together → DRV2605L **VIN**.
2. **Decoupling cap:** Solder 10µF–100µF cap across DRV2605L **VIN** and **GND**. (Positive → VIN)
3. **Signal wires:** DRV2605L **GND → Pin 13**, **SDA → D4**, **SCL → D5**
4. **EN wire:** DRV2605L **EN → D3** *(clone boards only)*
5. Secure DRV2605L flat against XIAO with foam tape; hot-glue wire strain relief

### Step 3: Connect Motor

1. Strip ~5 mm from each motor lead; tin leads and DRV2605L OUTP / OUTN pads
2. Solder motor leads:
   - **LRA:** Match +/− markings to OUTP/OUTN
   - **ERM:** Either orientation (swap if spin direction is wrong)
3. Hot-glue joints for strain relief; twist leads together

### Step 4: Connect External RGB LED (optional)

1. Bend LED legs, insert 220Ω resistors in series on the R/G/B anodes
2. Run wires to XIAO **D6 (R), D7 (G), D8 (B)**; cathode to **GND**
3. Mount LED at a visible spot on the enclosure or strap

### Step 5: Test Before Enclosing

1. Connect XIAO via USB-C
2. Open the sketch `firmware/haptic_test/haptic_test.ino`
3. **Set motor type:** ensure the correct `#define MOTOR_LRA` or `#define MOTOR_ERM` is active
4. Upload and open **Serial Monitor at 115200 baud**

**Expected Serial output:**
```
I2C scanner found: 0x5A
LRA auto-calibration OK.       ← (or "DRV2605L: ERM open-loop mode." for ERM)
  A_CAL_COMP (0x18): 0x0C
  A_CAL_BEMF (0x19): 0x6C
Haptic test ready.
```

5. Confirm motor vibrates the double-tap + long-pulse pattern
6. External LED should be **solid green** when ready
7. Then upload `firmware/haptic_armband/haptic_armband.ino` and test BLE

> [!TIP]
> If the motor is silent but Serial output looks correct, check the **EN pin** is connected and driven HIGH (see Critical Notes above). This is the most common cause of 0V output on clone DRV2605L boards.

> [!TIP]
> If `WARNING: LRA auto-calibration failed` appears, verify your RATED_VOLTAGE and OD_CLAMP values match your motor's spec sheet, and check OUTP/OUTN solder joints.

### Step 6: Enclosure

**Option A — 3D Printed Shell (recommended)**
- 55×25×14 mm box with snap-fit lid
- Cutouts for: USB-C, optional switch, motor wire exit, LED window
- Component layout: XIAO (21×17 mm) + DRV2605L (~20×20 mm) + LiPo (6×20×40 mm)

**Option B — Fabric Pouch**
- Wrap in bubble foam, slide into a sewn nylon pouch
- Velcro the pouch to the strap

### Step 7: Attach to Armband

1. Cut elastic strap to wrist circumference + ~40 mm overlap
2. Sew or glue Velcro: loop side on one end, hook side on the other
3. Attach enclosure to strap centre (hook-and-loop for removability, foam tape for permanent)
4. Route motor cable and LED wire along the strap
5. Position motor on the **skin-contact face** of the band — attach with adhesive foam pad

### Step 8: Charging

1. Plug in USB-C cable
2. **Orange CHG LED** on XIAO illuminates during charging
3. LED turns **off** when fully charged (~1.5–2 hours for 400 mAh at ~50 mA)

---

## 📱 Testing via Phone (No App Needed)

Use **nRF Connect** (iOS/Android) or **LightBlue** (iOS):

1. Scan → find **"TouchAssayArmband"** → Connect
2. Navigate to service UUID `12345678-1234-1234-1234-123456789012`
3. Write a byte to the Haptic characteristic:

| Value | Pattern |
|---|---|
| `0x01` | Single tap (50 ms) |
| `0x02` | Run complete (100 ms · pause · 200 ms) |

---

## 🐛 Troubleshooting

| Issue | Solution |
|---|---|
| Board not detected in IDE | Double-tap Reset; use a USB-C **data** cable (not charge-only) |
| Upload fails | Select mbed-enabled board package; check Port selection |
| Serial: "DRV2605L not found!" | Check SDA→D4, SCL→D5; confirm VIN has power; check EN connected and HIGH |
| Motor silent, no Serial errors, 0V on OUTP/OUTN | **EN pin not driven HIGH** (most common issue on clone boards) |
| Motor silent, registers look correct in Serial | Check continuity of OUTP/OUTN → motor leads with multimeter |
| Motor cuts out immediately (overcurrent) | ERM motor stall-current exceeded driver limit; reduce OD_CLAMP temporarily; check motor spec |
| LRA: motor vibrates but weakly | Verify RATED_VOLTAGE (0x57) and OD_CLAMP (0x60) match your motor spec; confirm auto-cal succeeded (A_CAL_COMP and A_CAL_BEMF non-zero) |
| ERM: motor hums but doesn't spin | ERM closed-loop tracking failed; ensure open-loop is set (`0x1D` bit 5 = 1 in firmware) |
| BLE doesn't advertise | Call `BLE.begin()` before any other BLE function |
| Serial Monitor blank | Add `while(!Serial){}` with timeout; use mbed board package |
| Battery draining fast | Advertising interval is already 500 ms in firmware; check no tight `delay()` loop exists |
| Compile error: Adafruit_DRV2605.h | Install "Adafruit DRV2605" + "Adafruit BusIO" via Library Manager |
| External LED always off | Check `#define USE_EXTERNAL_RGB` is not commented out; check 220Ω resistors; verify D6/D7/D8 continuity |
| External LED wrong colour | Swap common-anode/cathode setting: add/remove `#define EXT_RGB_COMMON_ANODE` |

---

## 🔋 Estimated Battery Life

| Usage | Estimated Runtime |
|---|---|
| BLE advertising + idle | ~18–22 hours |
| BLE connected + occasional vibrations | ~10–14 hours |
| Continuous vibration (worst case) | ~2–3 hours |

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
│  ← LED window on top face →          │
└──────────────────────────────────────┘
```

Motor mounts **externally** on the skin-facing side, attached with adhesive foam tape or a 3D-printed motor pocket.

---

*Build time estimate: ~2–3 hours including soldering, programming, and assembly.*

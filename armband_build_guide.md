# 🦾 BLE Haptic Armband Build Guide

**Components:** Seeed Studio XIAO BLE nRF52840 · WLY602040 3.7V 400mAh LiPo · DRV2605L Haptic Driver · LRA or ERM Vibration Motor

> [!IMPORTANT]
> **Power architecture (DRV2605L):** The DRV2605L is powered **directly from the LiPo battery** (and USB 5 V when present) through a Schottky OR-diode loop — **not** from the XIAO's 3.3 V pin. The XIAO's onboard LDO can only supply ~150 mA; the DRV2605L can draw up to ~400 mA peak. Powering it from 3.3 V will brown-out the microcontroller mid-vibration.

---

## 📦 Bill of Materials

| Component | Qty | Notes |
|---|---|---|
| Seeed Studio XIAO BLE nRF52840 | 1 | **Not** the Sense variant unless you want the IMU |
| WLY602040 3.7V 400mAh LiPo battery | 1 | 6×20×40 mm, PCM protected |
| DRV2605L Haptic Motor Driver breakout | 1 | Adafruit #2305 or clone; I²C, 3.3V-compatible |
| **Option A:** LRA motor, 1.8V RMS | 1 | Z-axis linear resonant actuator (e.g. Jinlong G0832012D). Observe +/− polarity. |
| **Option B:** ERM coin motor, 3V | 1 | Eccentric rotating mass (standard coin vibration motor). No strict polarity. |
| 1N5819 Schottky Diode | 2 | OR-diode loop: one from XIAO Pin 14 (5V / VBUS), one from LiPo BAT+ wire direct |
| 220µF–470µF electrolytic capacitor | 1 | Bulk decoupling across DRV2605L VIN/GND — positive leg to VIN |
| **Optional:** External RGB LED (common-cathode, separate R/G/B) | 1 | For visible status outside enclosure. See wiring + resistor table below. |
| **270 Ω resistor** | 1 | Red LED current-limit (5 mA @ Vf ≈ 2.0 V, 3.3 V rail) |
| **100 Ω resistor** | 2 | Green & Blue LED current-limit (5 mA @ Vf ≈ 2.8–3.0 V, 3.3 V rail) |
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
> **Clone DRV2605L boards** (non-Adafruit) have an **EN pin** that floats LOW by default, disabling the output stage entirely. Connect EN → XIAO D3 (firmware drives it HIGH) or hardwire EN → 3.3V (XIAO Pin 12, 3V3). If you skip this, the motor will never vibrate regardless of correct register settings.

> [!TIP]
> The DRV2605L I²C address is fixed at **0x5A**. If adding another I²C device (e.g. IMU), ensure no address conflict.

---

## 🗺️ XIAO BLE nRF52840 Pinout Reference

Top view, component side up, USB-C at the top:

```
              USB-C
         ┌─────────────┐
D0/A0    │ 1         14│ 5V  (VBUS: USB 5 V, live only while USB is plugged in)
D1/A1    │ 2         13│ GND
D2/A2    │ 3         12│ 3V3 (LDO output)
D3/A3    │ 4         11│ D10 / MOSI
D4/SDA   │ 5         10│ D9  / MISO
D5/SCL   │ 6          9│ D8  / SCK
D6/TX    │ 7          8│ D7  / RX
         └─────────────┘
BAT+ / BAT− are solder pads on the underside, not header pins.
```

> [!NOTE]
> D7 (Pin 8) and D8 (Pin 9) are ordinary header pins on the right-hand edge — the bottom two. Verify against the [official Seeed pinout](https://wiki.seeedstudio.com/XIAO_BLE/) before soldering.

**Bottom pads (required for battery):**
- `BAT+` → LiPo red wire
- `BAT−` → LiPo black wire

---

## 🔌 Wiring

### DRV2605L → XIAO (Dual-Voltage OR Loop — Direct Battery Power)

The DRV2605L is powered **directly from the LiPo battery** in an OR-diode loop with USB 5 V. This removes the DRV completely from the XIAO's 3.3 V rail. The DRV2605L can draw up to ~400 mA peak during motor startup — far more than the XIAO's onboard LDO (~150 mA max) can supply without browning out.

> [!IMPORTANT]
> **Diode anode sources are:**
> - **Diode 1 anode → XIAO Pin 14 (5V / VBUS)** — provides power when USB cable is connected
> - **Diode 2 anode → LiPo BAT+ wire directly** — tap the red wire *before* it reaches the XIAO BAT+ pad, **not** XIAO Pin 12 (3V3) and **not** XIAO Pin 14 (5V)
>
> Both cathodes (striped ends) join at a single node → DRV2605L VIN. Whichever source is higher wins; the Schottky diodes prevent back-feed.

| DRV2605L Pin | Connect To | Notes |
|---|---|---|
| VIN | OR loop output (joined cathodes) | ~3.7–4.2 V from LiPo, or ~4.3 V from USB-5V-minus-diode-drop |
| GND | XIAO Pin 13 (GND) | Common ground |
| SDA | XIAO D4 (Pin 5) | I²C data |
| SCL | XIAO D5 (Pin 6) | I²C clock |
| **EN** | **XIAO D3 (Pin 4)** | **Clone boards only** — firmware drives HIGH. Adafruit breakout: not needed |
| OUTP | Motor (+) terminal | |
| OUTN | Motor (−) terminal | |

**Step-by-step OR loop wiring:**
1. Solder **Diode 1 anode** → XIAO **Pin 14 (5V / VBUS)**
2. Run a short (~5 cm) wire from the **LiPo red (+) wire**, tap it *before* the XIAO BAT+ pad → **Diode 2 anode**
3. Twist both **cathodes** (striped ends) together → DRV2605L **VIN**
4. Solder a **220 µF–470 µF** electrolytic cap across DRV2605L **VIN / GND** (positive → VIN), as close to the VIN/GND pins as possible

> [!TIP]
> The 1N5819 Schottky drop is ~0.3 V. When on battery alone the DRV sees ~3.4–3.9 V (3.7–4.2 V LiPo minus 0.3 V). The DRV2605L VIN range is 2.5–5.2 V — this is fully within spec.

> [!WARNING]
> **Never connect Diode 2 anode to XIAO Pin 12 (3V3).** That is a regulated output from the XIAO LDO, not a battery tap. Connecting it there would feed motor current backwards through the LDO and destroy it.

```text
  LiPo BAT+ wire (red)
  ┌──────────────────────────────────────────────────┐
  │   (tap here for Diode 2 — BEFORE XIAO BAT+ pad) │
  │                                                  ▼
  │                                        [>| 1N5819 D2 ]──┐
  │                                                          │
  ▼                                                          ├──→ DRV2605L VIN
  XIAO BAT+ pad (bottom)                                     │       │
                                                             │    [220–470µF]
  XIAO Pin 14 (5V)     ──[>| 1N5819 D1 ]────────────────────┘       │
                                                                      │
  XIAO Pin 13 (GND) ────────────────────────────────────────→ DRV GND┘
  XIAO D4 (Pin 5)   ────────────────────────────────────────→ DRV SDA
  XIAO D5 (Pin 6)   ────────────────────────────────────────→ DRV SCL
  XIAO D3 (Pin 4)   ────────────────────────────────────────→ DRV EN  ← clone boards only

                                               DRV2605L OUTP ──→ Motor (+)
                                               DRV2605L OUTN ──→ Motor (−)

  LiPo BAT− wire (black) ──────────────────────────────────→ XIAO BAT− pad (bottom)
```

### Motor Selection & Polarity

| Motor Type | OUTP | OUTN | Polarity |
|---|---|---|---|
| **LRA** | Motor (+) | Motor (−) | **Sensitive** — must match markings |
| **ERM** | Either wire | Either wire | Not sensitive (only affects spin direction) |

> [!TIP]
> Twist the two motor leads together to minimise EMI. Keep leads short (≤5 cm).

### External RGB LED (optional)

An external RGB LED (three separate LEDs or a single common-cathode 5 mm/3 mm RGB package) can be mounted anywhere on the enclosure or strap to show the same status as the onboard LED.

#### Resistor values — calculated for optimal brightness

XIAO GPIO output = **3.3 V**. Target current = **5 mA** per channel (safe, visible, long LED life).

| Channel | Typical Vf | Calculation | Standard resistor | Actual current |
|---|---|---|---|---|
| **Red** | 2.0 V | (3.3 − 2.0) / 0.005 = 260 Ω | **270 Ω** | ≈ 4.8 mA |
| **Green** | 2.8 V | (3.3 − 2.8) / 0.005 = 100 Ω | **100 Ω** | ≈ 5.0 mA |
| **Blue** | 2.8 V | (3.3 − 2.8) / 0.005 = 100 Ω | **100 Ω** | ≈ 5.0 mA |

> [!NOTE]
> Vf varies by LED brand. Red is typically 1.8–2.2 V; green/blue 2.6–3.3 V. **Do not use a single 220 Ω resistor on all channels** — it will produce a dim red (only ~5 mA) but nearly zero current through green/blue if Vf ≈ 3.0–3.3 V (voltage headroom collapses). Use the per-channel values above.
>
> If your green or blue LED has Vf ≥ 3.1 V, drop to **68 Ω** or even **47 Ω** for green/blue. Measure across the LED with a multimeter; if it reads < 2.5 V when your resistor is connected, reduce the resistor.

```
  XIAO D6 (Pin 7) ──→ 270 Ω ──→ R anode  ┐
  XIAO D7 (Pin 8) ──→ 100 Ω ──→ G anode  ├─ Common-Cathode RGB LED
  XIAO D8 (Pin 9) ──→ 100 Ω ──→ B anode  ┘
  GND ──────────────────→ Cathode
```

If your LED is **common-anode** instead, uncomment `#define EXT_RGB_COMMON_ANODE` in the firmware. The same resistor values apply — just place them between XIAO D6/D7/D8 and the individual anodes, with the common anode tied to 3.3 V (XIAO Pin 12, 3V3).

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
| [`firmware/haptic_test/haptic_test.ino`](./firmware/haptic_test/haptic_test.ino) | Hardware verification — dumps the DRV2605L registers and holds the motor on for 10 s on boot, no BLE needed |
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

The drive levels are set by `DRV_RATED_VOLTAGE` and `DRV_OD_CLAMP` in the **DRIVE LEVELS** block at the top of `haptic_armband.ino` (written to the chip by `configureMotorRegisters()`). The BLE sketch's defaults drive the motor **harder than the BOM parts are rated for**, for a stronger buzz. `haptic_test.ino` uses lower, closer-to-rated values. To run a motor at its rating, use the "BOM-rated" column below, or work out your own from the formulas (TI DRV2605L datasheet, SLOS854D).

**LRA** (closed loop):
```
V_rms = RATED_VOLTAGE × 20.71 mV / sqrt(1 − (4·t_SAMPLE + 300 µs)·f_LRA)   (t_SAMPLE = 300 µs by default)
```

| Register | `haptic_armband.ino` default | BOM-rated (1.8 V RMS LRA, 235 Hz) | `haptic_test.ino` |
|---|---|---|---|
| RATED_VOLTAGE (0x16) | `0x78` (≈ 3.1 V RMS) | `0x46` | `0x57` |
| OD_CLAMP (0x17) | `0xA4` | `0x60` | `0x60` |

**ERM** (open loop): only OD_CLAMP sets the drive, at 21.59 mV per LSB (and never above the supply rail). RATED_VOLTAGE is not used.

| Register | `haptic_armband.ino` default | BOM-rated (3 V ERM) | `haptic_test.ino` |
|---|---|---|---|
| OD_CLAMP (0x17) | `0xD0` (≈ 4.5 V) | `0x8B` (≈ 3.0 V) | `0x96` (≈ 3.2 V) |
| RATED_VOLTAGE (0x16) | `0xC0` (unused) | — | `0x90` (unused) |

---

## 🏗️ Physical Assembly

### Step 1: Solder Battery to XIAO

1. Tin the `BAT+` and `BAT−` pads on the underside of the XIAO
2. **Verify polarity with multimeter** before soldering
3. Solder red wire to `BAT+`, black to `BAT−`
4. Apply Kapton tape over joints for insulation
5. *(Optional)* Solder on/off switch in-line on the red wire

### Step 2: Connect DRV2605L to XIAO

Wire VIN (dual-diode OR loop + decoupling cap), GND, SDA, SCL, and EN exactly per the **🔌 Wiring** diagram and table above — don't re-derive it here, that section is the source of truth if anything looks off mid-build.

1. Complete every connection listed in the Wiring section
2. Secure DRV2605L flat against XIAO with foam tape; hot-glue wire strain relief

### Step 3: Connect Motor

1. Strip ~5 mm from each motor lead; tin leads and DRV2605L OUTP / OUTN pads
2. Solder motor leads:
   - **LRA:** Match +/− markings to OUTP/OUTN
   - **ERM:** Either orientation (swap if spin direction is wrong)
3. Hot-glue joints for strain relief; twist leads together

### Step 4: Connect External RGB LED (optional)

Wire per the **External RGB LED** diagram above (270 Ω red, 100 Ω green/blue — do not substitute one 220 Ω for all three; see that section for why).

1. Bend LED legs; insert the resistor in series on each anode lead (D6/D7/D8), common cathode → GND
2. Mount the LED at a visible spot on the enclosure or strap; Kapton-tape the resistor leads for insulation

### Step 5: Test Before Enclosing

1. Connect XIAO via USB-C
2. Open the sketch `firmware/haptic_test/haptic_test.ino`
3. **Set motor type:** ensure the correct `#define MOTOR_LRA` or `#define MOTOR_ERM` is active
4. Upload and open **Serial Monitor at 115200 baud**

**Expected Serial output** (abridged — the register dumps are longer):
```
>>> DIAGNOSTIC HAPTIC TEST
Running I2C scanner...
  Found: 0x5A
I2C scan complete.
DRV2605L responded to begin().
=== Register dump [AFTER begin(), BEFORE manual init] ===
  ...
--- Configuring LRA closed-loop ---
LRA auto-calibration complete.         ← ERM prints "DRV2605L initialised: ERM open-loop mode." instead
  A_CAL_COMP (0x18): 0x..
  A_CAL_BEMF (0x19): 0x..
=== Register dump [AFTER manual init] ===
  ...
>>> OUTPUT ON — measure OUT+ to GND now.
  t=1s  STATUS=0x..  MODE=0x5  RTP=0x7F      (one line per second, 10 in all)
>>> Output OFF. Paste the full log above for analysis.
```

5. Confirm the motor vibrates **continuously for about 10 s** (RTP mode at full amplitude). You can measure OUTP/OUTN with a multimeter during this window.
6. The external LED turns **solid green** after the 10 s test finishes, or **red** if the DRV2605L is not found
7. Then upload `firmware/haptic_armband/haptic_armband.ino` and test BLE. The double-tap "ready" buzz comes from this sketch, not from `haptic_test.ino`.

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

Write a byte to the Heartbeat characteristic to test the watchdog:

| Value | Effect |
|---|---|
| `0x03` | Heartbeat keepalive (resets the 3 s watchdog timer) |
| `0x04` | Heartbeat stop (disarms the watchdog — sent automatically when a run ends normally) |

---

## 🐛 Troubleshooting

### Power & Hardware

| Issue | Solution |
|---|---|
| Board not detected in IDE | Double-tap Reset; use a USB-C **data** cable (not charge-only); try different USB port |
| Upload fails | Select **Seeed nRF52 mbed-enabled Boards** package in Board Manager; verify Port is selected |
| XIAO resets or reboots during vibration | DRV2605L drawing too much from 3.3 V — **check OR loop wiring**; VIN must come from LiPo/USB5V, not Pin 12 (3V3) |
| OR loop: DRV2605L works on USB but not on battery alone | Diode 2 anode is not connected to LiPo BAT+ — it may be floating. Tap the red wire before the BAT+ pad |
| OR loop: DRV2605L works on battery but not on USB | Diode 1 anode is not connected to XIAO Pin 14 (5V / VBUS); verify with multimeter (should read ~5 V when USB plugged in) |
| Decoupling cap polarity wrong | Electrolytic caps are polarised — positive leg to VIN, negative to GND. Reversed caps can short or explode |

### DRV2605L & Motor

| Issue | Solution |
|---|---|
| Serial: "DRV2605L not found!" | Check SDA→D4, SCL→D5 continuity; confirm VIN has power (≥2.5 V); confirm EN is HIGH |
| Motor silent, no Serial errors, 0 V on OUTP/OUTN | **EN pin not driven HIGH** — most common issue on clone boards. Check D3 is wired to EN and firmware is uploading |
| Motor silent, registers look correct in Serial | Check continuity of OUTP/OUTN → motor leads with multimeter; check for cold solder joints |
| Motor cuts out immediately (overcurrent) | ERM stall-current exceeded driver limit; reduce OD_CLAMP (0x17) temporarily; verify motor rated current |
| LRA: motor vibrates but weakly | Verify `DRV_RATED_VOLTAGE` and `DRV_OD_CLAMP` (top of the sketch — see *Voltage values* above) suit your motor's spec sheet; confirm auto-cal succeeded (A_CAL_COMP and A_CAL_BEMF both non-zero) |
| LRA: `WARNING: auto-calibration failed` | Check OUTP/OUTN polarity; confirm RATED_VOLTAGE not too low; try slightly increasing OD_CLAMP |
| ERM: motor hums but doesn't spin | ERM closed-loop tracking failed on small motor; ensure open-loop is set (`0x1D` bit 5 = 1 in firmware) |
| DRV2605L I²C lost mid-use | Firmware has auto-recovery every 5 s; check wiring strain relief; add extra GND wire if board moves |

### BLE & Software

| Issue | Solution |
|---|---|
| BLE doesn't advertise | Ensure `BLE.begin()` succeeds before calling `BLE.advertise()` — check Serial for ERROR messages |
| Serial Monitor blank | Ensure `while(!Serial){}` timeout in setup; use mbed board package, not standard nRF52 |
| Battery draining fast | Advertising interval is 500 ms in firmware; confirm no tight `delay()` loop; advertising normally draws ~3–5 mA |
| Compile error: `Adafruit_DRV2605.h` not found | Install **"Adafruit DRV2605"** + **"Adafruit BusIO"** via Library Manager → Install All |

### External LED

| Issue | Solution |
|---|---|
| External LED always off | Check `#define USE_EXTERNAL_RGB` is not commented out; verify D6/D7/D8 continuity; check resistors |
| External LED extremely dim (green or blue especially) | Resistor too large for Vf near 3.0–3.3 V — replace 220 Ω with **100 Ω** on green/blue. Check Vf with multimeter |
| External LED shows wrong colour | Verify wiring: D6=Red, D7=Green, D8=Blue; swap `#define EXT_RGB_COMMON_ANODE` if colours are inverted |
| External red LED very bright, green/blue barely visible | Using the same resistor on all channels — use **270 Ω for red, 100 Ω for green/blue** |
| LED flickers | Check solder joints on resistors; add 100 nF ceramic cap from each LED anode to GND to suppress GPIO noise |

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

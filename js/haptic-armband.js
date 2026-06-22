/**
 * @file haptic-armband.js
 * @description Manages the Web Bluetooth GATT connection to the researcher's
 * haptic armband (Seeed XIAO nRF52840 + DRV2605L haptic driver + LRA motor).
 *
 * The armband mirrors navigator.vibrate() patterns from the host device exactly:
 *
 *   armbandTap()         → 0x01 → armband plays vibrate(50)          [50 ms pulse]
 *   armbandRunComplete() → 0x02 → armband plays vibrate([100,50,200]) [ascending]
 *
 * All exports are silent no-ops when:
 *   - The browser does not support Web Bluetooth (Firefox, Safari)
 *   - The armband is not connected
 * This means zero impact on the timing-critical code path even when the armband
 * is absent or disconnected mid-session.
 *
 * Heartbeat watchdog: the PWA writes a keepalive to the armband every 2 s
 * during a run. If the armband receives no heartbeat for >3 s, it fires a
 * stutter warning autonomously (PWA crashed / backgrounded / BLE dropped).
 *
 * GATT layout:
 *   Service UUID:    12345678-1234-1234-1234-123456789012
 *   Haptic char:     12345678-1234-1234-1234-000000000001  (Write Without Response)
 *   Heartbeat char:  12345678-1234-1234-1234-000000000002  (Write Without Response)
 */

const SERVICE_UUID   = "12345678-1234-1234-1234-123456789012";
const HAPTIC_UUID    = "12345678-1234-1234-1234-000000000001";
const HEARTBEAT_UUID = "12345678-1234-1234-1234-000000000002";

// Standard Bluetooth SIG Battery Service / Battery Level Characteristic
const BATT_SERVICE_UUID = 0x180F;
const BATT_LEVEL_UUID   = 0x2A19;

// Command bytes — must match the firmware switch-case exactly
const CMD_TAP          = new Uint8Array([0x01]);  // mirrors vibrate(50)
const CMD_RUN_COMPLETE = new Uint8Array([0x02]);  // mirrors vibrate([100,50,200])
const CMD_HEARTBEAT    = new Uint8Array([0x01]);

// Module-level connection state
let _device             = null;
let _hapticChar         = null;
let _hbChar             = null;
let _battChar           = null;   // Battery Level characteristic (0x2A19)
let _hbTimer            = null;
let _connected          = false;
let _hbWasActive        = false;  // FW-7 FIX: track if HB was running before disconnect
let _onDisconnectCb     = null;
let _onReconnectCb      = null;  // () => void — fired after a successful auto-reconnect
let _onBatteryUpdateCb  = null;  // (level: 0-100) => void

// ── Public API ─────────────────────────────────────────────────────────────────

/** Returns true if this browser supports Web Bluetooth. */
export const isBluetoothSupported = () => "bluetooth" in navigator;

/** Returns true if the armband is currently connected. */
export const isArmbandConnected = () => _connected;

/**
 * Opens the browser Bluetooth device picker and connects to the armband.
 * Resolves when GATT characteristics are ready.
 * @param {Function} onDisconnect   Called when the BLE connection drops unexpectedly.
 * @param {Function} [onBatteryUpdate]  Called with the battery level (0-100) on updates.
 * @param {Function} [onReconnect]  Called when a background auto-reconnect succeeds.
 * @throws {Error}  If the user cancels the picker (err.name === "NotFoundError"),
 *                  or if GATT negotiation fails.
 *
 * Filter strategy: we filter by SERVICE_UUID rather than device name.
 * "TouchAssayArmband" (18 chars) + the 128-bit service UUID together exceed
 * the 31-byte BLE advertising packet limit, so ArduinoBLE pushes the name
 * into the scan-response packet. Chrome's name filter only inspects the main
 * advertising packet, causing intermittent discovery failures.
 * The service UUID is always in the main advert and is 100% reliable.
 */
export async function armbandConnect(onDisconnect, onBatteryUpdate = null, onReconnect = null) {
  if (!isBluetoothSupported()) {
    throw new Error("Web Bluetooth is not supported on this browser.");
  }
  _onDisconnectCb    = onDisconnect;
  _onReconnectCb     = onReconnect;
  _onBatteryUpdateCb = onBatteryUpdate;

  _device = await navigator.bluetooth.requestDevice({
    filters:          [{ services: [SERVICE_UUID] }],  // UUID is in main advert → reliable
    optionalServices: [BATT_SERVICE_UUID],             // SERVICE_UUID now in filter, not here
  });

  _device.addEventListener("gattserverdisconnected", _handleDisconnect);

  const server  = await _device.gatt.connect();
  const service = await server.getPrimaryService(SERVICE_UUID);
  _hapticChar   = await service.getCharacteristic(HAPTIC_UUID);
  _hbChar       = await service.getCharacteristic(HEARTBEAT_UUID);

  // Subscribe to battery notifications (gracefully skipped if firmware lacks the service)
  await _subscribeBattery(server);

  _connected    = true;
}

/**
 * Disconnects from the armband cleanly and stops the heartbeat timer.
 */
export async function armbandDisconnect() {
  _stopHeartbeat();
  _connected = false;
  if (_battChar) {
    _battChar.removeEventListener("characteristicvaluechanged", _handleBatteryUpdate);
    try { await _battChar.stopNotifications(); } catch { /* ignore */ }
    _battChar = null;
  }
  try { _device?.gatt?.disconnect(); } catch { /* ignore */ }
  _device = _hapticChar = _hbChar = null;
}

/**
 * Fires the "tap registered" haptic — mirror of navigator.vibrate(50).
 * Call immediately after tapTimestamps.push(getAudioTime()) in RUNNING branch.
 * Non-blocking fire-and-forget; zero impact on AudioContext timing.
 */
export function armbandTap() {
  _write(_hapticChar, CMD_TAP);
}

/**
 * Fires the "run complete" haptic — mirror of navigator.vibrate([100, 50, 200]).
 * Call in completeRunNormally() alongside playCompletionTone().
 * Non-blocking fire-and-forget.
 */
export function armbandRunComplete() {
  _write(_hapticChar, CMD_RUN_COMPLETE);
}

/**
 * Starts the 2-second heartbeat writer.
 * Call immediately after timerWorker.postMessage("start").
 */
export function armbandStartHeartbeat() {
  _stopHeartbeat(); // guard against double-start on rapid stop→start
  _hbTimer = setInterval(() => {
    if (!_connected) { _stopHeartbeat(); return; }
    _write(_hbChar, CMD_HEARTBEAT);
  }, 2000);
}

/**
 * Stops the heartbeat writer.
 * Call inside stopCueLoop() so the armband watchdog is not left running
 * between runs when the worker is idle.
 */
export function armbandStopHeartbeat() {
  _stopHeartbeat();
}

// ── Private helpers ────────────────────────────────────────────────────────────

function _write(char, data) {
  if (!_connected || !char) return;
  char.writeValueWithoutResponse(data).catch(err => {
    // A failed write does not imply a disconnect — BLE can recover from
    // transient radio congestion without dropping the GATT connection.
    console.warn("[HapticArmband] Write failed:", err.message);
  });
}

function _stopHeartbeat() {
  if (_hbTimer !== null) {
    clearInterval(_hbTimer);
    _hbTimer = null;
  }
}

/**
 * Attempts to get the BLE Battery Service and subscribe to level notifications.
 * Wrapped in try/catch — if the firmware doesn't expose 0x180F the rest of
 * the connection still succeeds; battery monitoring is simply unavailable.
 * @param {BluetoothRemoteGATTServer} server
 */
async function _subscribeBattery(server) {
  try {
    const battService = await server.getPrimaryService(BATT_SERVICE_UUID);
    _battChar = await battService.getCharacteristic(BATT_LEVEL_UUID);
    _battChar.addEventListener("characteristicvaluechanged", _handleBatteryUpdate);
    await _battChar.startNotifications();
    // Do an immediate read so the UI shows the level right after connecting
    // rather than waiting for the first notification (which may be minutes away).
    const initial = await _battChar.readValue();
    _onBatteryUpdateCb?.(initial.getUint8(0));
  } catch (err) {
    console.info("[HapticArmband] Battery Service not available — monitoring disabled.", err.message);
    _battChar = null;
  }
}

/**
 * Handler for BLE Battery Level notifications.
 * Fires whenever the armband ADC reading drops by ≥1%.
 * @param {Event} e  BluetoothCharacteristicValueChangedEvent
 */
function _handleBatteryUpdate(e) {
  const level = e.target.value.getUint8(0); // 0–100
  _onBatteryUpdateCb?.(level);
}

function _handleDisconnect() {
  _connected = false;
  _hbWasActive = _hbTimer !== null;  // FW-7 FIX: remember if heartbeat was running
  _stopHeartbeat();
  _battChar = null;  // GATT handles are invalid after disconnect
  _onDisconnectCb?.();

  // Attempt a single automatic reconnect after 1 s.
  setTimeout(async () => {
    if (!_device || _connected) return;
    try {
      const server  = await _device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE_UUID);
      _hapticChar   = await service.getCharacteristic(HAPTIC_UUID);
      _hbChar       = await service.getCharacteristic(HEARTBEAT_UUID);
      await _subscribeBattery(server);  // re-subscribe after reconnect
      _connected    = true;
      // FW-7 FIX: Restart heartbeat if it was running before the dropout.
      // Without this, a brief BLE disconnect during an active run stops
      // the heartbeat permanently → firmware watchdog fires stutter
      // warnings every 3 s for the rest of the run.
      if (_hbWasActive) {
        _hbWasActive = false;
        armbandStartHeartbeat();
      }
      console.log("[HapticArmband] Auto-reconnected.");
      // Notify the UI so it can restore the "connected" appearance.
      _onReconnectCb?.();
    } catch {
      console.warn("[HapticArmband] Auto-reconnect failed — user must reconnect manually.");
    }
  }, 1000);
}

// Ambient type declarations for globals this project relies on that aren't
// covered by the standard DOM lib — either loaded from a CDN script tag
// (SheetJS) or attached to `window` by the inline chip-input script in
// index.html. Picked up automatically by jsconfig.json's "include" glob.

/** SheetJS, loaded via <script src="...xlsx.full.min.js"> in index.html. */
declare const XLSX: any;

interface Window {
  /**
   * Exposed by the inline chip-input IIFE in index.html so main.js can
   * restore draft genotype chips through the same validation/dedup/drag
   * logic as interactive chip entry, instead of duplicating it.
   */
  ChipInput?: {
    addChip: (raw: string) => void;
    updateGenotypeMaxHint: () => void;
    clearChips: () => void;
  };

  /** Legacy vendor-prefixed AudioContext, still needed for older Safari. */
  webkitAudioContext?: typeof AudioContext;

  /** Exposed by toast.js so index.html's PWA-update logic can show a toast. */
  showToast?: (message: string, type?: string, duration?: number, actionText?: string, actionCallback?: (() => void) | null) => HTMLElement;
}

// ── Minimal Web Bluetooth typings ───────────────────────────────────────────
// Scoped to just what js/haptic-armband.js actually calls — not a full
// @types/web-bluetooth (that'd be an npm dependency, which this no-build-step
// project deliberately avoids). The armband module already feature-detects
// and no-ops gracefully when the API is absent (see isBluetoothSupported()).
interface BluetoothRemoteGATTCharacteristic extends EventTarget {
  value: DataView | null;
  writeValueWithoutResponse(data: BufferSource): Promise<void>;
  readValue(): Promise<DataView>;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
}

interface BluetoothRemoteGATTService {
  getCharacteristic(uuid: string | number): Promise<BluetoothRemoteGATTCharacteristic>;
}

interface BluetoothRemoteGATTServer {
  connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(uuid: string | number): Promise<BluetoothRemoteGATTService>;
}

interface BluetoothDevice extends EventTarget {
  gatt?: BluetoothRemoteGATTServer;
}

interface Bluetooth {
  requestDevice(options: {
    filters?: { services: (string | number)[] }[];
    optionalServices?: (string | number)[];
  }): Promise<BluetoothDevice>;
}

interface Navigator {
  bluetooth?: Bluetooth;
}

import { requireNativeModule, type EventSubscription } from 'expo-modules-core';
import { Platform } from 'react-native';

type LockStateEvent = {
  locked: boolean;
};

type DeviceKioskModuleType = {
  isDeviceOwner(): boolean;
  lockPhone(): { ok: boolean; deviceOwner: boolean };
  unlockPhone(): { ok: boolean; deviceOwner: boolean };
  hideSystemUi(): boolean;
  showSystemUi(): boolean;
  startLockTask(): void;
  stopLockTask(): void;
  startLockWatch(qrRef: string, supabaseUrl: string, supabaseKey: string): boolean;
  stopLockWatch(): boolean;
  canDrawOverlays(): boolean;
  openOverlayPermissionSettings(): boolean;
  hideLockOverlay(): boolean;
  showLockOverlay(): boolean;
  releaseDeviceOwner(): boolean;
  requestUninstall(): boolean;
  isSupported(): boolean;
  addListener(
    eventName: 'onRemoteLockState',
    listener: (event: LockStateEvent) => void
  ): EventSubscription;
};

let DeviceKiosk: DeviceKioskModuleType | null = null;

try {
  if (Platform.OS === 'android') {
    DeviceKiosk = requireNativeModule<DeviceKioskModuleType>('DeviceKiosk');
  }
} catch {
  DeviceKiosk = null;
}

export function canUseSystemKiosk(): boolean {
  return Platform.OS === 'android' && DeviceKiosk != null;
}

export function isDeviceOwner(): boolean {
  try {
    return DeviceKiosk?.isDeviceOwner() ?? false;
  } catch {
    return false;
  }
}

export function hideSystemUi(): void {
  try {
    DeviceKiosk?.hideSystemUi();
  } catch {
    // Expo Go: no native immersive API
  }
}

export function showSystemUi(): void {
  try {
    DeviceKiosk?.showSystemUi();
  } catch {
    // ignore
  }
}

export function lockPhone(): { ok: boolean; deviceOwner: boolean } {
  try {
    return DeviceKiosk?.lockPhone() ?? { ok: false, deviceOwner: false };
  } catch {
    return { ok: false, deviceOwner: false };
  }
}

export function unlockPhone(): { ok: boolean; deviceOwner: boolean } {
  try {
    return DeviceKiosk?.unlockPhone() ?? { ok: false, deviceOwner: false };
  } catch {
    return { ok: false, deviceOwner: false };
  }
}

export function startLockWatch(qrRef: string, supabaseUrl: string, supabaseKey: string): boolean {
  try {
    return DeviceKiosk?.startLockWatch(qrRef, supabaseUrl, supabaseKey) ?? false;
  } catch {
    return false;
  }
}

export function stopLockWatch(): boolean {
  try {
    return DeviceKiosk?.stopLockWatch() ?? false;
  } catch {
    return false;
  }
}

export function canDrawOverlays(): boolean {
  try {
    return DeviceKiosk?.canDrawOverlays() ?? false;
  } catch {
    return false;
  }
}

export function openOverlayPermissionSettings(): boolean {
  try {
    return DeviceKiosk?.openOverlayPermissionSettings() ?? false;
  } catch {
    return false;
  }
}

export function hideLockOverlay(): boolean {
  try {
    return DeviceKiosk?.hideLockOverlay() ?? false;
  } catch {
    return false;
  }
}

export function showLockOverlay(): boolean {
  try {
    return DeviceKiosk?.showLockOverlay() ?? false;
  } catch {
    return false;
  }
}

export function releaseDeviceOwner(): boolean {
  try {
    return DeviceKiosk?.releaseDeviceOwner() ?? false;
  } catch {
    return false;
  }
}

export function requestUninstall(): boolean {
  try {
    return DeviceKiosk?.requestUninstall() ?? false;
  } catch {
    return false;
  }
}

/** Native LockWatch → JS. Instant Unlock (JS timers throttle under Lock Task). */
export function addRemoteLockStateListener(
  listener: (locked: boolean) => void
): EventSubscription | { remove: () => void } {
  if (!DeviceKiosk?.addListener) {
    return { remove: () => {} };
  }
  return DeviceKiosk.addListener('onRemoteLockState', (event: LockStateEvent) => {
    listener(Boolean(event?.locked));
  });
}

export function startSystemKiosk(): void {
  lockPhone();
}

export function stopSystemKiosk(): void {
  unlockPhone();
}

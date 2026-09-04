# Remote Device Lock — Full Implementation Guide

Shop owner presses **Lock** → the customer's whole phone locks into a kiosk (only a
Pay button works). Shop presses **Unlock** → the phone returns to normal.

This document is the complete, end-to-end implementation with all the code.

---

## Architecture

Two separate apps talk through one shared Supabase database. The shop app never
touches the customer phone directly — it only flips a flag (`is_locked`) in the
database. The customer app watches that flag and locks/unlocks itself.

```
Shop app (TestingInstallment)          Supabase                 Customer app (installment-customer)
   tap Lock  ───────────────►  installments.is_locked=true ──►  lockPhone() → Android kiosk
   tap Unlock ──────────────►  installments.is_locked=false ─►  unlockPhone() → normal
```

Two layers of locking in the customer app:

- **Soft (app) layer** — always works, even in Expo Go: a full black LOCKED screen
  with only a Pay button, the Android Back button blocked, and the status/navigation
  bars hidden.
- **Hard (system) layer** — only works when the phone is set as **Device Owner**: the
  native `device-kiosk` module calls `startLockTask()` plus Device Owner policies.
  This is what truly stops the customer from leaving the app (Home, Recents, and the
  notification shade all stop working).

Without Device Owner, a user can still press Home and escape, and Android shows an
"App is pinned / NO THANKS / OK" confirmation dialog. **Device Owner is the step that
makes it a real, unbreakable lock.**

---

## Step 1 — Database column

In Supabase → SQL Editor, run this, then enable Realtime for the `installments` table
(Database → Replication).

```sql
-- supabase/add-lock-column.sql
alter table public.installments
  add column if not exists is_locked boolean not null default false;
```

## Step 2 — Shared Supabase client (same in both apps)

`.env` (both projects — must point to the SAME Supabase project):

```bash
EXPO_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=YOUR-ANON-KEY
```

```ts
// src/lib/supabase.ts
import 'expo-sqlite/localStorage/install';

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: localStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
```

## Step 3 — Add `is_locked` to the type

```ts
// src/lib/types.ts
export type Installment = {
  id: string;
  customer_id: string;
  product_id: string;
  product_price: number;
  down_payment: number;
  remaining_balance: number;
  number_of_installments: number;
  installment_amount: number;
  qr_code_ref: string;
  status: 'active' | 'completed';
  is_locked: boolean;
  created_at: string;
};
```

---

## Step 4 — Native `device-kiosk` module (customer app)

A local Expo native module. Directory: `modules/device-kiosk/`.

### 4a — Module config files

```json
// modules/device-kiosk/package.json
{
  "name": "device-kiosk",
  "version": "1.0.0",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {},
  "peerDependencies": {
    "expo": "*",
    "react": "*",
    "react-native": "*"
  }
}
```

```json
// modules/device-kiosk/expo-module.config.json
{
  "platforms": ["android"],
  "android": {
    "modules": ["expo.modules.devicekiosk.DeviceKioskModule"]
  }
}
```

```groovy
// modules/device-kiosk/android/build.gradle
apply plugin: 'com.android.library'
apply plugin: 'kotlin-android'

group = 'expo.modules.devicekiosk'
version = '1.0.0'

android {
  namespace "expo.modules.devicekiosk"
  compileSdkVersion safeExtGet("compileSdkVersion", 36)

  defaultConfig {
    minSdkVersion safeExtGet("minSdkVersion", 24)
    targetSdkVersion safeExtGet("targetSdkVersion", 36)
  }

  lintOptions {
    abortOnError false
  }
}

repositories {
  mavenCentral()
}

dependencies {
  implementation project(':expo-modules-core')
  implementation "androidx.core:core-ktx:1.15.0"
}

def safeExtGet(prop, fallback) {
  rootProject.ext.has(prop) ? rootProject.ext.get(prop) : fallback
}
```

Link the module in the app's `package.json`:

```json
"dependencies": {
  "device-kiosk": "file:./modules/device-kiosk"
}
```

### 4b — JS bridge

Safe TypeScript wrappers so the app never crashes in Expo Go or on iOS.

```ts
// modules/device-kiosk/src/index.ts
import { requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

type DeviceKioskModuleType = {
  isDeviceOwner(): boolean;
  lockPhone(): { ok: boolean; deviceOwner: boolean };
  unlockPhone(): { ok: boolean; deviceOwner: boolean };
  hideSystemUi(): boolean;
  showSystemUi(): boolean;
  startLockTask(): void;
  stopLockTask(): void;
  isSupported(): boolean;
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

export function startSystemKiosk(): void {
  lockPhone();
}

export function stopSystemKiosk(): void {
  unlockPhone();
}
```

### 4c — Native Kotlin (the real lock logic)

`modules/device-kiosk/android/src/main/java/expo/modules/devicekiosk/DeviceKioskModule.kt`

```kotlin
package expo.modules.devicekiosk

import android.app.Activity
import android.app.ActivityManager
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.view.View
import android.view.WindowManager
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class DeviceKioskModule : Module() {
  private var systemUiListenerAttached = false

  // UserManager.DISALLOW_EXPAND_STATUS_BAR is not in the public SDK; use its documented value.
  private val disallowExpandStatusBar = "no_expand_status_bar"

  private fun adminComponent(context: Context): ComponentName {
    return ComponentName(context.packageName, "${context.packageName}.DeviceAdminReceiver")
  }

  private fun devicePolicyManager(context: Context): DevicePolicyManager {
    return context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
  }

  private fun hideSystemBars(activity: Activity) {
    val window = activity.window
    WindowCompat.setDecorFitsSystemWindows(window, false)

    // Keep screen on while locked
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    @Suppress("DEPRECATION")
    window.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)

    // Hide bottom 3 buttons (Back / Home / Recents) + status bar / notification pull
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val controller = WindowInsetsControllerCompat(window, window.decorView)
      controller.hide(WindowInsetsCompat.Type.statusBars())
      controller.hide(WindowInsetsCompat.Type.navigationBars())
      controller.hide(WindowInsetsCompat.Type.systemBars())
      // Auto-hide again if user swipes the bar up
      controller.systemBarsBehavior =
        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    } else {
      @Suppress("DEPRECATION")
      window.decorView.systemUiVisibility =
        (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
          or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
          or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
          or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
          or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
          or View.SYSTEM_UI_FLAG_FULLSCREEN)
    }

    // If bars flash back, hide them again immediately
    if (!systemUiListenerAttached) {
      systemUiListenerAttached = true
      @Suppress("DEPRECATION")
      window.decorView.setOnSystemUiVisibilityChangeListener { visibility ->
        val navVisible = visibility and View.SYSTEM_UI_FLAG_HIDE_NAVIGATION == 0
        val statusVisible = visibility and View.SYSTEM_UI_FLAG_FULLSCREEN == 0
        if (navVisible || statusVisible) {
          hideSystemBars(activity)
        }
      }
    }
  }

  private fun showSystemBars(activity: Activity) {
    val window = activity.window
    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    @Suppress("DEPRECATION")
    window.clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
    WindowCompat.setDecorFitsSystemWindows(window, true)
    systemUiListenerAttached = false
    @Suppress("DEPRECATION")
    window.decorView.setOnSystemUiVisibilityChangeListener(null)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val controller = WindowInsetsControllerCompat(window, window.decorView)
      controller.show(WindowInsetsCompat.Type.statusBars())
      controller.show(WindowInsetsCompat.Type.navigationBars())
    } else {
      @Suppress("DEPRECATION")
      window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_VISIBLE
    }
  }

  private fun prepareDeviceOwnerLock(context: Context) {
    val dpm = devicePolicyManager(context)
    val admin = adminComponent(context)
    if (!dpm.isDeviceOwnerApp(context.packageName)) {
      return
    }

    // Allow only this app in Lock Task (kiosk)
    dpm.setLockTaskPackages(admin, arrayOf(context.packageName))

    // Disable Home + Recents + notifications while locked
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_NONE)
    }

    try {
      dpm.setKeyguardDisabled(admin, true)
    } catch (_: SecurityException) {
    }

    try {
      // Blocks status bar + notification shade pull-down
      dpm.setStatusBarDisabled(admin, true)
    } catch (_: Throwable) {
    }

    try {
      // Extra: disallow expanding notification panel from top
      dpm.addUserRestriction(admin, disallowExpandStatusBar)
    } catch (_: Throwable) {
    }
  }

  private fun clearDeviceOwnerLock(context: Context) {
    val dpm = devicePolicyManager(context)
    val admin = adminComponent(context)
    if (!dpm.isDeviceOwnerApp(context.packageName)) {
      return
    }

    try {
      dpm.setKeyguardDisabled(admin, false)
    } catch (_: SecurityException) {
    }

    try {
      dpm.setStatusBarDisabled(admin, false)
    } catch (_: Throwable) {
    }

    try {
      dpm.clearUserRestriction(admin, disallowExpandStatusBar)
    } catch (_: Throwable) {
    }
  }

  private fun isInLockTask(context: Context): Boolean {
    val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    return am.lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE
  }

  // Only enter Lock Task when we are Device Owner. Without Device Owner, startLockTask()
  // falls back to Android screen pinning, which pops a "App is pinned / NO THANKS / OK"
  // confirmation the user can decline — so we skip it and rely on the in-app overlay lock.
  // Also skip if already locked/pinned: re-calling startLockTask() re-triggers the dialog
  // and makes it flicker.
  private fun enterLockTask(activity: Activity) {
    val context = activity.applicationContext
    if (!devicePolicyManager(context).isDeviceOwnerApp(context.packageName)) {
      return
    }
    if (isInLockTask(context)) {
      return
    }
    try {
      activity.startLockTask()
    } catch (_: Exception) {
    }
  }

  private fun exitLockTask(activity: Activity) {
    if (!isInLockTask(activity.applicationContext)) {
      return
    }
    try {
      activity.stopLockTask()
    } catch (_: Exception) {
    }
  }

  private fun runOnUi(activity: Activity, block: () -> Unit) {
    activity.runOnUiThread {
      try {
        block()
      } catch (_: Exception) {
      }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("DeviceKiosk")

    Function("isDeviceOwner") {
      val context = appContext.reactContext ?: return@Function false
      devicePolicyManager(context).isDeviceOwnerApp(context.packageName)
    }

    Function("hideSystemUi") {
      val activity = appContext.currentActivity ?: return@Function false
      val context = activity.applicationContext
      // Re-apply Device Owner status-bar block while locked
      prepareDeviceOwnerLock(context)
      runOnUi(activity) { hideSystemBars(activity) }
      true
    }

    Function("showSystemUi") {
      val activity = appContext.currentActivity ?: return@Function false
      runOnUi(activity) { showSystemBars(activity) }
      true
    }

    Function("lockPhone") {
      val activity = appContext.currentActivity
        ?: throw Exception("No current activity. Open the app on the phone first.")
      val context = activity.applicationContext

      prepareDeviceOwnerLock(context)
      runOnUi(activity) {
        hideSystemBars(activity)
        enterLockTask(activity)
      }
      mapOf(
        "ok" to true,
        "deviceOwner" to devicePolicyManager(context).isDeviceOwnerApp(context.packageName)
      )
    }

    Function("unlockPhone") {
      val activity = appContext.currentActivity
        ?: throw Exception("No current activity. Open the app on the phone first.")
      val context = activity.applicationContext

      runOnUi(activity) {
        exitLockTask(activity)
        showSystemBars(activity)
      }
      clearDeviceOwnerLock(context)
      mapOf(
        "ok" to true,
        "deviceOwner" to devicePolicyManager(context).isDeviceOwnerApp(context.packageName)
      )
    }

    Function("startLockTask") {
      val activity = appContext.currentActivity
        ?: throw Exception("No current activity")
      val context = activity.applicationContext
      prepareDeviceOwnerLock(context)
      runOnUi(activity) {
        hideSystemBars(activity)
        enterLockTask(activity)
      }
      null
    }

    Function("stopLockTask") {
      val activity = appContext.currentActivity
        ?: throw Exception("No current activity")
      val context = activity.applicationContext
      runOnUi(activity) {
        exitLockTask(activity)
        showSystemBars(activity)
      }
      clearDeviceOwnerLock(context)
      null
    }

    Function("isSupported") {
      true
    }
  }
}
```

---

## Step 5 — Config plugin

During `expo prebuild`, this plugin: registers the `DeviceAdminReceiver` in the
manifest, writes `res/xml/device_admin.xml`, generates `DeviceAdminReceiver.kt`, and
sets `lockTaskMode="if_whitelisted"` on the main activity.

```js
// plugins/withDeviceOwner.js
const {
  withAndroidManifest,
  withDangerousMod,
  AndroidConfig,
} = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const DEVICE_ADMIN_XML = `<?xml version="1.0" encoding="utf-8"?>
<device-admin xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-policies>
    <limit-password />
    <watch-login />
    <reset-password />
    <force-lock />
    <wipe-data />
    <expire-password />
    <encrypted-storage />
    <disable-camera />
    <disable-keyguard-features />
  </uses-policies>
</device-admin>
`;

function deviceAdminReceiverKotlin(packageName) {
  return `package ${packageName}

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class DeviceAdminReceiver : DeviceAdminReceiver() {
  override fun onEnabled(context: Context, intent: Intent) {
    super.onEnabled(context, intent)
    Log.i("DeviceAdminReceiver", "Device admin enabled")
  }

  override fun onDisabled(context: Context, intent: Intent) {
    super.onDisabled(context, intent)
    Log.i("DeviceAdminReceiver", "Device admin disabled")
  }
}
`;
}

function withDeviceOwner(config) {
  config = withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
    const packageName = config.android?.package;
    if (!packageName) {
      throw new Error('android.package is required for Device Owner plugin');
    }

    if (!app.receiver) app.receiver = [];

    const already = app.receiver.find(
      (item) => item.$?.['android:name'] === '.DeviceAdminReceiver'
    );

    if (!already) {
      app.receiver.push({
        $: {
          'android:name': '.DeviceAdminReceiver',
          'android:permission': 'android.permission.BIND_DEVICE_ADMIN',
          'android:exported': 'true',
        },
        'meta-data': [
          {
            $: {
              'android:name': 'android.app.device_admin',
              'android:resource': '@xml/device_admin',
            },
          },
        ],
        'intent-filter': [
          {
            action: [
              { $: { 'android:name': 'android.app.action.DEVICE_ADMIN_ENABLED' } },
            ],
          },
        ],
      });
    }

    const mainActivity = AndroidConfig.Manifest.getMainActivityOrThrow(manifest);
    mainActivity.$['android:lockTaskMode'] = 'if_whitelisted';
    mainActivity.$['android:excludeFromRecents'] = 'true';

    return config;
  });

  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const projectRoot = config.modRequest.projectRoot;
      const packageName = config.android?.package;
      if (!packageName) {
        throw new Error('android.package is required');
      }

      const xmlDir = path.join(
        projectRoot, 'android', 'app', 'src', 'main', 'res', 'xml'
      );
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(path.join(xmlDir, 'device_admin.xml'), DEVICE_ADMIN_XML);

      const pkgPath = packageName.split('.').join(path.sep);
      const kotlinDir = path.join(
        projectRoot, 'android', 'app', 'src', 'main', 'java', pkgPath
      );
      fs.mkdirSync(kotlinDir, { recursive: true });
      fs.writeFileSync(
        path.join(kotlinDir, 'DeviceAdminReceiver.kt'),
        deviceAdminReceiverKotlin(packageName)
      );

      return config;
    },
  ]);

  return config;
}

module.exports = withDeviceOwner;
```

## Step 6 — Wire the plugin in `app.json`

```json
{
  "expo": {
    "android": { "package": "com.installment.customer" },
    "plugins": [
      "expo-router",
      "expo-sqlite",
      ["expo-camera", { "cameraPermission": "Allow scanning installment QR codes", "barcodeScannerEnabled": true }],
      ["expo-navigation-bar", { "enforceContrast": false, "style": "dark" }],
      "./plugins/withDeviceOwner.js",
      "expo-status-bar"
    ]
  }
}
```

---

## Step 7 — Customer app watcher + lock overlay

`src/components/device-lock.tsx` — a provider that watches the database (realtime +
1s polling) and, when `is_locked` is true, applies the native lock and shows a
full-screen overlay. Key details are commented inline.

```tsx
// src/components/device-lock.tsx
import 'expo-sqlite/localStorage/install';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, AppState, BackHandler, Platform,
  Pressable, StatusBar as RNStatusBar, StyleSheet, View,
} from 'react-native';
import { NavigationBar, addVisibilityListener, setVisibilityAsync } from 'expo-navigation-bar';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { supabase } from '@/lib/supabase';
import { formatMoney, resolvePaymentDisplayStatus, type InstallmentWithRelations } from '@/lib/types';
import { canUseSystemKiosk, hideSystemUi, isDeviceOwner, lockPhone, showSystemUi, unlockPhone } from 'device-kiosk';

export const LAST_QR_REF_KEY = 'last_installment_qr_ref';
export const LOCKED_REF_KEY = 'locked_installment_qr_ref';

type DeviceLockContextValue = {
  isLocked: boolean;
  refreshLockState: () => Promise<void>;
  rememberQrRef: (qrRef: string) => void;
};

const DeviceLockContext = createContext<DeviceLockContextValue>({
  isLocked: false,
  refreshLockState: async () => {},
  rememberQrRef: () => {},
});

export function useDeviceLock() {
  return useContext(DeviceLockContext);
}

function getSavedQrRef(): string {
  try {
    return localStorage.getItem(LOCKED_REF_KEY) || localStorage.getItem(LAST_QR_REF_KEY) || '';
  } catch {
    return '';
  }
}

async function applyLockedSystemUi() {
  if (Platform.OS === 'android') {
    try { RNStatusBar.setHidden(true, 'none'); } catch {}
    try { NavigationBar.setHidden(true); } catch {}
    try { await setVisibilityAsync('hidden'); } catch {}
  }
  hideSystemUi(); // native immersive sticky (custom build only, not Expo Go)
}

async function restoreSystemUi() {
  if (Platform.OS === 'android') {
    try { RNStatusBar.setHidden(false, 'none'); } catch {}
    try { NavigationBar.setHidden(false); } catch {}
    try { await setVisibilityAsync('visible'); } catch {}
  }
  showSystemUi();
}

export function DeviceLockProvider({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const [installment, setInstallment] = useState<InstallmentWithRelations | null>(null);
  const [paying, setPaying] = useState(false);
  const [isLocked, setIsLocked] = useState(false);

  const refreshLockState = useCallback(async () => {
    const qrRef = getSavedQrRef();
    if (!qrRef) {
      setInstallment(null);
      setIsLocked(false);
      return;
    }

    const { data, error } = await supabase
      .from('installments')
      .select(`*, customers ( id, name, phone, address ), products ( id, name, price ), payments ( * )`)
      .eq('qr_code_ref', qrRef)
      .maybeSingle();

    if (error || !data) return;

    const row = data as InstallmentWithRelations;
    row.payments = [...(row.payments ?? [])]
      .sort((a, b) => a.installment_number - b.installment_number)
      .map((p) => ({ ...p, status: resolvePaymentDisplayStatus(p.status, p.due_date) }));

    const locked = Boolean(row.is_locked);
    setInstallment(row);
    setIsLocked(locked);

    try {
      if (locked) {
        localStorage.setItem(LOCKED_REF_KEY, qrRef);
        localStorage.setItem(LAST_QR_REF_KEY, qrRef);
      } else {
        localStorage.removeItem(LOCKED_REF_KEY);
      }
    } catch {}
  }, []);

  const rememberQrRef = useCallback((qrRef: string) => {
    if (!qrRef) return;
    try { localStorage.setItem(LAST_QR_REF_KEY, qrRef); } catch {}
    void refreshLockState();
  }, [refreshLockState]);

  // Poll every 1s + subscribe to realtime changes
  useEffect(() => {
    void refreshLockState();
    const timer = setInterval(() => { void refreshLockState(); }, 1000);
    return () => clearInterval(timer);
  }, [refreshLockState]);

  useEffect(() => {
    const channel = supabase
      .channel(`device-lock-${Date.now()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'installments' }, (payload) => {
        const qrRef = getSavedQrRef();
        const row = payload.new as { qr_code_ref?: string } | null;
        if (!qrRef || !row?.qr_code_ref || row.qr_code_ref === qrRef) {
          void refreshLockState();
        }
      })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [refreshLockState]);

  // Power off → on: re-apply the locked UI
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void refreshLockState();
      if (isLocked) {
        void applyLockedSystemUi();
        if (canUseSystemKiosk()) lockPhone();
      }
    });
    return () => sub.remove();
  }, [refreshLockState, isLocked]);

  // Main lock/unlock effect
  useEffect(() => {
    if (!isLocked) {
      void restoreSystemUi();
      if (canUseSystemKiosk()) unlockPhone();
      return;
    }

    // Enter Lock Task ONCE (disables Home/Recents when Device Owner)
    void applyLockedSystemUi();
    if (canUseSystemKiosk()) lockPhone();

    // Block the Android Back button
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);

    // Only re-hide the system bars here. Re-calling lockPhone() would re-trigger the
    // screen-pinning dialog and make it flicker, so it is intentionally NOT in this loop.
    const timer = setInterval(() => { void applyLockedSystemUi(); }, 800);

    let visibilitySub: { remove: () => void } | undefined;
    try {
      visibilitySub = addVisibilityListener((event) => {
        if (event.visibility === 'visible') {
          void applyLockedSystemUi();
          if (canUseSystemKiosk()) lockPhone();
        }
      });
    } catch {}

    return () => {
      sub.remove();
      clearInterval(timer);
      visibilitySub?.remove();
      void restoreSystemUi();
      if (canUseSystemKiosk()) unlockPhone();
    };
  }, [isLocked]);

  const nextPayment = useMemo(() => {
    if (!installment) return null;
    return installment.payments.find((p) => p.status !== 'paid') ?? null;
  }, [installment]);

  async function handlePay() {
    if (!installment || !nextPayment) return;
    setPaying(true);
    const paymentAmount = Number(nextPayment.amount);
    const newRemaining = Math.max(
      Math.round((Number(installment.remaining_balance) - paymentAmount) * 100) / 100, 0
    );

    const { error: paymentError } = await supabase
      .from('payments')
      .update({ status: 'paid', paid_at: new Date().toISOString() })
      .eq('id', nextPayment.id)
      .neq('status', 'paid');

    if (paymentError) {
      setPaying(false);
      Alert.alert('Payment failed', paymentError.message);
      return;
    }

    const allOthersPaid = installment.payments
      .filter((p) => p.id !== nextPayment.id)
      .every((p) => p.status === 'paid');

    await supabase
      .from('installments')
      .update({
        remaining_balance: newRemaining,
        status: allOthersPaid || newRemaining === 0 ? 'completed' : 'active',
      })
      .eq('id', installment.id);

    setPaying(false);
    Alert.alert('Payment recorded', 'Still locked until the shop owner taps Unlock.');
    await refreshLockState();
  }

  const value = useMemo(
    () => ({ isLocked, refreshLockState, rememberQrRef }),
    [isLocked, refreshLockState, rememberQrRef]
  );

  return (
    <DeviceLockContext.Provider value={value}>
      <StatusBar hidden={isLocked} style="light" />
      {Platform.OS === 'android' ? <NavigationBar hidden={isLocked} style="light" /> : null}
      <View style={styles.root}>
        {/* Keep the app UI mounted underneath so navigation state (the open installment
            screen) is preserved when we unlock. The opaque overlay fully covers it while locked. */}
        {children}

        {isLocked ? (
          <View
            style={[styles.lockScreen, styles.lockOverlay, { paddingTop: insets.top + Spacing.four }]}
            onStartShouldSetResponder={() => true}
            onMoveShouldSetResponder={() => true}
            onResponderTerminationRequest={() => false}>
            <View
              pointerEvents="box-only"
              style={[styles.topSwipeBlocker, { height: Math.max(insets.top, 24) + 56 }]}
              onStartShouldSetResponder={() => true}
              onMoveShouldSetResponder={() => true}
              onResponderTerminationRequest={() => false}
            />

            <ThemedText type="subtitle" style={styles.lockTitle}>LOCKED</ThemedText>
            <ThemedText type="small" style={styles.lockBody}>
              Only Pay works until the shop owner unlocks.
            </ThemedText>
            {Platform.OS === 'android' ? (
              <ThemedText type="small" style={styles.lockHint}>
                {isDeviceOwner()
                  ? 'System lock ON — top swipe and bottom tabs blocked.'
                  : canUseSystemKiosk()
                    ? 'Install as Device Owner to block top swipe and bottom tabs. Expo Go cannot do this.'
                    : 'Running in Expo Go — top bar and bottom tabs cannot be blocked.'}
              </ThemedText>
            ) : null}

            <View style={styles.lockCard}>
              <ThemedText type="smallBold" style={styles.lockBody}>
                {installment?.products?.name ?? 'Product'}
              </ThemedText>
              <ThemedText type="small" style={styles.lockBody}>
                Remaining: {formatMoney(installment?.remaining_balance ?? 0)}
              </ThemedText>
              {nextPayment ? (
                <ThemedText type="small" style={[styles.mt, styles.lockBody]}>
                  Due: #{nextPayment.installment_number} · {formatMoney(nextPayment.amount)}
                </ThemedText>
              ) : (
                <ThemedText type="small" style={[styles.mt, styles.lockBody]}>
                  Paid — waiting for Unlock
                </ThemedText>
              )}
            </View>

            {nextPayment ? (
              <Pressable
                style={[styles.payButton, paying && styles.disabled]}
                disabled={paying}
                onPress={() => void handlePay()}>
                {paying ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <ThemedText type="smallBold" style={styles.payLabel}>
                    Pay {formatMoney(nextPayment.amount)}
                  </ThemedText>
                )}
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
    </DeviceLockContext.Provider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#111827' },
  lockScreen: {
    flex: 1, backgroundColor: '#111827', paddingHorizontal: Spacing.four,
    justifyContent: 'center', gap: Spacing.three,
  },
  lockOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100 },
  topSwipeBlocker: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 50, backgroundColor: 'transparent' },
  lockTitle: { color: '#fff', textAlign: 'center' },
  lockBody: { color: '#F9FAFB', textAlign: 'center' },
  lockHint: { color: '#FBBF24', textAlign: 'center', paddingHorizontal: Spacing.two },
  lockCard: { backgroundColor: '#1F2937', borderRadius: Spacing.three, padding: Spacing.four, gap: Spacing.one },
  mt: { marginTop: Spacing.two },
  payButton: {
    marginTop: Spacing.two, backgroundColor: '#059669', borderRadius: Spacing.two,
    alignItems: 'center', justifyContent: 'center', paddingVertical: Spacing.three,
  },
  payLabel: { color: '#fff' },
  disabled: { opacity: 0.6 },
});
```

## Step 8 — Wire the provider in the root layout

```tsx
// src/app/_layout.tsx
import { DeviceLockProvider, useDeviceLock } from '@/components/device-lock';

export default function RootLayout() {
  return (
    <DeviceLockProvider>
      <RootNavigator />
    </DeviceLockProvider>
  );
}
```

---

## Step 9 — Shop app Lock / Unlock buttons (TestingInstallment)

The shop app only updates the `is_locked` flag; the customer app does the rest.

```tsx
// TestingInstallment/src/app/installment/[id].tsx
async function setLocked(locked: boolean) {
  if (!installment) return;
  setLocking(true);

  const { data, error: updateError } = await supabase
    .from('installments')
    .update({ is_locked: locked })
    .eq('id', installment.id)
    .select('id, is_locked')
    .single();

  setLocking(false);

  if (updateError || !data) {
    Alert.alert(locked ? 'Could not lock device' : 'Could not unlock device',
      updateError?.message ?? 'Update failed. Try again.');
    return;
  }

  setInstallment({ ...installment, is_locked: Boolean(data.is_locked) });
  Alert.alert(locked ? 'Locked' : 'Unlocked',
    locked ? 'Customer app should show LOCKED within ~1 second.' : 'Customer app unlocked.');
}
```

---

## Step 10 — Build the customer APK

```bash
cd installment-customer
npx expo prebuild --platform android    # generates android/ from app.json + withDeviceOwner
cd android
./gradlew assembleRelease               # standalone signed APK (JS bundled, no dev server needed)
# → android/app/build/outputs/apk/release/app-release.apk
```

The release build is signed with the debug keystore, which is fine for sideloading
onto shop-controlled phones. For Play Store distribution, generate your own release
keystore.

## Step 11 — Provision the customer phone as Device Owner (the critical step)

Requirements: the phone must be **factory reset** with **no Google account added**,
and USB debugging ON. This is the step that makes the *full* phone lock work.

```bash
adb devices                                                        # confirm phone detected
adb install -r android/app/build/outputs/apk/release/app-release.apk
adb shell dpm set-device-owner com.installment.customer/.DeviceAdminReceiver
adb shell dumpsys device_policy | grep -A2 "Device Owner"          # verify
```

Helper script: `scripts/setup-device-owner.sh` (or `npm run android:device-owner`).

If step 3 errors with *"Not allowed to set the device owner because there are already
some accounts"*, the phone is not clean — factory reset, remove all accounts, retry.

## Step 12 — Usage & verification

1. Shop creates the installment in TestingInstallment → a QR reference is generated.
2. Customer opens installment-customer on the Device-Owner phone and scans that QR once.
3. Shop opens that installment and taps **Lock**.
4. Within ~1 second the customer phone drops into the LOCKED kiosk (balance + Pay only).
   Home, Back, Recents, notifications: all dead.
5. Shop taps **Unlock** → phone returns to normal, and the customer stays on the same
   installment screen.

**Verify while locked:** press Home → nothing; swipe down from top → shade does not
open; press Back → nothing. If any of those still work, the phone is NOT Device Owner
(only the soft lock is running) — redo Step 11 on a clean device.

---

## Bugs fixed during real-device testing

- **"App is pinned" dialog flickering (show/disappear/show):** the lock loop was calling
  `startLockTask()` every 500ms. Fixed by making `enterLockTask()`/`exitLockTask()`
  idempotent (check `ActivityManager.getLockTaskModeState()`) and removing `lockPhone()`
  from the interval — the loop now only re-hides the system bars.
- **Going back to the scanner after unlock:** the lock screen was unmounting the whole
  app UI (`{!isLocked ? children : null}`), so unlocking remounted the app at its
  initial route. Fixed by always keeping `children` mounted and covering them with an
  absolute opaque overlay while locked.
- **Stuck pinned / repeated dialog:** `enterLockTask()`/`exitLockTask()` are idempotent
  (guarded by `isInLockTask()`), so lock task is entered/exited only once. On a Device
  Owner phone this locks silently; on a non-Device-Owner (debug) phone Android shows a
  one-time "App is pinned" confirmation, which is expected and cannot be avoided without
  Device Owner.
- **Release build failed to compile:** `UserManager.DISALLOW_EXPAND_STATUS_BAR` is not
  in the public SDK; replaced with its documented string value `"no_expand_status_bar"`.

## Limitations

- **Device Owner requires a factory-reset phone.** You cannot convert a customer's
  existing daily-use phone without wiping it. This model works when the shop hands out
  pre-provisioned phones.
- **Expo Go cannot do the hard lock** — only the soft overlay. Use the native APK.
- The customer app must have **scanned the installment QR at least once** so it knows
  which record's `is_locked` to watch.
- To remove Device Owner later, the app must call `clearDeviceOwnerApp`, or factory reset.

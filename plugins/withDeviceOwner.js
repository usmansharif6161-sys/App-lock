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
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

class DeviceAdminReceiver : DeviceAdminReceiver() {
  override fun onEnabled(context: Context, intent: Intent) {
    super.onEnabled(context, intent)
    Log.i("DeviceAdminReceiver", "Device admin enabled")
  }

  override fun onDisabled(context: Context, intent: Intent) {
    super.onDisabled(context, intent)
    Log.i("DeviceAdminReceiver", "Device admin disabled")
    // Clean up any lingering user restrictions when admin is removed
    try {
      val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
      val admin = ComponentName(context.packageName, "\${context.packageName}.DeviceAdminReceiver")
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        try { dpm.clearUserRestriction(admin, android.os.UserManager.DISALLOW_FACTORY_RESET) } catch (_: Exception) {}
        try { dpm.clearUserRestriction(admin, android.os.UserManager.DISALLOW_INSTALL_APPS) } catch (_: Exception) {}
        try { dpm.clearUserRestriction(admin, android.os.UserManager.DISALLOW_UNINSTALL_APPS) } catch (_: Exception) {}
      }
    } catch (e: Exception) {
      Log.w("DeviceAdminReceiver", "onDisabled cleanup failed: \${e.message}")
    }
  }
}
`;
}

function bootReceiverKotlin(packageName) {
  return `package ${packageName}

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

// After reboot: if locked, start LockBootService which opens the app via
// foreground notification / full-screen intent (works better on old phones
// without Device Owner than startActivity alone).
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val action = intent.action ?: return
    if (action != Intent.ACTION_BOOT_COMPLETED &&
      action != "android.intent.action.QUICKBOOT_POWERON" &&
      action != "com.htc.intent.action.QUICKBOOT_POWERON" &&
      action != Intent.ACTION_MY_PACKAGE_REPLACED &&
      action != Intent.ACTION_LOCKED_BOOT_COMPLETED) {
      return
    }

    val locked = context
      .getSharedPreferences("device_kiosk_prefs", Context.MODE_PRIVATE)
      .getBoolean("kiosk_locked", false)

    if (!locked) {
      Log.i("BootReceiver", "Not locked — skip relaunch")
      return
    }

    try {
      val service = Intent(context, LockBootService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(service)
      } else {
        context.startService(service)
      }
      Log.i("BootReceiver", "Started LockBootService after boot")
    } catch (e: Exception) {
      Log.w("BootReceiver", "Could not start LockBootService", e)
      // Last resort: try launching the activity directly
      try {
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
        if (launch != null) {
          launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          context.startActivity(launch)
        }
      } catch (_: Exception) {
      }
    }
  }
}
`;
}

function lockBootServiceKotlin(packageName) {
  return `package ${packageName}

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log

/**
 * Started from BootReceiver when the phone was locked before reboot.
 * Uses a foreground notification + full-screen intent to bring the app up on
 * old phones where background startActivity is blocked. Once the app opens,
 * JS shows LOCKED and calls startLockTask (screen pinning).
 */
class LockBootService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val locked = getSharedPreferences("device_kiosk_prefs", Context.MODE_PRIVATE)
      .getBoolean("kiosk_locked", false)

    if (!locked) {
      stopSelf()
      return START_NOT_STICKY
    }

    ensureChannel()
    val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      addFlags(
        Intent.FLAG_ACTIVITY_NEW_TASK or
          Intent.FLAG_ACTIVITY_CLEAR_TOP or
          Intent.FLAG_ACTIVITY_SINGLE_TOP or
          Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
      )
      putExtra("from_boot_lock", true)
    }

    val pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT or
      (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)

    val fullScreen = if (launch != null) {
      PendingIntent.getActivity(this, 1001, launch, pendingFlags)
    } else null

    val notification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val builder = Notification.Builder(this, CHANNEL_ID)
        .setContentTitle("Device locked")
        .setContentText("Tap to open payment lock screen")
        .setSmallIcon(android.R.drawable.ic_lock_lock)
        .setOngoing(true)
        .setCategory(Notification.CATEGORY_ALARM)
        .setVisibility(Notification.VISIBILITY_PUBLIC)
        .setPriority(Notification.PRIORITY_MAX)
      if (fullScreen != null) {
        builder.setContentIntent(fullScreen)
        builder.setFullScreenIntent(fullScreen, true)
      }
      builder.build()
    } else {
      @Suppress("DEPRECATION")
      val builder = Notification.Builder(this)
        .setContentTitle("Device locked")
        .setContentText("Tap to open payment lock screen")
        .setSmallIcon(android.R.drawable.ic_lock_lock)
        .setOngoing(true)
        .setPriority(Notification.PRIORITY_MAX)
      if (fullScreen != null) {
        builder.setContentIntent(fullScreen)
        builder.setFullScreenIntent(fullScreen, true)
      }
      builder.build()
    }

    try {
      startForeground(NOTIFICATION_ID, notification)
    } catch (e: Exception) {
      Log.w("LockBootService", "startForeground failed", e)
    }

    // Try to open the app a few times (OEM delays after boot)
    fun tryLaunch(attempt: Int) {
      if (attempt > 5) {
        // Keep notification so user can tap it; stop FGS after a bit
        Handler(Looper.getMainLooper()).postDelayed({ stopSelf() }, 60_000)
        return
      }
      try {
        if (launch != null) {
          startActivity(launch)
          Log.i("LockBootService", "Launched MainActivity attempt=$attempt")
        }
      } catch (e: Exception) {
        Log.w("LockBootService", "Launch attempt $attempt failed", e)
      }
      Handler(Looper.getMainLooper()).postDelayed({ tryLaunch(attempt + 1) }, 2000L * attempt + 1500L)
    }
    Handler(Looper.getMainLooper()).postDelayed({ tryLaunch(1) }, 1500)

    return START_STICKY
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = getSystemService(NotificationManager::class.java) ?: return
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Device lock",
      NotificationManager.IMPORTANCE_HIGH
    ).apply {
      description = "Opens the lock screen after phone restart"
      setBypassDnd(true)
      lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    }
    nm.createNotificationChannel(channel)
  }

  companion object {
    private const val CHANNEL_ID = "device_lock_boot"
    private const val NOTIFICATION_ID = 42001
  }
}
`;
}

const EXTRA_PERMISSIONS = [
  'android.permission.RECEIVE_BOOT_COMPLETED',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.USE_FULL_SCREEN_INTENT',
  'android.permission.WAKE_LOCK',
  'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
  'android.permission.RECEIVE_SMS',
];

function ensurePermission(manifestRoot, name) {
  if (!manifestRoot['uses-permission']) manifestRoot['uses-permission'] = [];
  const exists = manifestRoot['uses-permission'].some(
    (item) => item.$?.['android:name'] === name
  );
  if (!exists) {
    manifestRoot['uses-permission'].push({ $: { 'android:name': name } });
  }
}

function withDeviceOwner(config) {
  config = withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
    const packageName = config.android?.package;
    if (!packageName) {
      throw new Error('android.package is required for Device Owner plugin');
    }

    const manifestRoot = manifest.manifest;
    for (const perm of EXTRA_PERMISSIONS) {
      ensurePermission(manifestRoot, perm);
    }

    if (!app.receiver) app.receiver = [];
    if (!app.service) app.service = [];

    // Ensure Device Admin receiver has provisioning-friendly exported + meta
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
              {
                $: {
                  'android:name': 'android.app.action.DEVICE_ADMIN_ENABLED',
                },
              },
              {
                $: {
                  'android:name': 'android.app.action.PROFILE_PROVISIONING_COMPLETE',
                },
              },
            ],
          },
        ],
      });
    } else {
      // Keep PROFILE_PROVISIONING_COMPLETE on existing receiver
      const filters = already['intent-filter'] || [];
      const hasProv = filters.some((f) =>
        (f.action || []).some(
          (a) => a.$?.['android:name'] === 'android.app.action.PROFILE_PROVISIONING_COMPLETE'
        )
      );
      if (!hasProv && filters[0]) {
        if (!filters[0].action) filters[0].action = [];
        filters[0].action.push({
          $: { 'android:name': 'android.app.action.PROFILE_PROVISIONING_COMPLETE' },
        });
      }
    }

    if (!app.activity) app.activity = [];

    const ensureActivity = (name, actions) => {
      const existing = app.activity.find((item) => item.$?.['android:name'] === name);
      if (existing) {
        if (!existing['intent-filter']) existing['intent-filter'] = [];
        const filter = existing['intent-filter'][0] ?? (existing['intent-filter'][0] = {});
        if (!filter.action) filter.action = [];
        for (const actionName of actions) {
          const hasAction = filter.action.some(
            (action) => action.$?.['android:name'] === actionName
          );
          if (!hasAction) {
            filter.action.push({
              $: { 'android:name': actionName },
            });
          }
        }
        if (!filter.category) filter.category = [];
        const hasDefaultCategory = filter.category.some(
          (category) => category.$?.['android:name'] === 'android.intent.category.DEFAULT'
        );
        if (!hasDefaultCategory) {
          filter.category.push({
            $: { 'android:name': 'android.intent.category.DEFAULT' },
          });
        }
        return;
      }
      app.activity.push({
        $: {
          'android:name': name,
          'android:exported': 'true',
          'android:permission': 'android.permission.BIND_DEVICE_ADMIN',
          'android:excludeFromRecents': 'true',
        },
        'intent-filter': [
          {
            action: actions.map((actionName) => ({
              $: { 'android:name': actionName },
            })),
            category: [
              {
                $: { 'android:name': 'android.intent.category.DEFAULT' },
              },
            ],
          },
        ],
      });
    };

    ensureActivity('.GetProvisioningModeActivity', [
      'android.app.action.GET_PROVISIONING_MODE',
    ]);
    ensureActivity('.PolicyComplianceActivity', [
      'android.app.action.ADMIN_POLICY_COMPLIANCE',
    ]);

    const bootAlready = app.receiver.find(
      (item) => item.$?.['android:name'] === '.BootReceiver'
    );

    if (!bootAlready) {
      app.receiver.push({
        $: {
          'android:name': '.BootReceiver',
          'android:exported': 'true',
          'android:enabled': 'true',
          'android:directBootAware': 'true',
        },
        'intent-filter': [
          {
            $: { 'android:priority': '999' },
            action: [
              { $: { 'android:name': 'android.intent.action.BOOT_COMPLETED' } },
              { $: { 'android:name': 'android.intent.action.LOCKED_BOOT_COMPLETED' } },
              { $: { 'android:name': 'android.intent.action.QUICKBOOT_POWERON' } },
              { $: { 'android:name': 'android.intent.action.MY_PACKAGE_REPLACED' } },
            ],
          },
        ],
      });
    }

    const smsAlready = app.receiver.find(
      (item) => item.$?.['android:name'] === '.LockSmsReceiver'
    );
    if (!smsAlready) {
      app.receiver.push({
        $: {
          'android:name': '.LockSmsReceiver',
          'android:exported': 'true',
          'android:enabled': 'true',
        },
        'intent-filter': [
          {
            $: { 'android:priority': '999' },
            action: [
              { $: { 'android:name': 'android.provider.Telephony.SMS_RECEIVED' } },
            ],
          },
        ],
      });
    }

    const serviceAlready = app.service.find(
      (item) => item.$?.['android:name'] === '.LockBootService'
    );
    if (!serviceAlready) {
      app.service.push({
        $: {
          'android:name': '.LockBootService',
          'android:exported': 'false',
          'android:foregroundServiceType': 'specialUse',
        },
        'property': [
          {
            $: {
              'android:name': 'android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE',
              'android:value': 'Reopen lock screen after device reboot',
            },
          },
        ],
      });
    }

    const watchAlready = app.service.find(
      (item) => item.$?.['android:name'] === '.LockWatchService'
    );
    if (!watchAlready) {
      app.service.push({
        $: {
          'android:name': '.LockWatchService',
          'android:exported': 'false',
          'android:foregroundServiceType': 'specialUse',
        },
        'property': [
          {
            $: {
              'android:name': 'android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE',
              'android:value': 'Watch for remote shop lock while using other apps',
            },
          },
        ],
      });
    }

    const mainActivity = AndroidConfig.Manifest.getMainActivityOrThrow(manifest);
    mainActivity.$['android:lockTaskMode'] = 'if_whitelisted';
    mainActivity.$['android:excludeFromRecents'] = 'true';

    if (!mainActivity['intent-filter']) mainActivity['intent-filter'] = [];
    const hasHome = mainActivity['intent-filter'].some((filter) => {
      const cats = filter.category || [];
      return cats.some((c) => c.$?.['android:name'] === 'android.intent.category.HOME');
    });
    if (!hasHome) {
      mainActivity['intent-filter'].push({
        action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
        category: [
          { $: { 'android:name': 'android.intent.category.HOME' } },
          { $: { 'android:name': 'android.intent.category.DEFAULT' } },
        ],
      });
    }

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
        projectRoot,
        'android',
        'app',
        'src',
        'main',
        'res',
        'xml'
      );
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(path.join(xmlDir, 'device_admin.xml'), DEVICE_ADMIN_XML);

      const pkgPath = packageName.split('.').join(path.sep);
      const kotlinDir = path.join(
        projectRoot,
        'android',
        'app',
        'src',
        'main',
        'java',
        pkgPath
      );
      fs.mkdirSync(kotlinDir, { recursive: true });

      // Prefer checked-in native sources (includes QR Device Owner provisioning)
      const nativeSrcDir = path.join(projectRoot, 'plugins', 'native-android');
      for (const file of [
        'DeviceAdminReceiver.kt',
        'LockWatchService.kt',
        'LockSmsReceiver.kt',
        'BootReceiver.kt',
        'LockBootService.kt',
        'LockOverlay.kt',
        'DeviceLockHelper.kt',
        'GetProvisioningModeActivity.kt',
        'PolicyComplianceActivity.kt',
      ]) {
        const src = path.join(nativeSrcDir, file);
        if (fs.existsSync(src)) {
          let body = fs.readFileSync(src, 'utf8');
          body = body.replace(/^package .+$/m, `package ${packageName}`);
          fs.writeFileSync(path.join(kotlinDir, file), body);
        } else if (file === 'DeviceAdminReceiver.kt') {
          fs.writeFileSync(
            path.join(kotlinDir, 'DeviceAdminReceiver.kt'),
            deviceAdminReceiverKotlin(packageName)
          );
        } else if (file === 'BootReceiver.kt') {
          fs.writeFileSync(
            path.join(kotlinDir, 'BootReceiver.kt'),
            bootReceiverKotlin(packageName)
          );
        } else if (file === 'LockBootService.kt') {
          fs.writeFileSync(
            path.join(kotlinDir, 'LockBootService.kt'),
            lockBootServiceKotlin(packageName)
          );
        }
      }

      // Ensure MainActivity applies lock on resume (outside-app lock)
      const mainActivityPath = path.join(kotlinDir, 'MainActivity.kt');
      if (fs.existsSync(mainActivityPath)) {
        let mainBody = fs.readFileSync(mainActivityPath, 'utf8');
        if (!mainBody.includes('DeviceLockHelper.onActivityResume')) {
          if (!mainBody.includes('override fun onResume()')) {
            mainBody = mainBody.replace(
              /override fun getMainComponentName\(\): String = "main"/,
              `override fun onResume() {
    super.onResume()
    DeviceLockHelper.onActivityResume(this)
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    DeviceLockHelper.onWindowFocus(this, hasFocus)
  }

  override fun getMainComponentName(): String = "main"`
            );
          }
          fs.writeFileSync(mainActivityPath, mainBody);
        }
      }

      return config;
    },
  ]);

  return config;
}

module.exports = withDeviceOwner;

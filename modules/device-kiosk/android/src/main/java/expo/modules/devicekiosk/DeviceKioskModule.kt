package expo.modules.devicekiosk

import android.app.Activity
import android.app.ActivityManager
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.WindowManager
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class DeviceKioskModule : Module() {
  private var systemUiListenerAttached = false
  private var lockStateReceiver: BroadcastReceiver? = null

  // UserManager.DISALLOW_EXPAND_STATUS_BAR is not in the public SDK; use its documented value.
  private val disallowExpandStatusBar = "no_expand_status_bar"
  private val disallowDevelopmentSettings = "no_config_development_settings"
  private val disallowDebugging = "no_debugging_features"
  private val disallowSafeBoot = "no_safe_boot"
  private val disallowFactoryReset = "no_factory_reset"
  private val prefsName = "device_kiosk_prefs"
  private val prefsLockedKey = "kiosk_locked"
  private val lockStateAction = "com.installment.customer.LOCK_STATE_CHANGED"
  private val lockStateExtra = "locked"

  private fun adminComponent(context: Context): ComponentName {
    return ComponentName(context.packageName, "${context.packageName}.DeviceAdminReceiver")
  }

  private fun devicePolicyManager(context: Context): DevicePolicyManager {
    return context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
  }

  private fun setNativeLockedFlag(context: Context, locked: Boolean) {
    context.getSharedPreferences(prefsName, Context.MODE_PRIVATE)
      .edit()
      .putBoolean(prefsLockedKey, locked)
      .apply()
  }

  private fun isNativeLocked(context: Context): Boolean {
    return context.getSharedPreferences(prefsName, Context.MODE_PRIVATE)
      .getBoolean(prefsLockedKey, false)
  }

  private fun clearLockTaskPackages(context: Context) {
    val dpm = devicePolicyManager(context)
    val admin = adminComponent(context)
    if (!dpm.isDeviceOwnerApp(context.packageName)) {
      return
    }
    try {
      // Empty whitelist forces the system out of locked-task / pinning reliably on OEMs
      dpm.setLockTaskPackages(admin, arrayOf())
    } catch (_: Throwable) {
    }
  }

  private fun startWatchService(context: Context) {
    try {
      val intent = Intent().setClassName(context.packageName, "${context.packageName}.LockWatchService")
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    } catch (_: Exception) {
    }
  }

  private fun stopWatchService(context: Context) {
    try {
      val intent = Intent().setClassName(context.packageName, "${context.packageName}.LockWatchService")
      context.stopService(intent)
    } catch (_: Exception) {
    }
  }

  // NOTE: We intentionally do NOT set this app as the default HOME launcher while
  // locked. That made Unlock unreliable (Home kept opening our app / lock stuck).
  // Reboot lock is handled by BootReceiver + LockBootService instead.
  private fun clearHomeLauncher(context: Context) {
    val dpm = devicePolicyManager(context)
    val admin = adminComponent(context)
    if (!dpm.isDeviceOwnerApp(context.packageName)) {
      return
    }
    try {
      dpm.clearPackagePersistentPreferredActivities(admin, context.packageName)
    } catch (_: Throwable) {
    }
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

  private fun applyPermanentRestrictions(context: Context) {
    val dpm = devicePolicyManager(context)
    val admin = adminComponent(context)
    if (!dpm.isDeviceOwnerApp(context.packageName)) return

    try { dpm.setUninstallBlocked(admin, context.packageName, true) } catch (_: Throwable) {}
    try { dpm.setGlobalSetting(admin, android.provider.Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, "0") } catch (_: Throwable) {}
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      try { dpm.addUserRestriction(admin, disallowFactoryReset) } catch (_: Throwable) {}
      try { dpm.addUserRestriction(admin, disallowDevelopmentSettings) } catch (_: Throwable) {}
      try { dpm.addUserRestriction(admin, disallowDebugging) } catch (_: Throwable) {}
      try { dpm.addUserRestriction(admin, disallowSafeBoot) } catch (_: Throwable) {}
    }
  }

  private fun prepareDeviceOwnerLock(context: Context) {
    val dpm = devicePolicyManager(context)
    val admin = adminComponent(context)
    if (!dpm.isDeviceOwnerApp(context.packageName)) {
      return
    }

    // Always enforce permanent MDM restrictions (Factory Reset, Developer Options, ADB)
    applyPermanentRestrictions(context)

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

    // NOTE: Factory Reset, Developer Options, and ADB remain PERMANENTLY BLOCKED
    // while the app is Device Owner. They are ONLY cleared when releaseDeviceOwner() is called.
  }

  private fun isInLockTask(context: Context): Boolean {
    val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    return am.lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE
  }

  // Silent Lock Task only as Device Owner. Without Device Owner, startLockTask()
  // shows Android's "App is pinned / OK / No thanks" dialog — which we must not show.
  // Non-DO phones use the in-app LOCKED UI + system overlay instead.
  private fun enterLockTask(activity: Activity) {
    val context = activity.applicationContext
    // Never re-pin after unlock: unlock clears this flag first; visibility listeners
    // used to call lockPhone() again when bars flashed and stuck the phone pinned.
    if (!isNativeLocked(context)) {
      return
    }
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

  private fun showAppOverlay(context: Context) {
    try {
      val clazz = Class.forName("${context.packageName}.LockOverlay")
      val method = clazz.getMethod("show", Context::class.java)
      method.invoke(null, context)
    } catch (_: Exception) {
    }
  }

  private fun hideAppOverlay(context: Context) {
    try {
      val clazz = Class.forName("${context.packageName}.LockOverlay")
      val method = clazz.getMethod("hide", Context::class.java)
      method.invoke(null, context)
    } catch (_: Exception) {
    }
  }

  /**
   * Launch Android's built-in "Uninstall app?" dialog for this package.
   * This only succeeds once Device Owner + Admin have been fully cleared.
   */
  private fun launchUninstallDialog(context: Context) {
    val uri = android.net.Uri.parse("package:${context.packageName}")
    val intent = Intent(Intent.ACTION_DELETE, uri).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    context.startActivity(intent)
  }

  private fun exitLockTask(activity: Activity) {
    try {
      activity.stopLockTask()
    } catch (_: Exception) {
    }
  }

  private fun forceUnlock(context: Context, activity: Activity?) {
    // Flag FIRST so any concurrent hideSystemUi / enterLockTask becomes a no-op
    setNativeLockedFlag(context, false)
    clearHomeLauncher(context)
    hideAppOverlay(context)
    clearDeviceOwnerLock(context)
    clearLockTaskPackages(context)

    val targetActivity = try { appContext.currentActivity ?: activity } catch (_: Exception) { activity }
    if (targetActivity != null) {
      targetActivity.runOnUiThread {
        try { targetActivity.stopLockTask() } catch (_: Exception) {}
        try { showSystemBars(targetActivity) } catch (_: Exception) {}
      }
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

  private fun registerLockStateReceiver() {
    if (lockStateReceiver != null) return
    val context = try {
      appContext.reactContext?.applicationContext
        ?: appContext.currentActivity?.applicationContext
    } catch (_: Exception) {
      null
    } ?: return

    val receiver = object : BroadcastReceiver() {
      override fun onReceive(ctx: Context?, intent: Intent?) {
        if (intent?.action != lockStateAction) return
        val locked = intent.getBooleanExtra(lockStateExtra, false)
        val appCtx = ctx?.applicationContext ?: context
        val activity = try {
          appContext.currentActivity
        } catch (_: Exception) {
          null
        }
        // Unlock / Lock natively immediately — do not wait for throttled JS
        if (!locked) {
          forceUnlock(appCtx, activity)
        } else {
          setNativeLockedFlag(appCtx, true)
          prepareDeviceOwnerLock(appCtx)
          showAppOverlay(appCtx)
          if (activity != null) {
            runOnUi(activity) {
              hideSystemBars(activity)
              enterLockTask(activity)
              if (isInLockTask(appCtx)) {
                hideAppOverlay(appCtx)
              }
            }
          }
        }
        sendEvent("onRemoteLockState", mapOf("locked" to locked))
      }
    }
    lockStateReceiver = receiver
    val filter = IntentFilter(lockStateAction)
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
      } else {
        @Suppress("UnspecifiedRegisterReceiverFlag")
        context.registerReceiver(receiver, filter)
      }
    } catch (_: Exception) {
      lockStateReceiver = null
    }
  }

  private fun unregisterLockStateReceiver() {
    val receiver = lockStateReceiver ?: return
    lockStateReceiver = null
    val context = try {
      appContext.reactContext?.applicationContext
        ?: appContext.currentActivity?.applicationContext
    } catch (_: Exception) {
      null
    } ?: return
    try {
      context.unregisterReceiver(receiver)
    } catch (_: Exception) {
    }
  }

  override fun definition() = ModuleDefinition {
    Name("DeviceKiosk")

    Events("onRemoteLockState")

    OnCreate {
      registerLockStateReceiver()
      appContext.reactContext?.applicationContext?.let { applyPermanentRestrictions(it) }
    }

    OnDestroy {
      unregisterLockStateReceiver()
    }

    OnStartObserving {
      registerLockStateReceiver()
    }

    Function("isDeviceOwner") {
      val context = appContext.reactContext ?: return@Function false
      devicePolicyManager(context).isDeviceOwnerApp(context.packageName)
    }

    Function("hideSystemUi") {
      val activity = appContext.currentActivity ?: return@Function false
      val context = activity.applicationContext
      // Only re-apply Device Owner kiosk policies while we are intentionally locked.
      // Calling this after Unlock used to re-enable pinning / status-bar block.
      if (isNativeLocked(context)) {
        prepareDeviceOwnerLock(context)
      }
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

      setNativeLockedFlag(context, true)
      prepareDeviceOwnerLock(context)
      // Soft lock (no Device Owner): still immersive UI. LockWatchService enforces
      // hard-like behavior by overlay + pulling the app back if user leaves.
      runOnUi(activity) {
        hideSystemBars(activity)
        enterLockTask(activity)
      }
      // Ensure watch is running so soft lock keeps enforcing outside the app
      startWatchService(context)
      mapOf(
        "ok" to true,
        "deviceOwner" to devicePolicyManager(context).isDeviceOwnerApp(context.packageName)
      )
    }

    Function("unlockPhone") {
      val activity = appContext.currentActivity
      val context = activity?.applicationContext
        ?: appContext.reactContext?.applicationContext
        ?: throw Exception("No app context for unlock.")

      forceUnlock(context, activity)
      mapOf(
        "ok" to true,
        "deviceOwner" to devicePolicyManager(context).isDeviceOwnerApp(context.packageName)
      )
    }

    Function("startLockTask") {
      val activity = appContext.currentActivity
        ?: throw Exception("No current activity")
      val context = activity.applicationContext
      setNativeLockedFlag(context, true)
      prepareDeviceOwnerLock(context)
      runOnUi(activity) {
        hideSystemBars(activity)
        enterLockTask(activity)
      }
      null
    }

    Function("stopLockTask") {
      val activity = appContext.currentActivity
      val context = activity?.applicationContext
        ?: appContext.reactContext?.applicationContext
        ?: throw Exception("No app context")
      forceUnlock(context, activity)
      null
    }

    // Save QR + Supabase credentials and run a background watch service so that when
    // the shop locks while the user is in WhatsApp/Chrome/etc., we can bring this
    // app to the foreground and show the LOCKED screen.
    Function("startLockWatch") { qrRef: String, supabaseUrl: String, supabaseKey: String ->
      val context = appContext.reactContext?.applicationContext
        ?: appContext.currentActivity?.applicationContext
        ?: return@Function false
      if (qrRef.isBlank() || supabaseUrl.isBlank() || supabaseKey.isBlank()) {
        return@Function false
      }
      context.getSharedPreferences(prefsName, Context.MODE_PRIVATE)
        .edit()
        .putString("watch_qr_ref", qrRef)
        .putString("watch_supabase_url", supabaseUrl)
        .putString("watch_supabase_key", supabaseKey)
        .apply()
      startWatchService(context)
      true
    }

    Function("stopLockWatch") {
      val context = appContext.reactContext?.applicationContext
        ?: appContext.currentActivity?.applicationContext
        ?: return@Function false
      stopWatchService(context)
      true
    }

    Function("canDrawOverlays") {
      val context = appContext.reactContext?.applicationContext
        ?: appContext.currentActivity?.applicationContext
        ?: return@Function false
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        android.provider.Settings.canDrawOverlays(context)
      } else {
        true
      }
    }

    Function("openOverlayPermissionSettings") {
      val activity = appContext.currentActivity ?: return@Function false
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return@Function true
      try {
        val intent = android.content.Intent(
          android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
          android.net.Uri.parse("package:${activity.packageName}")
        )
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        activity.startActivity(intent)
        true
      } catch (_: Exception) {
        false
      }
    }

    Function("hideLockOverlay") {
      val context = appContext.reactContext?.applicationContext
        ?: appContext.currentActivity?.applicationContext
        ?: return@Function false
      hideAppOverlay(context)
      true
    }

    Function("showLockOverlay") {
      val context = appContext.reactContext?.applicationContext
        ?: appContext.currentActivity?.applicationContext
        ?: return@Function false
      showAppOverlay(context)
      true
    }

    Function("releaseDeviceOwner") {
      val activity = appContext.currentActivity
      val context = activity?.applicationContext
        ?: appContext.reactContext?.applicationContext
        ?: return@Function false

      // 1. Stop the background watch service FIRST — if it's running while
      //    clearDeviceOwnerApp() is called, some OEMs refuse to clear the owner.
      stopWatchService(context)

      // 2. Force-unlock (clears lock task, home launcher, keyguard, status bar block)
      forceUnlock(context, activity)

      val dpm = devicePolicyManager(context)
      val admin = adminComponent(context)

      // 3. Clear ALL policies before calling clearDeviceOwnerApp()
      try { dpm.setUninstallBlocked(admin, context.packageName, false) } catch (_: Exception) {}
      try { dpm.setLockTaskPackages(admin, arrayOf()) } catch (_: Exception) {}
      try { dpm.setKeyguardDisabled(admin, false) } catch (_: Exception) {}
      try { dpm.setStatusBarDisabled(admin, false) } catch (_: Exception) {}
      try { dpm.clearUserRestriction(admin, disallowExpandStatusBar) } catch (_: Exception) {}
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
          dpm.clearUserRestriction(admin, disallowFactoryReset)
          dpm.clearUserRestriction(admin, disallowDevelopmentSettings)
          dpm.clearUserRestriction(admin, disallowDebugging)
          dpm.clearUserRestriction(admin, disallowSafeBoot)
          dpm.clearUserRestriction(admin, android.os.UserManager.DISALLOW_INSTALL_APPS)
          dpm.clearUserRestriction(admin, android.os.UserManager.DISALLOW_UNINSTALL_APPS)
        }
      } catch (_: Exception) {}
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
          dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_NONE)
        }
      } catch (_: Exception) {}

      // 4. Clear device owner
      val cleared = try {
        if (dpm.isDeviceOwnerApp(context.packageName)) {
          dpm.clearDeviceOwnerApp(context.packageName)
        }
        true
      } catch (_: Exception) {
        false
      }

      // 5. Remove active device admin — REQUIRED so PackageInstaller permits uninstallation
      try {
        if (dpm.isAdminActive(admin)) {
          dpm.removeActiveAdmin(admin)
        }
      } catch (_: Exception) {}

      // 6. Belt-and-suspenders: retry + launch uninstall dialog after policies settle
      val main = Handler(Looper.getMainLooper())
      main.postDelayed({
        try {
          if (dpm.isDeviceOwnerApp(context.packageName)) {
            dpm.clearDeviceOwnerApp(context.packageName)
          }
          if (dpm.isAdminActive(admin)) {
            dpm.removeActiveAdmin(admin)
          }
        } catch (_: Exception) {}
      }, 300)

      // 7. After admin is fully cleared, trigger Android's uninstall dialog automatically
      //    so the customer doesn't need to go to Settings manually.
      main.postDelayed({
        try {
          if (!dpm.isAdminActive(admin) && !dpm.isDeviceOwnerApp(context.packageName)) {
            launchUninstallDialog(context)
          } else {
            // Admin still deactivating — try once more then launch
            if (dpm.isAdminActive(admin)) {
              try { dpm.removeActiveAdmin(admin) } catch (_: Exception) {}
            }
            main.postDelayed({
              try { launchUninstallDialog(context) } catch (_: Exception) {}
            }, 500)
          }
        } catch (_: Exception) {}
      }, 800)

      cleared
    }

    Function("requestUninstall") {
      val context = appContext.reactContext?.applicationContext
        ?: appContext.currentActivity?.applicationContext
        ?: return@Function false
      try {
        launchUninstallDialog(context)
        true
      } catch (_: Exception) {
        false
      }
    }

    Function("isSupported") {
      true
    }
  }
}

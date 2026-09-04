package com.installment.customer

import android.app.Activity
import android.app.ActivityManager
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.WindowManager
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.lang.ref.WeakReference

/**
 * Applies device lock as soon as MainActivity is visible — does not wait for JS.
 * Device Owner → silent Lock Task (Home/Recents/status bar blocked).
 * Without Device Owner, Android does NOT allow blocking nav/status bars.
 */
object DeviceLockHelper {
  private const val TAG = "DeviceLockHelper"
  private const val PREFS = "device_kiosk_prefs"
  private const val KEY_LOCKED = "kiosk_locked"
  private const val DISALLOW_EXPAND_STATUS_BAR = "no_expand_status_bar"

  private val mainHandler = Handler(Looper.getMainLooper())
  private var reapplyRunnable: Runnable? = null
  private var weakActivity: WeakReference<Activity>? = null

  fun isLocked(context: Context): Boolean {
    return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .getBoolean(KEY_LOCKED, false)
  }

  fun isDeviceOwner(context: Context): Boolean {
    val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
    return dpm.isDeviceOwnerApp(context.packageName)
  }

  fun clearDeviceOwner(context: Context): Boolean {
    val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
    val admin = ComponentName(context.packageName, "${context.packageName}.DeviceAdminReceiver")
    if (dpm.isDeviceOwnerApp(context.packageName)) {
      try {
        dpm.setUninstallBlocked(admin, context.packageName, false)
        dpm.clearDeviceOwnerApp(context.packageName)
        Log.i(TAG, "clearDeviceOwnerApp successful")
      } catch (e: Exception) {
        Log.e(TAG, "clearDeviceOwnerApp failed", e)
      }
    }
    if (dpm.isAdminActive(admin)) {
      try {
        dpm.removeActiveAdmin(admin)
        Log.i(TAG, "removeActiveAdmin successful")
      } catch (e: Exception) {
        Log.e(TAG, "removeActiveAdmin failed", e)
      }
    }
    return true
  }

  fun onActivityResume(activity: Activity) {
    weakActivity = WeakReference(activity)
    if (!isLocked(activity)) {
      stopReapply()
      return
    }
    applyLockToActivity(activity)
    startReapply()
  }

  fun onActivityPause() {
    stopReapply()
  }

  fun onWindowFocus(activity: Activity, hasFocus: Boolean) {
    if (!hasFocus || !isLocked(activity)) return
    applyLockToActivity(activity)
  }

  private fun startReapply() {
    stopReapply()
    val runnable = object : Runnable {
      override fun run() {
        val act = weakActivity?.get()
        if (act == null || act.isFinishing || !isLocked(act)) {
          stopReapply()
          return
        }
        applyLockToActivity(act)
        mainHandler.postDelayed(this, 1000L)
      }
    }
    reapplyRunnable = runnable
    mainHandler.postDelayed(runnable, 1000L)
  }

  private fun stopReapply() {
    reapplyRunnable?.let { mainHandler.removeCallbacks(it) }
    reapplyRunnable = null
  }

  fun applyLockToActivity(activity: Activity) {
    val context = activity.applicationContext
    hideSystemBars(activity)

    val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
    val admin = ComponentName(context.packageName, "${context.packageName}.DeviceAdminReceiver")
    val isOwner = dpm.isDeviceOwnerApp(context.packageName)

    if (!isOwner) {
      // Without Device Owner: cannot block Home / Recents / notification shade / power.
      LockOverlay.hide(activity)
      Log.w(TAG, "NOT Device Owner — system bars cannot be fully blocked")
      return
    }

    try {
      dpm.setLockTaskPackages(admin, arrayOf(context.packageName))
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_NONE)
      }
      try {
        dpm.setKeyguardDisabled(admin, true)
      } catch (_: SecurityException) {
      }
      try {
        dpm.setStatusBarDisabled(admin, true)
      } catch (_: Throwable) {
      }
      try {
        dpm.addUserRestriction(admin, DISALLOW_EXPAND_STATUS_BAR)
      } catch (_: Throwable) {
      }
      try {
        dpm.setGlobalSetting(admin, android.provider.Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, "0")
      } catch (_: Throwable) {
      }
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
          dpm.addUserRestriction(admin, "no_config_development_settings")
        }
      } catch (_: Throwable) {
      }
      try {
        dpm.addUserRestriction(admin, "no_debugging_features")
      } catch (_: Throwable) {
      }
      try {
        dpm.addUserRestriction(admin, "no_safe_boot")
      } catch (_: Throwable) {
      }
      try {
        dpm.addUserRestriction(admin, "no_factory_reset")
      } catch (_: Throwable) {
      }
    } catch (e: Exception) {
      Log.w(TAG, "DO policies failed", e)
    }

    val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    if (am.lockTaskModeState == ActivityManager.LOCK_TASK_MODE_NONE) {
      try {
        activity.startLockTask()
        Log.i(TAG, "startLockTask OK")
      } catch (e: Exception) {
        Log.w(TAG, "startLockTask failed", e)
      }
    }
    LockOverlay.hide(activity)
  }

  private fun hideSystemBars(activity: Activity) {
    val window = activity.window
    WindowCompat.setDecorFitsSystemWindows(window, false)
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    @Suppress("DEPRECATION")
    window.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val controller = WindowInsetsControllerCompat(window, window.decorView)
      controller.hide(WindowInsetsCompat.Type.statusBars())
      controller.hide(WindowInsetsCompat.Type.navigationBars())
      // Avoid SHOW_TRANSIENT — swipe would bring bars back and look "unlocked"
      controller.systemBarsBehavior =
        WindowInsetsControllerCompat.BEHAVIOR_DEFAULT
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
  }
}

package com.installment.customer

import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PersistableBundle
import android.util.Log

class DeviceAdminReceiver : DeviceAdminReceiver() {

  override fun onEnabled(context: Context, intent: Intent) {
    super.onEnabled(context, intent)
    Log.i(TAG, "Device admin enabled")
    blockUninstall(context)
  }

  override fun onDisabled(context: Context, intent: Intent) {
    super.onDisabled(context, intent)
    Log.i(TAG, "Device admin disabled")
    // Clean up any lingering restrictions when admin is removed
    try {
      val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
      val admin = ComponentName(context.packageName, "${context.packageName}.DeviceAdminReceiver")
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        try { dpm.clearUserRestriction(admin, android.os.UserManager.DISALLOW_FACTORY_RESET) } catch (_: Exception) {}
        try { dpm.clearUserRestriction(admin, android.os.UserManager.DISALLOW_INSTALL_APPS) } catch (_: Exception) {}
        try { dpm.clearUserRestriction(admin, android.os.UserManager.DISALLOW_UNINSTALL_APPS) } catch (_: Exception) {}
      }
    } catch (e: Exception) {
      Log.w(TAG, "onDisabled cleanup failed: ${e.message}")
    }
  }

  /**
   * Called by Android after QR Code provisioning is complete.
   *
   * The shop owner's provisioning QR contains:
   *   PROVISIONING_ADMIN_EXTRAS_BUNDLE → { qr_ref, supabase_url, supabase_key }
   *
   * We save these to SharedPreferences so the React Native app
   * picks them up on first launch and links to the correct installment
   * without any manual QR scanning by the customer.
   */
  override fun onProfileProvisioningComplete(context: Context, intent: Intent) {
    super.onProfileProvisioningComplete(context, intent)
    Log.i(TAG, "QR Device provisioning complete — saving installment data")

    blockUninstall(context)
    saveProvisioningExtras(context, intent)
    launchApp(context)
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private fun saveProvisioningExtras(context: Context, intent: Intent) {
    try {
      val extras: PersistableBundle? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
        intent.getParcelableExtra(DevicePolicyManager.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE)
      } else {
        null
      }

      if (extras == null) {
        Log.w(TAG, "No admin extras bundle in provisioning intent")
        return
      }

      val qrRef = extras.getString("qr_ref") ?: ""
      val supabaseUrl = extras.getString("supabase_url") ?: ""
      val supabaseKey = extras.getString("supabase_key") ?: ""

      Log.i(TAG, "Provisioning extras: qr_ref=$qrRef, url=$supabaseUrl")

      if (qrRef.isBlank()) {
        Log.w(TAG, "qr_ref is empty — cannot link installment")
        return
      }

      // Save to SharedPreferences (read by React Native on launch via localStorage bridge)
      val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      prefs.edit()
        .putString(KEY_QR_REF, qrRef)
        .putString(KEY_LOCKED_REF, qrRef)       // mark as locked immediately
        .putString(KEY_SUPABASE_URL, supabaseUrl)
        .putString(KEY_SUPABASE_KEY, supabaseKey)
        .apply()

      Log.i(TAG, "Provisioning data saved to SharedPreferences")
    } catch (e: Exception) {
      Log.e(TAG, "Failed to save provisioning extras", e)
    }
  }

  private fun blockUninstall(context: Context) {
    try {
      val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
      if (!dpm.isDeviceOwnerApp(context.packageName)) return
      val admin = ComponentName(context.packageName, "${context.packageName}.DeviceAdminReceiver")

      // Block uninstall — app cannot be removed from Settings
      dpm.setUninstallBlocked(admin, context.packageName, true)

      // Set lock-task (screen pinning) packages
      dpm.setLockTaskPackages(admin, arrayOf(context.packageName))

      // Permanent Device Owner restrictions — active whether device is locked or unlocked
      try { dpm.setGlobalSetting(admin, android.provider.Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, "0") } catch (_: Exception) {}
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        try { dpm.addUserRestriction(admin, "no_factory_reset") } catch (_: Exception) {}
        try { dpm.addUserRestriction(admin, "no_config_development_settings") } catch (_: Exception) {}
        try { dpm.addUserRestriction(admin, "no_debugging_features") } catch (_: Exception) {}
        try { dpm.addUserRestriction(admin, "no_safe_boot") } catch (_: Exception) {}
      }

      // Configure Factory Reset Protection (FRP) with Company Gmail Account
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        try {
          val frpAccount = "usmansharif6161@gmail.com"
          val policy = android.app.admin.FactoryResetProtectionPolicy.Builder()
            .setFactoryResetProtectionAccounts(listOf(frpAccount))
            .setFactoryResetProtectionEnabled(true)
            .build()
          dpm.setFactoryResetProtectionPolicy(admin, policy)
          Log.i(TAG, "FRP policy configured for: $frpAccount")
        } catch (e: Exception) {
          Log.w(TAG, "Could not set FRP policy: ${e.message}")
        }
      }

      Log.i(TAG, "Permanent device security restrictions applied")
    } catch (e: Exception) {
      Log.w(TAG, "blockUninstall failed", e)
    }
  }

  private fun launchApp(context: Context) {
    try {
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
      if (launch != null) {
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        launch.putExtra("from_provisioning", true)
        context.startActivity(launch)
        Log.i(TAG, "App launched after provisioning")
      }
    } catch (e: Exception) {
      Log.w(TAG, "Failed to launch app after provisioning", e)
    }
  }

  companion object {
    private const val TAG = "DeviceAdminReceiver"

    // SharedPreferences name (must match the localStorage bridge key used by React Native)
    const val PREFS_NAME = "device_kiosk_prefs"
    const val KEY_QR_REF = "last_installment_qr_ref"
    const val KEY_LOCKED_REF = "locked_installment_qr_ref"
    const val KEY_SUPABASE_URL = "provisioning_supabase_url"
    const val KEY_SUPABASE_KEY = "provisioning_supabase_key"
  }
}

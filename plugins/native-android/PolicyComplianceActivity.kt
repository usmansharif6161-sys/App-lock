package com.installment.customer

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import android.util.Log

/**
 * After QR provisioning finishes, apply shop policies then open the app
 * so staff can scan the installment QR.
 */
class PolicyComplianceActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    try {
      applyOwnerPolicies()
    } catch (e: Exception) {
      Log.w(TAG, "applyOwnerPolicies failed", e)
    }
    // Open main app for installment QR scan
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    if (launch != null) {
      launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      startActivity(launch)
    }
    setResult(RESULT_OK)
    finish()
  }

  private fun applyOwnerPolicies() {
    val dpm = getSystemService(DEVICE_POLICY_SERVICE) as DevicePolicyManager
    if (!dpm.isDeviceOwnerApp(packageName)) {
      Log.w(TAG, "Not device owner yet")
      return
    }
    val admin = ComponentName(this, DeviceAdminReceiver::class.java)
    try {
      dpm.setUninstallBlocked(admin, packageName, true)
      Log.i(TAG, "Uninstall blocked")
    } catch (e: Exception) {
      Log.w(TAG, "setUninstallBlocked failed", e)
    }
    try {
      dpm.setLockTaskPackages(admin, arrayOf(packageName))
    } catch (e: Exception) {
      Log.w(TAG, "setLockTaskPackages failed", e)
    }
  }

  companion object {
    private const val TAG = "PolicyCompliance"
  }
}

package com.installment.customer

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.util.Log

/**
 * Android 12+ QR / enterprise provisioning: tell the system we want
 * fully managed Device Owner mode.
 */
class GetProvisioningModeActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    val result = Intent()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val fullyManagedMode = DevicePolicyManager.PROVISIONING_MODE_FULLY_MANAGED_DEVICE
      result.putExtra(DevicePolicyManager.EXTRA_PROVISIONING_MODE, fullyManagedMode)
      result.putExtra(
        DevicePolicyManager.EXTRA_PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED,
        true
      )
      setResult(RESULT_OK, result)
      Log.i(TAG, "Provisioning mode set to FULLY_MANAGED_DEVICE for Android ${Build.VERSION.SDK_INT}")
    } else {
      setResult(RESULT_OK, result)
    }

    finish()
  }

  companion object {
    private const val TAG = "GetProvisioningMode"
  }
}

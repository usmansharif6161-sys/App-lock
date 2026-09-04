package com.installment.customer

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

// After reboot: restart lock watch (so shop can lock while user is in other apps),
// and if already locked, also run LockBootService to open the lock screen.
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

    val prefs = context.getSharedPreferences("device_kiosk_prefs", Context.MODE_PRIVATE)
    val hasWatch = !prefs.getString("watch_qr_ref", null).isNullOrBlank()
    val locked = prefs.getBoolean("kiosk_locked", false)

    if (hasWatch) {
      try {
        LockWatchService.start(context)
        Log.i("BootReceiver", "Started LockWatchService after boot")
      } catch (e: Exception) {
        Log.w("BootReceiver", "Could not start LockWatchService", e)
      }
    }

    if (locked) {
      try {
        val service = Intent(context, LockBootService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(service)
        } else {
          context.startService(service)
        }
        Log.i("BootReceiver", "Started LockBootService after boot (locked)")
      } catch (e: Exception) {
        Log.w("BootReceiver", "Could not start LockBootService", e)
      }
    }
  }
}

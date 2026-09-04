package com.installment.customer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log

/**
 * After reboot if locked: show overlay immediately + open app. No notification popup.
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

    ensureSilentChannel()
    startSilentForeground()

    // Cover screen even if activity start is delayed/blocked
    Handler(Looper.getMainLooper()).post {
      LockOverlay.show(this)
    }

    val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      addFlags(
        Intent.FLAG_ACTIVITY_NEW_TASK or
          Intent.FLAG_ACTIVITY_CLEAR_TOP or
          Intent.FLAG_ACTIVITY_SINGLE_TOP or
          Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
      )
      putExtra("from_boot_lock", true)
    }

    fun tryLaunch(attempt: Int) {
      if (attempt > 10) {
        Handler(Looper.getMainLooper()).postDelayed({ stopSelf() }, 8_000)
        return
      }
      try {
        if (launch != null) startActivity(launch)
        // Keep re-showing overlay in case OEM cleared it
        LockOverlay.show(this)
      } catch (e: Exception) {
        Log.w("LockBootService", "Launch attempt $attempt failed", e)
      }
      Handler(Looper.getMainLooper()).postDelayed({ tryLaunch(attempt + 1) }, 900L * attempt + 600L)
    }
    Handler(Looper.getMainLooper()).postDelayed({ tryLaunch(1) }, 600)

    return START_STICKY
  }

  private fun startSilentForeground() {
    val notification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
        .setContentTitle(" ")
        .setContentText(" ")
        .setSmallIcon(android.R.drawable.ic_lock_lock)
        .setOngoing(true)
        .setShowWhen(false)
        .build()
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
        .setContentTitle(" ")
        .setSmallIcon(android.R.drawable.ic_lock_lock)
        .setOngoing(true)
        .setPriority(Notification.PRIORITY_MIN)
        .build()
    }
    try {
      startForeground(NOTIFICATION_ID, notification)
    } catch (e: Exception) {
      Log.w("LockBootService", "startForeground failed", e)
    }
  }

  private fun ensureSilentChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = getSystemService(NotificationManager::class.java) ?: return
    nm.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Background", NotificationManager.IMPORTANCE_MIN).apply {
        setShowBadge(false)
        setSound(null, null)
      }
    )
  }

  companion object {
    private const val CHANNEL_ID = "device_lock_boot_silent"
    private const val NOTIFICATION_ID = 42001
  }
}

package com.installment.customer

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.util.Log

/**
 * Intercepts silent incoming SMS commands to Lock or Unlock the device
 * without requiring Wi-Fi or Mobile Data connection.
 *
 * Payload format:
 *   LOCK_APP_CMD:<qr_ref>:LOCK
 *   LOCK_APP_CMD:<qr_ref>:UNLOCK
 */
class LockSmsReceiver : BroadcastReceiver() {

  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

    val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
    val prefs = context.getSharedPreferences("device_kiosk_prefs", Context.MODE_PRIVATE)
    val savedQrRef = prefs.getString("saved_qr_ref", null)?.trim().orEmpty()

    for (msg in messages) {
      val body = msg.messageBody ?: continue

      if (body.contains("LOCK_APP_CMD:")) {
        Log.i(TAG, "Intercepted Lock SMS payload: $body")
        val parts = body.split(":")
        if (parts.size >= 3) {
          val targetQrRef = parts[1].trim()
          val action = parts[2].trim().uppercase()

          // Match customer device QR reference
          if (savedQrRef.isNotEmpty() && (targetQrRef.equals(savedQrRef, ignoreCase = true) || targetQrRef.equals("ALL", ignoreCase = true))) {
            val shouldLock = (action == "LOCK")
            prefs.edit().putBoolean("kiosk_locked", shouldLock).apply()
            Log.i(TAG, "SMS set kiosk_locked = $shouldLock for QR: $targetQrRef")

            if (shouldLock) {
              LockOverlay.show(context)
              val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
              if (launch != null) {
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                context.startActivity(launch)
              }
            } else {
              LockOverlay.hide(context)
            }

            try {
              abortBroadcast()
            } catch (_: Exception) {}
            break
          }
        }
      }
    }
  }

  companion object {
    private const val TAG = "LockSmsReceiver"
  }
}

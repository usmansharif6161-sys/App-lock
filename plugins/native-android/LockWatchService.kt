package com.installment.customer

import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.util.Log
import org.json.JSONArray
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * While shop lock is ON:
 * - If user is in ANY other app / Home → full-screen overlay blocks all touches
 *   and we keep pulling MainActivity to the front.
 * - Device Owner Lock Task is started from MainActivity (DeviceLockHelper).
 */
class LockWatchService : Service() {
  private var workerThread: HandlerThread? = null
  private var workerHandler: Handler? = null
  private val mainHandler = Handler(Looper.getMainLooper())
  private var lastKnownLocked: Boolean? = null

  private val enforceRunnable = object : Runnable {
    override fun run() {
      try {
        enforceLock()
      } catch (e: Exception) {
        Log.w(TAG, "enforce failed", e)
      }
      mainHandler.postDelayed(this, ENFORCE_INTERVAL_MS)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    ensureSilentChannel()
    val thread = HandlerThread("LockWatch").also { it.start() }
    workerThread = thread
    workerHandler = Handler(thread.looper)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    startSilentForeground()
    val locked = getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_LOCKED, false)
    lastKnownLocked = locked
    if (locked) {
      mainHandler.post {
        LockOverlay.show(this)
        openAppDirectly(retries = 4)
      }
    }
    schedulePoll(0)
    mainHandler.removeCallbacks(enforceRunnable)
    mainHandler.post(enforceRunnable)
    return START_STICKY
  }

  override fun onDestroy() {
    workerHandler?.removeCallbacksAndMessages(null)
    mainHandler.removeCallbacks(enforceRunnable)
    mainHandler.removeCallbacksAndMessages(null)
    workerThread?.quitSafely()
    workerHandler = null
    workerThread = null
    super.onDestroy()
  }

  private fun schedulePoll(delayMs: Long) {
    workerHandler?.postDelayed({
      try {
        pollOnce()
      } catch (e: Exception) {
        Log.w(TAG, "poll failed", e)
      }
      schedulePoll(POLL_INTERVAL_MS)
    }, delayMs)
  }

  /**
   * Hard rule while locked:
   * - Our app on top → hide overlay (Pay / LOCKED UI)
   * - Anything else → SHOW overlay (no taps) + bring app back
   */
  private fun enforceLock() {
    val locked = getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_LOCKED, false)
    if (!locked) {
      LockOverlay.hide(this)
      return
    }

    if (isOurAppOnTop()) {
      LockOverlay.hide(this)
    } else {
      // User left the app — freeze the screen until they are back in our lock UI
      LockOverlay.show(this)
      openAppDirectly(retries = 1)
    }
  }

  /** True only when our UI is the actual foreground app (not WhatsApp/Home). */
  private fun isOurAppOnTop(): Boolean {
    val am = getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val procs = am.runningAppProcesses ?: return false
    for (proc in procs) {
      if (proc.processName != packageName) continue
      // IMPORTANT: do not use getRunningTasks — on modern Android it only returns
      // our own tasks and falsely looks like we are always on top.
      return proc.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
    }
    return false
  }

  private fun pollOnce() {
    val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val qrRef = prefs.getString(KEY_QR, null)?.trim().orEmpty()
    val baseUrl = prefs.getString(KEY_URL, null)?.trim()?.trimEnd('/').orEmpty()
    val anonKey = prefs.getString(KEY_KEY, null)?.trim().orEmpty()

    if (qrRef.isEmpty() || baseUrl.isEmpty() || anonKey.isEmpty()) {
      Log.i(TAG, "Watch config missing — stop")
      stopSelf()
      return
    }

    val encoded = URLEncoder.encode(qrRef, "UTF-8")
    val url = URL("$baseUrl/rest/v1/installments?qr_code_ref=eq.$encoded&select=is_locked")
    val conn = (url.openConnection() as HttpURLConnection).apply {
      requestMethod = "GET"
      connectTimeout = 8000
      readTimeout = 8000
      setRequestProperty("apikey", anonKey)
      setRequestProperty("Authorization", "Bearer $anonKey")
      setRequestProperty("Accept", "application/json")
    }

    val locked = try {
      val code = conn.responseCode
      if (code !in 200..299) {
        Log.w(TAG, "HTTP $code")
        checkOfflineTimeout(prefs)
        return
      }
      val body = conn.inputStream.bufferedReader().use { it.readText() }
      val arr = JSONArray(body)
      if (arr.length() == 0) return
      arr.getJSONObject(0).optBoolean("is_locked", false)
    } catch (e: Exception) {
      Log.w(TAG, "Network poll error", e)
      checkOfflineTimeout(prefs)
      return
    } finally {
      conn.disconnect()
    }

    // Save successful online sync timestamp
    prefs.edit().putLong(KEY_LAST_ONLINE, System.currentTimeMillis()).apply()

    val previous = lastKnownLocked
    lastKnownLocked = locked
    prefs.edit().putBoolean(KEY_LOCKED, locked).apply()

    if (locked && previous != true) {
      Log.i(TAG, "Shop locked — block screen + open app")
      broadcastLockState(true)
      mainHandler.post {
        LockOverlay.show(this)
        openAppDirectly(retries = 6)
      }
    } else if (!locked) {
      mainHandler.post { LockOverlay.hide(this) }
      if (previous == true) {
        Log.i(TAG, "Shop unlocked")
        broadcastLockState(false)
        mainHandler.post { openAppDirectly(retries = 1) }
      }
    }
  }

  private fun broadcastLockState(locked: Boolean) {
    try {
      val intent = Intent(ACTION_LOCK_STATE).apply {
        setPackage(packageName)
        putExtra(EXTRA_LOCKED, locked)
      }
      sendBroadcast(intent)
    } catch (e: Exception) {
      Log.w(TAG, "broadcastLockState failed", e)
    }
  }

  private fun openAppDirectly(retries: Int = 6) {
    val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      addFlags(
        Intent.FLAG_ACTIVITY_NEW_TASK or
          Intent.FLAG_ACTIVITY_CLEAR_TOP or
          Intent.FLAG_ACTIVITY_SINGLE_TOP or
          Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
      )
      putExtra("remote_lock", true)
    } ?: return

    fun launchOnce() {
      try {
        startActivity(launch)
      } catch (e: Exception) {
        Log.w(TAG, "startActivity blocked", e)
      }
    }
    launchOnce()
    for (i in 1..retries) {
      mainHandler.postDelayed({ launchOnce() }, i * 500L)
    }
  }

  private fun startSilentForeground() {
    val notification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_SILENT)
        .setContentTitle(" ")
        .setContentText(" ")
        .setSmallIcon(android.R.drawable.ic_lock_lock)
        .setOngoing(true)
        .setShowWhen(false)
        .setCategory(Notification.CATEGORY_SERVICE)
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
      startForeground(WATCH_NOTIFICATION_ID, notification)
    } catch (e: Exception) {
      Log.w(TAG, "startForeground failed", e)
    }
  }

  private fun ensureSilentChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = getSystemService(NotificationManager::class.java) ?: return
    nm.createNotificationChannel(
      NotificationChannel(CHANNEL_SILENT, "Background", NotificationManager.IMPORTANCE_MIN).apply {
        setShowBadge(false)
        enableLights(false)
        enableVibration(false)
        setSound(null, null)
      }
    )
  }

  private fun checkOfflineTimeout(prefs: android.content.SharedPreferences) {
    val lastOnline = prefs.getLong(KEY_LAST_ONLINE, 0L)
    if (lastOnline == 0L) return
    val offlineMs = System.currentTimeMillis() - lastOnline
    val maxOfflineAllowedMs = 24 * 60 * 60 * 1000L // 24 Hours

    if (offlineMs > maxOfflineAllowedMs) {
      Log.w(TAG, "Offline sync timeout exceeded (24h) — enforcing self lock")
      prefs.edit().putBoolean(KEY_LOCKED, true).apply()
      mainHandler.post {
        LockOverlay.show(this)
        openAppDirectly(retries = 2)
      }
    }
  }

  companion object {
    private const val TAG = "LockWatchService"
    private const val PREFS = "device_kiosk_prefs"
    private const val KEY_LOCKED = "kiosk_locked"
    private const val KEY_LAST_ONLINE = "last_online_time"
    private const val KEY_QR = "watch_qr_ref"
    private const val KEY_URL = "watch_supabase_url"
    private const val KEY_KEY = "watch_supabase_key"
    private const val CHANNEL_SILENT = "device_lock_silent"
    private const val WATCH_NOTIFICATION_ID = 42010
    private const val POLL_INTERVAL_MS = 500L
    private const val ENFORCE_INTERVAL_MS = 500L
    const val ACTION_LOCK_STATE = "com.installment.customer.LOCK_STATE_CHANGED"
    const val EXTRA_LOCKED = "locked"

    fun start(context: Context) {
      val intent = Intent(context, LockWatchService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, LockWatchService::class.java))
    }
  }
}

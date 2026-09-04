package com.installment.customer

import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import android.util.Log

/**
 * Full-screen system overlay so lock appears ON TOP of WhatsApp/Chrome/etc.
 * without relying on startActivity (which OEMs often block) and without
 * showing a notification or "App is pinned" dialog.
 *
 * Requires Settings.canDrawOverlays (Display over other apps).
 */
object LockOverlay {
  private val mainHandler = Handler(Looper.getMainLooper())
  @Volatile private var attached = false
  private var rootView: View? = null

  fun canShow(context: Context): Boolean {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      Settings.canDrawOverlays(context)
    } else {
      true
    }
  }

  fun show(context: Context) {
    if (!canShow(context)) {
      Log.w("LockOverlay", "No overlay permission")
      return
    }
    val app = context.applicationContext
    mainHandler.post {
      try {
        if (attached && rootView != null) return@post
        val wm = app.getSystemService(Context.WINDOW_SERVICE) as WindowManager

        val layout = LinearLayout(app).apply {
          orientation = LinearLayout.VERTICAL
          setBackgroundColor(Color.parseColor("#111827"))
          gravity = Gravity.CENTER
          setPadding(48, 48, 48, 48)
          isClickable = true
          isFocusable = true
        }

        val title = TextView(app).apply {
          text = "LOCKED"
          setTextColor(Color.WHITE)
          setTextSize(TypedValue.COMPLEX_UNIT_SP, 28f)
          gravity = Gravity.CENTER
        }
        val body = TextView(app).apply {
          text = "This device is locked. Contact shop owner to unlock."
          setTextColor(Color.parseColor("#F9FAFB"))
          setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
          gravity = Gravity.CENTER
          setPadding(0, 24, 0, 0)
        }
        layout.addView(title)
        layout.addView(body)

        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
          @Suppress("DEPRECATION")
          WindowManager.LayoutParams.TYPE_PHONE
        }

        val params = WindowManager.LayoutParams(
          WindowManager.LayoutParams.MATCH_PARENT,
          WindowManager.LayoutParams.MATCH_PARENT,
          type,
          // Full-screen, touch-eating overlay (soft lock ≈ hard lock over other apps)
          WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
            WindowManager.LayoutParams.FLAG_FULLSCREEN or
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
          PixelFormat.TRANSLUCENT
        ).apply {
          gravity = Gravity.CENTER
          // Cover status/nav areas
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            layoutInDisplayCutoutMode =
              WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
          }
        }

        wm.addView(layout, params)
        rootView = layout
        attached = true
        Log.i("LockOverlay", "Overlay shown")
      } catch (e: Exception) {
        Log.w("LockOverlay", "Failed to show overlay", e)
        attached = false
        rootView = null
      }
    }
  }

  fun hide(context: Context) {
    val app = context.applicationContext
    mainHandler.post {
      try {
        val view = rootView ?: return@post
        val wm = app.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        wm.removeView(view)
      } catch (e: Exception) {
        Log.w("LockOverlay", "Failed to hide overlay", e)
      } finally {
        rootView = null
        attached = false
      }
    }
  }
}

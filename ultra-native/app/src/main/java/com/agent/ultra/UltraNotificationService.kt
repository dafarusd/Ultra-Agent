package com.agent.ultra

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import android.widget.Toast
import java.io.File

/**
 * Notification listener: keeps a rolling buffer of recent notifications in
 * app-private storage so the brain's notification_read tool can answer
 * "what did I miss" without leaving the device.
 *
 * Enabled via: settings put secure enabled_notification_listeners
 */
class UltraNotificationService : NotificationListenerService() {

    override fun onListenerConnected() {
        Log.i(TAG, "notification listener connected")
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        try {
            if (AgentAccessibilityService.isPackageBlocked(sbn.packageName)) {
                Log.i(TAG, "skipped protected app: ${sbn.packageName}")
                return
            }
            val extras = sbn.notification.extras
            val title = extras.getCharSequence("android.title")?.toString() ?: ""
            val text = extras.getCharSequence("android.text")?.toString() ?: ""

            trySmsCodeExtract(sbn, text)

            // Capture is standing collection, not a per-task read: without
            // this check every banking alert, message preview and two-factor
            // code lands in a log on disk.
            if (!com.agent.ultra.ui.UltraPrefs.captureNotifications(this)) return
            val line = buildString {
                append(sbn.postTime)
                append(" | ").append(sbn.packageName)
                if (title.isNotBlank()) append(" | ").append(title.take(60))
                if (text.isNotBlank()) append(" | ").append(text.take(120))
                append("\n")
            }
            val f = File(filesDir, "notifications.log")
            f.appendText(line)
            // Keep the log bounded — last ~200 lines
            if (f.length() > 64 * 1024) {
                val lines = f.readLines()
                f.writeText(lines.takeLast(200).joinToString("\n") + "\n")
            }
        } catch (e: Exception) {
            Log.w(TAG, "post capture failed", e)
        }
    }

    private fun trySmsCodeExtract(sbn: StatusBarNotification, text: String) {
        if (!com.agent.ultra.ui.UltraPrefs.autoExtractSmsCode(this)) return
        if (!isSmsNotification(sbn)) return
        val code = com.agent.ultra.agent.SmsCodeDetector.extract(text) ?: return
        try {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("verification code", code))
            Log.i(TAG, "SMS code auto-copied: ${code.length} digits")
            android.os.Handler(mainLooper).post {
                Toast.makeText(this, "Code $code copied", Toast.LENGTH_SHORT).show()
            }
        } catch (e: Exception) {
            Log.w(TAG, "clipboard write failed for SMS code", e)
        }
    }

    private fun isSmsNotification(sbn: StatusBarNotification): Boolean {
        val pkg = sbn.packageName
        return pkg == "com.google.android.apps.messaging" ||
            pkg == "com.samsung.android.messaging" ||
            pkg == "com.android.mms" ||
            pkg.contains("messaging") ||
            pkg.contains("sms")
    }

    companion object {
        private const val TAG = "UltraNotif"
    }
}

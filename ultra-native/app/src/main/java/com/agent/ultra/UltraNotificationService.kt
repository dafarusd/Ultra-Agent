package com.agent.ultra

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import android.widget.Toast
import com.agent.ultra.agent.EventTrigger
import java.io.File

/**
 * Notification listener: keeps a rolling buffer of recent notifications in
 * app-private storage so the brain's notification_read tool can answer
 * "what did I miss" without leaving the device.
 *
 * Also runs deterministic event triggers on each notification.
 *
 * Enabled via: settings put secure enabled_notification_listeners
 */
class UltraNotificationService : NotificationListenerService() {

    override fun onListenerConnected() {
        Log.i(TAG, "notification listener connected")
        EventTrigger.registerDefaults()
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

            val warned = runTriggers(sbn.packageName, title, text)

            // Capture is standing collection, not a per-task read: without
            // this check every banking alert, message preview and two-factor
            // code lands in a log on disk.
            if (!com.agent.ultra.ui.UltraPrefs.captureNotifications(this)) return
            val line = buildString {
                append(sbn.postTime)
                append(" | ").append(sbn.packageName)
                if (warned != null) append(" | [LOOKS LIKE A SCAM: ").append(warned).append("]")
                if (title.isNotBlank()) append(" | ").append(title.take(60))
                if (text.isNotBlank()) append(" | ").append(text.take(120))
                append("\n")
            }
            val f = File(filesDir, "notifications.log")
            f.appendText(line)
            if (f.length() > 64 * 1024) {
                val lines = f.readLines()
                f.writeText(lines.takeLast(200).joinToString("\n") + "\n")
            }
        } catch (e: Exception) {
            Log.w(TAG, "post capture failed", e)
        }
    }

    /** Runs the triggers; returns the scam reasons when the scam shield fired. */
    private fun runTriggers(pkg: String, title: String, text: String): String? {
        val actions = EventTrigger.evaluate(this, pkg, title, text)
        var warned: String? = null
        for (a in actions) {
            when (a.type) {
                EventTrigger.Action.Type.WARN -> {
                    warned = a.data
                    Log.i(TAG, "SCAM WARN from=${pkg}: ${a.data}")
                    android.os.Handler(mainLooper).post {
                        Toast.makeText(this, "Ultra: " + a.label, Toast.LENGTH_LONG).show()
                        // Said out loud too: the person most likely to fall for it may not read a toast.
                        if (com.agent.ultra.ui.UltraPrefs.speakAnswers(this)) {
                            speaker().speak("Careful. " + a.label + " Don't send money, codes or cards to it.")
                        }
                    }
                }
                EventTrigger.Action.Type.CLIPBOARD_COPY -> {
                    try {
                        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                        cm.setPrimaryClip(ClipData.newPlainText("ultra", a.data))
                        android.os.Handler(mainLooper).post {
                            Toast.makeText(this, a.label, Toast.LENGTH_SHORT).show()
                        }
                    } catch (e: Exception) {
                        Log.w(TAG, "clipboard action failed: ${e.message}")
                    }
                }
                EventTrigger.Action.Type.TOAST -> {
                    android.os.Handler(mainLooper).post {
                        Toast.makeText(this, a.label, Toast.LENGTH_SHORT).show()
                    }
                }
            }
        }
        return warned
    }

    private var speakerRef: com.agent.ultra.ui.Speaker? = null
    private fun speaker() = speakerRef ?: com.agent.ultra.ui.Speaker(this).also { speakerRef = it }

    override fun onDestroy() {
        try { speakerRef?.shutdown() } catch (_: Exception) {}
        super.onDestroy()
    }

    companion object {
        private const val TAG = "UltraNotif"
    }
}

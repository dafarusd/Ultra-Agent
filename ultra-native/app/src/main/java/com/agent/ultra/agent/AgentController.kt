package com.agent.ultra.agent

import com.agent.ultra.AgentAccessibilityService
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.provider.Settings
import android.telephony.SmsManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray

/**
 * In-process device control. Replaces the old RN bridge: Kotlin calls the
 * accessibility service and system APIs directly. All methods are safe to
 * call from any coroutine; blocking service gestures hop to Dispatchers.IO.
 */
class AgentController(private val context: Context) {

    private val service get() = AgentAccessibilityService.getInstance()

    val serviceRunning: Boolean get() = AgentAccessibilityService.isRunning()

    /**
     * The service can be momentarily unbound (bind races after process start,
     * Samsung background churn). Poll briefly before declaring it absent.
     */
    private suspend fun serviceOrWait(): AgentAccessibilityService? = withContext(Dispatchers.IO) {
        var svc = service
        var tries = 0
        while (svc == null && tries < 6) {
            tries++
            try { Thread.sleep(500) } catch (_: InterruptedException) {}
            svc = service
        }
        svc
    }

    // ── Perception ──────────────────────────────────────────────────────

    /**
     * Flat a11y node list. The service can briefly return empty/null while an
     * app is settling after a transition (proven on device: root=null bursts
     * after Chrome launched) — retry with backoff before reporting empty.
     */
    suspend fun screenFlat(): String = withContext(Dispatchers.IO) {
        val svc = serviceOrWait() ?: return@withContext "[]"
        var result = svc.getScreenContentFlat() ?: "[]"
        var tries = 0
        while ((result == "[]" || result.isBlank()) && tries < 4) {
            tries++
            try { Thread.sleep(700) } catch (_: InterruptedException) {}
            result = svc.getScreenContentFlat() ?: "[]"
        }
        result
    }

    /** Foreground app from live windows (falls back to the event tracker). */
    fun activePackage(): String = service?.getForegroundPackage() ?: service?.getActivePackage() ?: ""

    suspend fun waitForUiChange(timeoutMs: Int): Boolean = withContext(Dispatchers.IO) {
        service?.waitForUiChange(timeoutMs) ?: false
    }

    // ── Actions (accessibility) ─────────────────────────────────────────

    suspend fun tap(x: Int, y: Int): Boolean = withContext(Dispatchers.IO) {
        service?.performTap(x, y) ?: false
    }

    suspend fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Int): Boolean =
        withContext(Dispatchers.IO) { service?.performSwipe(x1, y1, x2, y2, durationMs) ?: false }

    suspend fun clickNode(selector: String): Boolean = withContext(Dispatchers.IO) {
        service?.performClick(selector) ?: false
    }

    suspend fun typeInto(selector: String, text: String): Boolean = withContext(Dispatchers.IO) {
        service?.performText(selector, text) ?: false
    }

    suspend fun scroll(direction: String): Boolean = withContext(Dispatchers.IO) {
        service?.performScroll(direction) ?: false
    }

    /** The full structural tree, containers included — for grouping labels
     * into the items they belong to. Separate from screenFlat(), whose
     * indices the navigator taps by. */
    suspend fun screenTree(): String = withContext(Dispatchers.IO) {
        serviceOrWait()?.getScreenTree() ?: "[]"
    }

    /** Scroll the largest scrollable container in the target app's window —
     * for reading a whole page rather than nudging whatever is nearest. */
    suspend fun scrollDeep(direction: String): Boolean = withContext(Dispatchers.IO) {
        serviceOrWait()?.performScrollDeep(direction) ?: false
    }

    suspend fun imeEnter(): Boolean = withContext(Dispatchers.IO) {
        service?.performImeAction() ?: false
    }

    suspend fun back(): Boolean = withContext(Dispatchers.IO) { service?.performBack() ?: false }
    suspend fun home(): Boolean = withContext(Dispatchers.IO) { service?.performHome() ?: false }

    // ── Apps ────────────────────────────────────────────────────────────

    fun launchApp(packageName: String): Boolean {
        val intent = context.packageManager.getLaunchIntentForPackage(packageName) ?: return false
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        return true
    }

    fun findPackage(query: String): String? {
        val q = query.lowercase()
        val pm = context.packageManager
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val apps = pm.queryIntentActivities(intent, 0)
        // Exact package match first, then label contains
        apps.firstOrNull { it.activityInfo.packageName.lowercase() == q }?.let {
            return it.activityInfo.packageName
        }
        return apps.firstOrNull {
            it.loadLabel(pm).toString().lowercase().contains(q)
        }?.activityInfo?.packageName
    }

    fun listLaunchableApps(): List<Pair<String, String>> {
        val pm = context.packageManager
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        return pm.queryIntentActivities(intent, 0).map {
            it.loadLabel(pm).toString() to it.activityInfo.packageName
        }.sortedBy { it.first }
    }

    fun openUrl(url: String): Boolean = try {
        val u = if (url.startsWith("http")) url else "https://$url"
        context.startActivity(
            Intent(Intent.ACTION_VIEW, Uri.parse(u)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
        true
    } catch (_: Exception) { false }

    // ── Radios & settings (WRITE_SECURE_SETTINGS granted via adb) ──────

    /** Direct settings write — the fix for the old QS-tile tap failures. */
    fun setSecureSetting(key: String, value: String): Boolean = try {
        Settings.Secure.putString(context.contentResolver, key, value)
    } catch (_: Exception) { false }

    fun setGlobalSetting(key: String, value: String): Boolean = try {
        Settings.Global.putString(context.contentResolver, key, value)
    } catch (_: Exception) { false }

    fun setBluetooth(on: Boolean): Boolean = try {
        val adapter = android.bluetooth.BluetoothAdapter.getDefaultAdapter() ?: return false
        @Suppress("DEPRECATION")
        if (on) adapter.enable() else adapter.disable()
        true
    } catch (_: Exception) { false }

    fun setWifi(on: Boolean): Boolean = try {
        // WifiManager.setWifiEnabled is deprecated but functional via shell-granted perms;
        // panel intent is the user-facing fallback.
        val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        @Suppress("DEPRECATION")
        wm.isWifiEnabled = on
        true
    } catch (_: Exception) {
        try {
            context.startActivity(Intent(Settings.Panel.ACTION_WIFI).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            true
        } catch (_: Exception) { false }
    }

    fun setDoNotDisturb(on: Boolean): Boolean {
        // Path 1: notification policy access (user-granted in settings)
        try {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
            if (nm.isNotificationPolicyAccessGranted) {
                nm.setInterruptionFilter(
                    if (on) android.app.NotificationManager.INTERRUPTION_FILTER_PRIORITY
                    else android.app.NotificationManager.INTERRUPTION_FILTER_ALL
                )
                return true
            }
        } catch (_: Exception) {}
        // Path 2: zen_mode global setting (works with WRITE_SECURE_SETTINGS)
        return try {
            Settings.Global.putInt(context.contentResolver, "zen_mode", if (on) 1 else 0)
        } catch (_: Exception) { false }
    }

    fun setFlashlight(on: Boolean): Boolean = try {
        val cm = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val id = cm.cameraIdList.firstOrNull { id ->
            cm.getCameraCharacteristics(id)
                .get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
        } ?: return false
        cm.setTorchMode(id, on)
        true
    } catch (_: Exception) { false }

    fun setVolume(stream: Int, percent: Int): Boolean = try {
        val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val max = am.getStreamMaxVolume(stream)
        am.setStreamVolume(stream, (max * percent / 100), 0)
        true
    } catch (_: Exception) { false }

    // ── Communication ───────────────────────────────────────────────────

    fun sendSms(to: String, message: String): Boolean = try {
        @Suppress("DEPRECATION")
        SmsManager.getDefault().sendTextMessage(to, null, message, null, null)
        true
    } catch (_: Exception) { false }

    fun readSms(limit: Int): String = try {
        val cursor = context.contentResolver.query(
            Uri.parse("content://sms/inbox"),
            arrayOf("address", "body", "date"), null, null, "date DESC"
        ) ?: return "Error: could not query SMS inbox"
        val out = mutableListOf<String>()
        cursor.use {
            while (it.moveToNext() && out.size < limit) {
                val addr = it.getString(0) ?: "unknown"
                val body = (it.getString(1) ?: "").take(160)
                out += "From $addr: $body"
            }
        }
        if (out.isEmpty()) "No SMS messages found" else out.joinToString("\n")
    } catch (e: SecurityException) {
        "Error: SMS permission not granted"
    } catch (e: Exception) {
        "Error: ${e.message}"
    }

    fun readContacts(nameQuery: String): String = try {
        val selection: String?
        val args: Array<String>?
        if (nameQuery.isBlank()) {
            selection = null; args = null
        } else {
            selection = android.provider.ContactsContract.Contacts.DISPLAY_NAME + " LIKE ?"
            args = arrayOf("%$nameQuery%")
        }
        val cursor = context.contentResolver.query(
            android.provider.ContactsContract.Contacts.CONTENT_URI,
            arrayOf(android.provider.ContactsContract.Contacts._ID,
                android.provider.ContactsContract.Contacts.DISPLAY_NAME,
                android.provider.ContactsContract.Contacts.HAS_PHONE_NUMBER),
            selection, args,
            android.provider.ContactsContract.Contacts.DISPLAY_NAME + " ASC"
        ) ?: return "Error: could not query contacts"
        val out = mutableListOf<String>()
        cursor.use {
            while (it.moveToNext() && out.size < 10) {
                val id = it.getString(0)
                val name = it.getString(1) ?: continue
                val hasPhone = it.getInt(2) > 0
                var phone = ""
                if (hasPhone) {
                    val pc = context.contentResolver.query(
                        android.provider.ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                        arrayOf(android.provider.ContactsContract.CommonDataKinds.Phone.NUMBER),
                        android.provider.ContactsContract.CommonDataKinds.Phone.CONTACT_ID + " = ?",
                        arrayOf(id), null)
                    pc?.use { p -> if (p.moveToFirst()) phone = p.getString(0) ?: "" }
                }
                out += if (phone.isNotBlank()) "$name — $phone" else name
            }
        }
        if (out.isEmpty()) "No contacts matching '$nameQuery'" else out.joinToString("\n")
    } catch (e: SecurityException) {
        "Error: contacts permission not granted"
    } catch (e: Exception) {
        "Error: ${e.message}"
    }

    // ── Location / clipboard / media / alarms / notes ───────────────────

    fun lastKnownLocation(): String = try {
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as android.location.LocationManager
        val providers = listOf(android.location.LocationManager.GPS_PROVIDER,
            android.location.LocationManager.NETWORK_PROVIDER,
            android.location.LocationManager.PASSIVE_PROVIDER)
        var best: android.location.Location? = null
        for (p in providers) {
            try {
                val l = lm.getLastKnownLocation(p)
                if (l != null && (best == null || l.time > best!!.time)) best = l
            } catch (_: SecurityException) {}
        }
        if (best == null) "Error: no known location yet"
        else "Location: %.5f, %.5f (±%.0fm)".format(best.latitude, best.longitude, best.accuracy)
    } catch (e: Exception) {
        "Error: ${e.message}"
    }

    fun clipboardWrite(text: String): Boolean = try {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        cm.setPrimaryClip(android.content.ClipData.newPlainText("ultra", text))
        true
    } catch (_: Exception) { false }

    fun clipboardRead(): String = try {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        val clip = cm.primaryClip
        if (clip == null || clip.itemCount == 0) "Clipboard is empty"
        else clip.getItemAt(0).coerceToText(context)?.toString() ?: "Clipboard is empty"
    } catch (_: Exception) { "Error: clipboard read failed" }

    fun mediaKey(keyCode: Int): Boolean = try {
        val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val down = android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, keyCode)
        val up = android.view.KeyEvent(android.view.KeyEvent.ACTION_UP, keyCode)
        am.dispatchMediaKeyEvent(down)
        am.dispatchMediaKeyEvent(up)
        true
    } catch (_: Exception) { false }

    fun setAlarm(hour: Int, minute: Int, label: String): Boolean = try {
        val i = Intent(android.provider.AlarmClock.ACTION_SET_ALARM)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(android.provider.AlarmClock.EXTRA_HOUR, hour)
            .putExtra(android.provider.AlarmClock.EXTRA_MINUTES, minute)
            .putExtra(android.provider.AlarmClock.EXTRA_MESSAGE, label)
            .putExtra(android.provider.AlarmClock.EXTRA_SKIP_UI, true)
        context.startActivity(i)
        true
    } catch (e: Exception) {
        android.util.Log.w("AgentUltra", "setAlarm failed", e)
        false
    }

    fun createNote(text: String): String = try {
        val dir = java.io.File(context.filesDir, "notes").apply { mkdirs() }
        val f = java.io.File(dir, "note-${System.currentTimeMillis()}.txt")
        f.writeText(text)
        "Note saved: ${f.name}"
    } catch (e: Exception) {
        "Error: ${e.message}"
    }

    suspend fun takeScreenshot(): Boolean = withContext(Dispatchers.IO) {
        serviceOrWait()?.takeScreenshot() ?: false
    }

    /** Recent notifications captured by the listener service. */
    fun readNotifications(limit: Int): String = try {
        val f = java.io.File(context.filesDir, "notifications.log")
        if (!f.exists()) "No notifications captured yet (or the listener isn't enabled)"
        else {
            val lines = f.readLines().filter { it.isNotBlank() }
            if (lines.isEmpty()) "No notifications captured yet"
            else lines.takeLast(limit).joinToString("\n") {
                it.substringAfter(" | ") // drop the epoch prefix
            }
        }
    } catch (e: Exception) {
        "Error: ${e.message}"
    }

    // ── Device info ─────────────────────────────────────────────────────

    fun batteryStatus(): String {
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        val charging = bm.isCharging
        return "Battery: $level%${if (charging) " (charging)" else ""}"
    }

    fun deviceInfo(): String = buildString {
        append("${Build.MANUFACTURER} ${Build.MODEL}, Android ${Build.VERSION.RELEASE}")
        append(" | apps: ").append(listLaunchableApps().size)
    }

    fun currentWifiSsid(): String? = try {
        val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        @Suppress("DEPRECATION")
        wm.connectionInfo?.ssid?.removeSurrounding("\"")
    } catch (_: Exception) { null }
}

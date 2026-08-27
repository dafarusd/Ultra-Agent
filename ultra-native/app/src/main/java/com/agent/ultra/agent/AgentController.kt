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

    // ── Perception ──────────────────────────────────────────────────────

    suspend fun screenFlat(): String = withContext(Dispatchers.IO) {
        val svc = service ?: return@withContext "[]"
        svc.getScreenContentFlat() ?: "[]"
    }

    fun activePackage(): String = service?.getActivePackage() ?: ""

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

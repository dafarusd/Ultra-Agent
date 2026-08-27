package com.agent.ultra.agent

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/**
 * The tool dispatcher. Each tool returns a plain-text result string;
 * failures start with "Error:" (the brain's success heuristic keys on that).
 * Ported set from the proven Build 29 catalog — not all 79 legacy cases.
 */
class Tools(
    private val context: Context,
    private val controller: AgentController,
) {
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    var navigator: ReActNavigator? = null

    suspend fun execute(tool: String, params: JSONObject): String {
        return try {
            when (tool) {
                // ── Perception ───────────────────────────────────────
                "read_text_on_screen" -> {
                    val flat = controller.screenFlat()
                    if (flat == "[]" || flat.isBlank()) "Error: screen empty or accessibility service not running"
                    else summarizeFlat(flat)
                }
                "describe_screen" -> {
                    val flat = controller.screenFlat()
                    if (flat == "[]" || flat.isBlank()) "Error: screen empty or accessibility service not running"
                    else "Current app: ${controller.activePackage()}\n" + summarizeFlat(flat)
                }
                "screenshot" -> "Error: screenshot lands in a later milestone — use read_text_on_screen"

                // ── Apps & navigation ────────────────────────────────
                "app_launch" -> {
                    val target = params.optString("target")
                    val pkg = controller.findPackage(target)
                    if (pkg != null && controller.launchApp(pkg)) "Launched $target ($pkg)"
                    else "Error: no launchable app matching '$target'"
                }
                "open_url" -> {
                    val url = params.optString("url")
                    if (url.isBlank()) "Error: missing url"
                    else if (controller.openUrl(url)) "Opened $url"
                    else "Error: could not open $url"
                }
                "react_navigate" -> {
                    val goal = params.optString("goal")
                    val hint = params.optString("appHint")
                    val nav = navigator ?: return "Error: navigator not wired"
                    nav.run(goal, hint)
                }

                // ── Information ──────────────────────────────────────
                "web_search" -> webSearch(params.optString("query"))
                "device_info" -> controller.deviceInfo()
                "battery_status" -> controller.batteryStatus()
                "system_info" -> controller.deviceInfo() + " | " + controller.batteryStatus()

                // ── Device control ───────────────────────────────────
                "flashlight_toggle" -> {
                    val on = params.optBoolean("on", true)
                    if (controller.setFlashlight(on)) "Flashlight ${if (on) "on" else "off"}"
                    else "Error: flashlight toggle failed"
                }
                "wifi_toggle" -> {
                    val on = params.optBoolean("on", true)
                    if (controller.setWifi(on)) "Wi-Fi ${if (on) "on" else "off"}"
                    else "Error: wifi toggle failed"
                }
                "bluetooth_toggle" -> {
                    val on = params.optBoolean("on", true)
                    if (controller.setBluetooth(on)) "Bluetooth ${if (on) "on" else "off"}"
                    else "Error: bluetooth toggle failed"
                }
                "do_not_disturb" -> {
                    val on = params.optBoolean("on", true)
                    if (controller.setDoNotDisturb(on)) "Do Not Disturb ${if (on) "on" else "off"}"
                    else "Error: DND toggle failed (needs notification policy access)"
                }
                "volume_set" -> {
                    val pct = params.optInt("percent", 50)
                    if (controller.setVolume(android.media.AudioManager.STREAM_MUSIC, pct)) "Media volume set to $pct%"
                    else "Error: volume set failed"
                }

                // ── Communication ────────────────────────────────────
                "sms_send" -> {
                    val to = params.optString("to")
                    val msg = params.optString("message")
                    when {
                        to.isBlank() -> "Error: sms_send needs a 'to' phone number — ask the user or use contacts_read first"
                        msg.isBlank() -> "Error: sms_send needs a 'message'"
                        controller.sendSms(to, msg) -> "SMS sent to $to"
                        else -> "Error: SMS send failed"
                    }
                }

                else -> "Error: unknown tool '$tool'"
            }
        } catch (e: Exception) {
            "Error: ${e.message}"
        }
    }

    /** Flatten the a11y node list into the readable text the brain consumes. */
    private fun summarizeFlat(flat: String): String {
        return try {
            val arr = org.json.JSONArray(flat)
            val lines = mutableListOf<String>()
            for (i in 0 until arr.length()) {
                val n = arr.getJSONObject(i)
                val label = n.optString("t").ifBlank { n.optString("d") }.trim()
                if (label.isNotBlank()) lines.add(label.take(80))
                if (lines.size >= 40) break
            }
            if (lines.isEmpty()) "Screen has no readable text"
            else lines.joinToString("\n")
        } catch (e: Exception) {
            "Error: could not parse screen: ${e.message}"
        }
    }

    /** DuckDuckGo HTML scrape — ported from the proven TaskExecutor implementation. */
    private suspend fun webSearch(query: String): String = withContext(Dispatchers.IO) {
        if (query.isBlank()) return@withContext "Error: missing query"
        try {
            val url = "https://html.duckduckgo.com/html/?q=" + URLEncoder.encode(query, "UTF-8")
            val req = Request.Builder()
                .url(url)
                .header("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36")
                .build()
            http.newCall(req).execute().use { resp ->
                val html = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) return@withContext "Error: search HTTP ${resp.code}"
                val results = extractResults(html)
                if (results.isNotEmpty())
                    "Search results for \"$query\":\n" + results.joinToString("\n")
                else {
                    val textOnly = html
                        .replace(Regex("<script[\\s\\S]*?</script>"), "")
                        .replace(Regex("<style[\\s\\S]*?</style>"), "")
                        .replace(Regex("<[^>]*>"), " ")
                        .replace(Regex("\\s+"), " ")
                        .trim().take(800)
                    if (textOnly.length > 50) "Search results for \"$query\" (raw):\n$textOnly"
                    else "Error: no results extracted"
                }
            }
        } catch (e: Exception) {
            "Error: search failed: ${e.message}"
        }
    }

    private fun extractResults(html: String): List<String> {
        val results = mutableListOf<String>()
        val p1 = Regex("<a class=\"result__a\"[^>]*>([\\s\\S]*?)</a>[\\s\\S]*?<a class=\"result__snippet\"[^>]*>([\\s\\S]*?)</a>")
        for (m in p1.findAll(html)) {
            if (results.size >= 6) break
            val t = m.groupValues[1].replace(Regex("<[^>]*>"), "").trim()
            val s = m.groupValues[2].replace(Regex("<[^>]*>"), "").trim()
            if (t.isNotEmpty() && s.isNotEmpty()) results.add("• $t: $s")
        }
        if (results.isEmpty()) {
            val p2 = Regex("<a class=\"result__a\"[^>]*>([\\s\\S]*?)</a>")
            for (m in p2.findAll(html)) {
                if (results.size >= 6) break
                val t = m.groupValues[1].replace(Regex("<[^>]*>"), "").trim()
                if (t.isNotEmpty()) results.add("• $t")
            }
        }
        return results
    }

    companion object {
        /** Tools that mutate the outside world — confirmation gate targets. */
        val DESTRUCTIVE = setOf("sms_send", "file_delete")
    }
}

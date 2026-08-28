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
                "screenshot" -> {
                    if (controller.takeScreenshot()) "Screenshot taken — saved to the device gallery"
                    else "Error: screenshot failed (accessibility service not running)"
                }
                "notification_read" -> controller.readNotifications(params.optInt("limit", 15))

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
                "sms_read" -> controller.readSms(params.optInt("limit", 10))
                "contacts_read" -> controller.readContacts(params.optString("name"))

                // ── Location / clipboard / media / alarms / notes ────
                "device_location" -> controller.lastKnownLocation()
                "clipboard_write" -> {
                    val text = params.optString("text")
                    if (text.isBlank()) "Error: missing text"
                    else if (controller.clipboardWrite(text)) "Copied to clipboard"
                    else "Error: clipboard write failed"
                }
                "clipboard_read" -> controller.clipboardRead()
                "media_play" -> if (controller.mediaKey(android.view.KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE)) "Play/pause toggled" else "Error: media key failed"
                "media_next" -> if (controller.mediaKey(android.view.KeyEvent.KEYCODE_MEDIA_NEXT)) "Skipped to next track" else "Error: media key failed"
                "alarm_set" -> {
                    val hour = params.optInt("hour", -1)
                    val minute = params.optInt("minute", 0)
                    if (hour !in 0..23) "Error: alarm_set needs hour (0-23) and optional minute"
                    else if (controller.setAlarm(hour, minute, params.optString("label", "Ultra alarm"))) "Alarm set for %02d:%02d".format(hour, minute)
                    else "Error: alarm failed"
                }
                "note_create" -> {
                    val text = params.optString("text")
                    if (text.isBlank()) "Error: missing text"
                    else controller.createNote(text)
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

    /** Web search: DDG instant-answer JSON first, Wikipedia second, HTML
     * scrape last (the scrape returned page boilerplate in this network
     * environment — proven in the M5 suite). */
    private suspend fun webSearch(query: String): String = withContext(Dispatchers.IO) {
        if (query.isBlank()) return@withContext "Error: missing query"
        instantAnswer(query)?.let { return@withContext it }
        wikipedia(query)?.let { return@withContext it }
        scrapeDdg(query)
    }

    private fun instantAnswer(query: String): String? {
        return try {
        val url = "https://api.duckduckgo.com/?q=" + URLEncoder.encode(query, "UTF-8") +
            "&format=json&no_html=1&skip_disambig=1"
        val req = Request.Builder().url(url)
            .header("User-Agent", "AgentUltra/2.0").build()
        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) return null
            val j = JSONObject(resp.body?.string() ?: return null)
            val out = mutableListOf<String>()
            j.optString("Answer").takeIf { it.isNotBlank() }?.let { out += "Answer: $it" }
            j.optString("AbstractText").takeIf { it.isNotBlank() }?.let { abs ->
                out += abs
                j.optString("AbstractURL").takeIf { u -> u.isNotBlank() }?.let { out += "Source: $it" }
            }
            val topics = j.optJSONArray("RelatedTopics")
            if (topics != null) {
                var n = 0
                for (i in 0 until topics.length()) {
                    val t = topics.optJSONObject(i) ?: continue
                    val text = t.optString("Text")
                    if (text.isNotBlank()) { out += "• $text"; if (++n >= 4) break }
                }
            }
            if (out.isEmpty()) null
            else "Search results for \"$query\":\n" + out.joinToString("\n")
        }
        } catch (_: Exception) { null }
    }

    private fun wikipedia(query: String): String? {
        return try {
        val searchUrl = "https://en.wikipedia.org/w/api.php?action=opensearch&limit=3&format=json&search=" +
            URLEncoder.encode(query, "UTF-8")
        val req = Request.Builder().url(searchUrl)
            .header("User-Agent", "AgentUltra/2.0").build()
        val title = http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) return null
            val arr = org.json.JSONArray(resp.body?.string() ?: return null)
            arr.optJSONArray(1)?.optString(0)
        }
        if (title.isNullOrBlank()) return null
        val sumUrl = "https://en.wikipedia.org/api/rest_v1/page/summary/" +
            URLEncoder.encode(title, "UTF-8")
        val req2 = Request.Builder().url(sumUrl)
            .header("User-Agent", "AgentUltra/2.0").build()
        http.newCall(req2).execute().use { resp2 ->
            if (!resp2.isSuccessful) return null
            val j = JSONObject(resp2.body?.string() ?: return null)
            val extract = j.optString("extract")
            if (extract.isBlank()) null
            else "Search results for \"$query\":\n$extract\nSource: en.wikipedia.org/wiki/${title.replace(" ", "_")}"
        }
        } catch (_: Exception) { null }
    }

    /** DuckDuckGo HTML scrape — last resort, ported from the proven implementation. */
    private suspend fun scrapeDdg(query: String): String = withContext(Dispatchers.IO) {
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

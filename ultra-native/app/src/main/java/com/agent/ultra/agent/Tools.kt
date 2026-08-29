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

    /** What the agent has learned about screens it has read before. Set by
     * Brain, which owns the database. */
    var screenMemory: com.agent.ultra.data.ScreenMemoryDao? = null

    /** Recipe store and the replay entry point. The runner lives in Brain —
     * replay needs the policy gate and the episode, which Tools does not own. */
    var recipes: Recipes? = null
    var recipeRunner: (suspend (String) -> String)? = null

    suspend fun execute(tool: String, params: JSONObject): String {
        // Messages, contacts and location reach Android's own providers, so
        // the app-access list does not cover them — that list gates what the
        // accessibility service sees on screen, and reading the SMS database
        // never goes near a screen. On a phone taking real calls and texts,
        // the default has to be no.
        if (tool in PERSONAL_TOOLS && !com.agent.ultra.ui.UltraPrefs.allowPersonalData(context)) {
            return "Error: messages, contacts and location are switched off for this agent. " +
                "The user can turn them on in Settings under PERSONAL DATA. " +
                "Do not retry — tell them, and carry on with the rest of the task."
        }
        return try {
            when (tool) {
                // ── Perception ───────────────────────────────────────
                "read_text_on_screen" -> {
                    val flat = controller.screenFlat()
                    when {
                        flat == PROTECTED -> PROTECTED_MSG
                        flat == "[]" || flat.isBlank() ->
                            "Error: nothing could be read — " + controller.serviceProblem.ifBlank { "the screen was empty" }
                        else -> summarizeFlat(flat)
                    }
                }
                "read_screen_deep" -> {
                    // Measured on an Amazon results page: still gaining new
                    // content at scroll 10, so the default is not timid.
                    val maxScrolls = params.optInt("maxScrolls", 12).coerceIn(1, 30)
                    deepRead(maxScrolls)
                }
                "describe_screen" -> {
                    val flat = controller.screenFlat()
                    when {
                        flat == PROTECTED -> PROTECTED_MSG
                        flat == "[]" || flat.isBlank() ->
                            "Error: nothing could be read — " + controller.serviceProblem.ifBlank { "the screen was empty" }
                        else -> "Current app: ${controller.activePackage()}\n" + summarizeFlat(flat)
                    }
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
                    when {
                        pkg == null -> "Error: no launchable app matching '$target'"
                        !com.agent.ultra.AgentAccessibilityService.agentMayUse(pkg) ->
                            "Error: '$target' is not on the user's allowed-apps list, so it " +
                                "cannot be opened or read. Do not retry. Tell the user which " +
                                "app it was; they can change the list in Settings."
                        controller.launchApp(pkg) -> "Launched $target ($pkg)"
                        else -> "Error: could not launch '$target'"
                    }
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

                // ── Recipes — named, replayable routines ─────────────
                "recipe_save" -> {
                    val r = recipes ?: return "Error: recipes unavailable"
                    val name = params.optString("name")
                    if (name.isBlank()) "Error: missing name"
                    else r.save(name, Brain.lastRunSteps)
                }
                "recipe_run" -> {
                    val run = recipeRunner ?: return "Error: recipes unavailable"
                    val name = params.optString("name")
                    if (name.isBlank()) "Error: missing name" else run(name)
                }
                "recipe_list" -> recipes?.list() ?: "Error: recipes unavailable"
                "recipe_delete" -> {
                    val r = recipes ?: return "Error: recipes unavailable"
                    val name = params.optString("name")
                    if (name.isBlank()) "Error: missing name" else r.delete(name)
                }

                else -> "Error: unknown tool '$tool'"
            }
        } catch (e: Exception) {
            "Error: ${e.message}"
        }
    }

    /**
     * Flatten the a11y node list into the readable text the brain consumes.
     *
     * There used to be a hard 40-label cap here. On any dense page — a search
     * result list, a feed, an article — 40 labels is the header and the
     * sign-in prompt, and the agent would confidently report that the content
     * "is not available". The limit is now a character budget, so a sparse
     * screen costs nothing and a rich one is actually readable.
     */
    private fun summarizeFlat(flat: String, budget: Int = VIEWPORT_BUDGET): String {
        return try {
            val labels = labelsOf(flat)
            if (labels.isEmpty()) return "Screen has no readable text"
            val out = StringBuilder()
            var used = 0
            var shown = 0
            for (l in labels) {
                if (used + l.length + 1 > budget) break
                out.append(l).append('\n')
                used += l.length + 1
                shown++
            }
            if (shown < labels.size) {
                out.append("… ${labels.size - shown} more items on this screen; ")
                    .append("use read_screen_deep to read the whole page.")
            }
            out.toString().trimEnd()
        } catch (e: Exception) {
            "Error: could not parse screen: ${e.message}"
        }
    }

    /** Distinct, ordered, non-empty labels from a flat node dump. */
    private fun labelsOf(flat: String): List<String> = try {
        val arr = org.json.JSONArray(flat)
        val seen = LinkedHashSet<String>()
        for (i in 0 until arr.length()) {
            val n = arr.optJSONObject(i) ?: continue
            val label = n.optString("t").ifBlank { n.optString("d") }.trim()
            if (label.isNotBlank()) seen.add(label.take(LABEL_CHARS))
        }
        seen.toList()
    } catch (_: Exception) { emptyList() }

    /** The template this screen used last time, or "" if it is new to us. */
    private suspend fun rememberedTemplate(fp: ScreenSignature.Fingerprint?): String {
        val dao = screenMemory ?: return ""
        if (fp == null || !fp.known) return ""
        return try { dao.get(fp.key)?.template ?: "" } catch (_: Exception) { "" }
    }

    /**
     * Record what this screen turned out to be.
     *
     * Structure only — the template signature and the field names, never a
     * value. A memory row says "this screen's records look like this and carry
     * a price and a rating"; it never says what the price was.
     *
     * Never fails a read. A screen that cannot be remembered is simply read
     * from scratch next time, which is exactly what happened before any of
     * this existed.
     */
    private suspend fun learnScreen(
        fp: ScreenSignature.Fingerprint?,
        pkg: String,
        rows: List<ScreenStructure.Item>,
    ) {
        val dao = screenMemory ?: return
        if (fp == null || !fp.known || rows.size < 3) return
        val template = ScreenStructure.lastTemplate
        if (template.isBlank()) return
        val controls = ScreenControls.of(ScreenStructure.parse(controller.screenTree()))
        try {
            val fields = rows.asSequence()
                .flatMap { ScreenStructure.fields(it).asSequence() }
                .mapNotNull { it.name }
                .filter { it != "title" }
                .distinct().sorted().take(20).joinToString(",")
            val prior = dao.get(fp.key)
            dao.put(
                com.agent.ultra.data.ScreenMemoryEntity(
                    screenKey = fp.key,
                    pkg = pkg,
                    template = template,
                    recordCount = rows.size,
                    fieldsCsv = fields,
                    seenCount = (prior?.seenCount ?: 0) + 1,
                    lastSeen = System.currentTimeMillis(),
                    confidence = fp.confidence.name,
                    // Keep what is already known if this read found nothing —
                    // a control list is not wrong just because the screen was
                    // scrolled away from it.
                    controlsJson = if (controls.isNotEmpty()) ScreenControls.toJson(controls)
                        else prior?.controlsJson.orEmpty(),
                )
            )
            dao.trimTo(SCREEN_MEMORY_LIMIT)
            android.util.Log.i(
                "UltraPerceive",
                "learned screen ${fp.key} (${fp.confidence}) ${rows.size} records, fields=[$fields], ${controls.size} controls",
            )
        } catch (e: Exception) {
            android.util.Log.w("UltraPerceive", "could not record screen: ${e.message}")
        }
    }

    /**
     * Put the page back where the read found it.
     *
     * Reading is not supposed to move anything. Without this, a deep read
     * leaves the screen wherever it stopped, so the next tool call sees a
     * different page than the one the model was told about — it taps the
     * third row and hits whatever scrolled into that spot.
     *
     * Scrolls back the same number of times rather than jumping to the top,
     * because the page was not necessarily at the top when the read began.
     * Best-effort: a failed restore is logged and never fails a read that
     * already succeeded.
     */
    private suspend fun restoreScroll(scrolls: Int) {
        if (scrolls <= 0) return
        var undone = 0
        try {
            while (undone < scrolls) {
                // Two ways up. Measured on a store page: after reading to the
                // bottom, the node that scrolled forward refused
                // ACTION_SCROLL_BACKWARD and the page stayed where it was —
                // "restored 0/7". The plain gesture works there, so a refusal
                // from one is not the end of the attempt.
                val moved = controller.scrollDeep("up") || controller.scroll("up")
                if (!moved) break
                undone++
                kotlinx.coroutines.delay(RESTORE_SETTLE_MS)
            }
        } catch (e: Exception) {
            android.util.Log.w("UltraPerceive", "deep read: scroll restore failed: ${e.message}")
        }
        if (undone < scrolls) {
            android.util.Log.w(
                "UltraPerceive",
                "deep read: restored only $undone/$scrolls scrolls — page left part-way down",
            )
        } else {
            android.util.Log.i("UltraPerceive", "deep read: restored $undone/$scrolls scrolls")
        }
    }

    /**
     * Read a whole scrollable page, not just the viewport.
     *
     * Scrolls the largest container forward, re-reads, and accumulates labels
     * in order, stopping as soon as a scroll produces nothing new. Order is
     * preserved and duplicates dropped, so overlapping reads across scrolls
     * come out as one clean document.
     */
    private suspend fun deepRead(maxScrolls: Int): String {
        val seen = LinkedHashSet<String>()                       // flat fallback
        val items = LinkedHashMap<String, ScreenStructure.Item>() // structured rows
        val first = controller.screenFlat()
        if (first == PROTECTED) return PROTECTED_MSG
        if (first == "[]" || first.isBlank()) {
            return "Error: nothing could be read — " + controller.serviceProblem.ifBlank { "the screen was empty" }
        }
        // What this screen looked like last time, if it has been read before.
        // Looked up once for the whole read rather than per scroll: scrolling
        // does not change which screen you are on.
        val pkg = controller.activePackage()
        var recalled = ""
        var fingerprint: ScreenSignature.Fingerprint? = null

        suspend fun absorb(flat: String): Int {
            val before = seen.size + items.size
            seen += labelsOf(flat)
            val nodes = ScreenStructure.parse(controller.screenTree())
            if (fingerprint == null && nodes.isNotEmpty()) {
                fingerprint = ScreenSignature.of(pkg, nodes)
                recalled = rememberedTemplate(fingerprint)
            }
            for (it in ScreenStructure.items(nodes, knownTemplate = recalled)) {
                items.putIfAbsent(it.signature, it)
            }
            return seen.size + items.size - before
        }
        absorb(first)

        var scrolls = 0
        var stoppedBecause = "reached the end of the page"
        while (scrolls < maxScrolls) {
            if (!controller.scrollDeep("down")) {
                stoppedBecause = if (scrolls == 0) "this screen does not scroll" else "reached the end of the page"
                break
            }
            scrolls++
            kotlinx.coroutines.delay(SCROLL_SETTLE_MS)
            val gained = absorb(controller.screenFlat())
            android.util.Log.i("UltraPerceive", "deep scroll $scrolls: +$gained new (labels ${seen.size}, items ${items.size})")
            if (gained == 0) break
            if (seen.size >= MAX_DEEP_LABELS) { stoppedBecause = "hit the ${MAX_DEEP_LABELS}-item limit"; break }
        }
        if (scrolls >= maxScrolls) stoppedBecause = "hit the $maxScrolls-scroll limit"

        restoreScroll(scrolls)
        learnScreen(fingerprint, pkg, items.values.toList())

        // Structured when the screen genuinely has a repeating list; flat when
        // it does not. Inventing groups where there are none is how a wrong
        // pairing gets stated confidently.
        if (items.size >= 3) {
            val rows = items.values.sortedBy { it.top }
            val (body, shown) = ScreenStructure.render(rows, DEEP_BUDGET)
            android.util.Log.i("UltraPerceive", "deep read: STRUCTURED ${rows.size} items, $scrolls scrolls")
            val omitted = if (shown < rows.size) "\n… ${rows.size - shown} more items not shown (output limit)." else ""
            return "Read ${rows.size} list items across ${scrolls + 1} screen(s) — $stoppedBecause.\n" +
                "Each numbered item's lines belong together; they come from the same element on the page.\n\n" +
                body + omitted
        }

        val all = seen.toList()
        val out = StringBuilder()
        var used = 0
        var shown = 0
        for (l in all) {
            if (used + l.length + 1 > DEEP_BUDGET) break
            out.append(l).append('\n')
            used += l.length + 1
            shown++
        }
        android.util.Log.i("UltraPerceive", "deep read: FLAT ${all.size} labels, $scrolls scrolls")
        val footer = if (shown < all.size) "\n… ${all.size - shown} more items not shown (output limit)." else ""
        return "Read ${all.size} items across ${scrolls + 1} screen(s) — $stoppedBecause. " +
            "No repeating list structure on this screen, so these are in page order.\n" +
            out.toString().trimEnd() + footer
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

        /** Reach personal data directly, bypassing the app-access list. */
        val PERSONAL_TOOLS = setOf("sms_send", "sms_read", "contacts_read", "device_location")

        /** Perception budgets. Characters, not node counts — a node count
         * punishes a page for having short labels. */
        const val LABEL_CHARS = 120
        const val VIEWPORT_BUDGET = 4000
        const val DEEP_BUDGET = 12000
        const val MAX_DEEP_LABELS = 600
        const val SCROLL_SETTLE_MS = 650L

        /** Shorter than SCROLL_SETTLE_MS: scrolling back reads nothing, so it
         * only has to let each gesture land, not wait for content to render. */
        const val RESTORE_SETTLE_MS = 250L

        /** Screens are cheap to relearn, so the table stays small. */
        const val SCREEN_MEMORY_LIMIT = 300

        const val PROTECTED = com.agent.ultra.AgentAccessibilityService.PROTECTED
        const val PROTECTED_MSG =
            "Error: this app is on the user's protected list - its screen cannot be read. " +
                "Do not try again with another screen-reading tool. Tell the user which app " +
                "it is, and that they can change it in Settings if they want to."
    }
}

package com.agent.ultra.agent

import com.agent.ultra.provider.OpenAiClient
import kotlinx.coroutines.delay
import org.json.JSONArray

/**
 * Perceive → think → act → verify loop for driving other apps' UIs.
 * Ported from the proven ReActLoop.ts: observe the a11y tree, hand the model
 * indexed action lists, execute one action, re-observe, verify change.
 */
class ReActNavigator(
    private val controller: AgentController,
    private val client: OpenAiClient,
) {
    companion object {
        private const val MAX_ITER = 15

        /** Ultra surfacing its own action-gate card is not drifting away from
         * the task — it is the task waiting for a tap. */
        private const val OWN_PACKAGE = "com.agent.ultra"

        /** How many steps a run may be repaid for being pushed out of its own
         * app. Capped so a run that is genuinely lost still ends. */
        private const val MAX_RECOVERY_GRACE = 5
        private val DOMAIN =
            Regex("[a-z0-9-]+\\.(com|org|net|io|gov|edu)", RegexOption.IGNORE_CASE)

        /**
         * Internal, not private, so a test can prove the notes actually reach the
         * model. The repeat hint was computed and never interpolated — it existed
         * in the source, was logged as shipped, and was never once sent.
         */
        internal fun buildPrompt(
            goal: String,
            observation: String,
            history: List<String>,
            repeatedNoOp: Int = 0,
            leftAppFor: Int = 0,
            target: String = "",
        ): String {
            val stuck = if (repeatedNoOp >= 2)
                "You are repeating yourself. Try back(), or type the destination directly."
            else ""
            // Two steps in a row outside the target app is not a detour any more.
            val strayed = if (leftAppFor >= 2)
                "You have been outside $target for $leftAppFor steps. Press back() until you are back in it."
            else ""
            val notes = listOf(stuck, strayed).filter { it.isNotBlank() }
            val noteBlock = if (notes.isEmpty()) "" else "\nNOTES:\n" + notes.joinToString("\n") { "- $it" } + "\n"
            val hist = if (history.isEmpty()) "" else "\nHISTORY:\n" + history.takeLast(6).joinToString("\n")
            return """You are driving an Android phone's UI to accomplish: "$goal"

CURRENT SCREEN:
$observation
$hist$noteBlock
Reply with exactly ONE action on one line, one of:
  tap(INDEX)        — tap a listed element by its [index]
  type("text")      — type into the first TYPEABLE field, then submit
  type(INDEX, "text") — type into a specific field
  scroll(down) / scroll(up)
  back()
  done              — only when the goal is visibly complete

ACTION:"""
        }
    }

    data class NavResult(val success: Boolean, val summary: String, val steps: Int)

    /**
     * Has the goal visibly happened, without asking the model?
     *
     * The measured failure was "go to google.com in Chrome": the page loaded on
     * step one and the navigator then spent its whole budget deciding whether
     * it was finished. When the goal names a destination and the screen is
     * showing it, that is the answer - no model turn required.
     */
    private fun goalSatisfied(goal: String, observation: String): Boolean {
        val target = DOMAIN.find(goal)?.value ?: return false
        val bare = target.removePrefix("www.")
        return observation.contains(bare, ignoreCase = true)
    }

    suspend fun run(goal: String, appHint: String): String {
        val result = execute(goal, appHint)
        return if (result.success) "Goal achieved after ${result.steps} steps: ${result.summary}"
        else "Error: navigation incomplete after ${result.steps} steps: ${result.summary}"
    }

    suspend fun execute(goal: String, appHint: String): NavResult {
        if (!controller.serviceRunning) return NavResult(false, "accessibility service not running", 0)

        // Resolve and launch the target app
        val pkg = controller.findPackage(if (appHint.isBlank()) goal else appHint)
            ?: return NavResult(false, "no app matching '$appHint'", 0)
        if (!controller.launchApp(pkg)) return NavResult(false, "could not launch $pkg", 0)
        delay(2500)

        var observation = observe()
        // Launching the app may already have satisfied the goal.
        if (goalSatisfied(goal, observation)) {
            return NavResult(true, "already showing the goal", 0)
        }
        var lastTreePrefix = ""
        var stuckCount = 0
        var lastAction = ""
        var repeatedNoOp = 0
        var leftAppFor = 0
        val history = mutableListOf<String>()

        // Steps spent because something else took the screen are not steps the
        // agent wasted. Measured: an alarm app taking the foreground mid-task
        // cost four steps to notice and back out of, and the run then died of
        // "iteration budget exhausted" having recovered correctly. Recovery is
        // repaid, up to a cap so a genuinely lost run still ends.
        var grace = 0
        var iter = 0
        while (iter < MAX_ITER + grace) {
            iter++
            val prompt = buildPrompt(goal, observation, history, repeatedNoOp, leftAppFor, pkg)
            val reply = client.complete(
                listOf(OpenAiClient.ChatMessage("user", prompt)),
                maxTokens = 600,
                temperature = 0.1,
            ).getOrElse { return NavResult(false, "model call failed: ${it.message}", iter - 1) }

            val action = extractAction(reply)
                ?: return NavResult(false, "model gave no parseable action", iter - 1)

            if (action.equals("done", true)) {
                // Verify we're still on the expected app before accepting
                val onPkg = controller.activePackage()
                if (onPkg == pkg) return NavResult(true, "model reports goal complete", iter)
                history += "step $iter: tried done but left target app ($onPkg)"
                continue
            }

            val before = observation
            val ok = executeAction(action, observation)
            delay(900)
            observation = observe()
            val changed = observation != before

            if (goalSatisfied(goal, observation)) {
                return NavResult(true, "goal visible on screen after $iter steps", iter)
            }

            // An action that changes nothing, twice, is the model looping. Say
            // so in words it can act on, rather than letting it rediscover the
            // same dead end for the rest of the budget.
            if (!changed && action == lastAction) repeatedNoOp++ else repeatedNoOp = 0
            lastAction = action

            // Did that action take us out of the app we were sent to?
            //
            // A tap can open an ad, a share sheet, the Play Store, or a call
            // can arrive mid-task. The screen genuinely changed, so without
            // this the step reads as progress and the loop carries on driving
            // whatever app it landed in.
            //
            // Reported, not corrected. Some goals legitimately leave the app —
            // a link in an email opens the browser — so the engine states the
            // fact and the model decides whether to go back.
            // activePackage() returns "" when it cannot tell, not null, so a
            // null check passes for every String and an unknown foreground
            // would be reported as having left the app. Not knowing where we
            // are is not evidence of being somewhere else.
            val onPkg = controller.activePackage()
            val drifted = onPkg.isNotBlank() && onPkg != pkg && onPkg != OWN_PACKAGE
            if (drifted) {
                leftAppFor++
                if (grace < MAX_RECOVERY_GRACE) grace++
                android.util.Log.i(
                    "UltraNav",
                    "DRIFT: now in $onPkg, target $pkg (step $iter, $leftAppFor in a row, grace $grace)",
                )
            } else {
                leftAppFor = 0
            }

            val outcome = if (changed) "screen changed"
                else if (ok) "NO CHANGE - do not repeat this"
                else "FAILED - do not repeat this"
            val drift = if (drifted)
                " — you are now in $onPkg, NOT $pkg. Use back() unless leaving was intended."
            else ""
            history += "step $iter: $action → $outcome$drift"

            // Stuck detector: same tree twice → scroll down once
            val prefix = observation.take(80)
            if (prefix == lastTreePrefix) {
                stuckCount++
                if (stuckCount >= 2) {
                    controller.scroll("down")
                    delay(600)
                    stuckCount = 0
                    observation = observe()
                }
            } else stuckCount = 0
            lastTreePrefix = prefix
        }
        return NavResult(false, "iteration budget exhausted", iter)
    }

    /** a11y flat nodes → indexed TAPPABLE/TYPEABLE/SCROLLABLE lists (visible-only). */
    private suspend fun observe(): String {
        val flat = controller.screenFlat()
        return try {
            val arr = JSONArray(flat)
            if (arr.length() == 0) return "Screen: empty or inaccessible"
            val screenH = 2400 // conservative; off-screen filter is a heuristic
            val tappable = mutableListOf<String>()
            val typeable = mutableListOf<String>()
            val scrollable = mutableListOf<String>()
            for (i in 0 until arr.length()) {
                val n = arr.getJSONObject(i)
                val label = n.optString("t").ifBlank { n.optString("d") }.trim().take(50)
                if (label.isBlank()) continue
                val y = n.optDouble("y", 0.0)
                if (y < 0 || y > screenH) continue
                val idx = n.optInt("i", i)
                val editable = n.optBoolean("e", false)
                val clickable = n.optBoolean("c", false)
                val scrollableN = n.optBoolean("s", false)
                val hint = when {
                    editable -> " (input)"
                    clickable && label.lowercase().matches(Regex(".*\\b(ok|cancel|done|save|submit|send|close|accept|deny|allow|skip|next|back|yes|no)\\b.*")) -> " (button)"
                    clickable && label.lowercase().matches(Regex(".*\\b(settings|account|about|privacy|security|general|display|sound|battery)\\b.*")) -> " (menu-item)"
                    else -> ""
                }
                when {
                    editable -> typeable += "  [$idx] $label$hint"
                    clickable -> tappable += "  [$idx] $label$hint"
                    scrollableN && tappable.isEmpty() -> scrollable += "  [$idx] $label"
                }
            }
            val parts = mutableListOf<String>()
            if (tappable.isNotEmpty()) parts += "TAPPABLE:\n" + tappable.take(20).joinToString("\n")
            if (typeable.isNotEmpty()) parts += "TYPEABLE:\n" + typeable.take(5).joinToString("\n")
            if (scrollable.isNotEmpty()) parts += "SCROLLABLE:\n" + scrollable.take(3).joinToString("\n")
            if (parts.isEmpty()) "Screen has no interactive elements — try scroll(down) or back()"
            else parts.joinToString("\n\n")
        } catch (e: Exception) {
            "Screen: observation failed (${e.message})"
        }
    }

    /** Accepts "ACTION: tap(5) // reason" or a bare "tap(5)" line. */
    private fun extractAction(text: String): String? {
        val t = text.trim()
        Regex("^ACTION:\\s*(.+)$", RegexOption.MULTILINE).find(t)?.let { m ->
            return m.groupValues[1].replace(Regex("\\s*//.*$"), "").trim()
        }
        Regex(
            "^(tap_index\\(\\s*\\d+\\s*\\)|tap\\(\\s*\\d+(?:\\s*,\\s*\\d+)?\\s*\\)|type\\(\\s*\\d*\\s*,?\\s*[\"'][^)]*[\"']\\s*\\)|scroll\\((?:up|down)\\)|back\\(\\)|home\\(\\)|done)$",
            setOf(RegexOption.IGNORE_CASE, RegexOption.MULTILINE),
        ).find(t)?.let { return it.groupValues[1].trim() }
        return null
    }

    private suspend fun executeAction(action: String, observation: String): Boolean {
        val a = action.trim()
        Regex("tap_index\\((\\d+)\\)", RegexOption.IGNORE_CASE).find(a)?.let { m ->
            return tapNodeIndex(m.groupValues[1].toInt())
        }
        Regex("tap\\((\\d+)\\)$", RegexOption.IGNORE_CASE).find(a)?.let { m ->
            return tapNodeIndex(m.groupValues[1].toInt())
        }
        Regex("tap\\((\\d+)\\s*,\\s*(\\d+)\\)", RegexOption.IGNORE_CASE).find(a)?.let { m ->
            val x = m.groupValues[1].toInt()
            val y = m.groupValues[2].toInt()
            // A raw-coordinate tap hides what it is hitting; look it up before
            // letting it through, or the gate is trivially bypassed by the
            // model choosing coordinates over an index.
            if (!approveTap(labelAtPoint(x, y), "tap($x,$y)")) return false
            return controller.tap(x, y)
        }
        Regex("type\\(\\s*(\\d*)\\s*,?\\s*[\"']([^)]+)[\"']\\s*\\)", RegexOption.IGNORE_CASE).find(a)?.let { m ->
            val idx = m.groupValues[1].toIntOrNull()
            val text = m.groupValues[2]
            // Empty selector → the service types into the FOCUSED editable field.
            // If nothing is focused (the proven Chrome failure: TEXT result=false
            // forever), tap the first editable node to focus it first.
            val selector = if (idx == null) "" else labelForIndex(idx) ?: return false
            if (idx == null) focusFirstEditable()
            val ok = controller.typeInto(selector, text)
            if (ok) { delay(300); controller.imeEnter() }
            return ok
        }
        Regex("scroll\\((up|down)\\)", RegexOption.IGNORE_CASE).find(a)?.let { m ->
            return controller.scroll(m.groupValues[1].lowercase())
        }
        if (a.equals("back()", true)) return controller.back()
        if (a.equals("home()", true)) return controller.home()
        return false
    }

    /** Resolve an [index] from the flat list to on-screen coordinates and tap. */
    private suspend fun tapNodeIndex(index: Int): Boolean {
        val flat = controller.screenFlat()
        return try {
            val arr = JSONArray(flat)
            for (i in 0 until arr.length()) {
                val n = arr.getJSONObject(i)
                if (n.optInt("i", -1) == index) {
                    val x = n.optInt("x", -1)
                    val y = n.optInt("y", -1)
                    val label = n.optString("t").ifBlank { n.optString("d") }.trim()
                    if (x >= 0 && y >= 0) {
                        if (!approveTap(label, "tap_index($index)")) return false
                        return controller.tap(x, y)
                    }
                }
            }
            false
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Stop and ask before a tap that commits something. Everything else runs
     * untouched — a gate that fires on every tap gets waved through.
     */
    private suspend fun approveTap(label: String, action: String): Boolean {
        val reason = ActionGate.commitmentIn(label) ?: return true
        val pkg = controller.activePackage()
        val approved = ActionGate.approve(action, label, pkg ?: "this app", reason)
        if (!approved) {
            android.util.Log.i("UltraNav", "action refused by operator: \"$label\"")
            return false
        }
        // Answering the card put Ultra in front. Tapping now would hit Ultra's
        // own UI at the target's coordinates, so put the target back first.
        if (pkg != null && controller.activePackage() != pkg) {
            controller.launchApp(pkg)
            delay(1500)
        }
        return true
    }

    /** What is at these coordinates, so a raw tap can be described. */
    private suspend fun labelAtPoint(x: Int, y: Int): String {
        return try {
            val arr = JSONArray(controller.screenFlat())
            var best = ""
            var bestDist = Int.MAX_VALUE
            for (i in 0 until arr.length()) {
                val n = arr.getJSONObject(i)
                val label = n.optString("t").ifBlank { n.optString("d") }.trim()
                if (label.isBlank()) continue
                val dx = n.optInt("x", -9999) - x
                val dy = n.optInt("y", -9999) - y
                val d = dx * dx + dy * dy
                if (d < bestDist) { bestDist = d; best = label }
            }
            // Only trust a nearby node; a distant one is not what was tapped.
            if (bestDist <= 40_000) best else ""
        } catch (_: Exception) { "" }
    }

    /** Tap the first editable node's center so performText("") has focus. */
    private suspend fun focusFirstEditable() {
        try {
            val arr = JSONArray(controller.screenFlat())
            for (i in 0 until arr.length()) {
                val n = arr.getJSONObject(i)
                if (n.optBoolean("e", false)) {
                    val x = n.optInt("x", -1)
                    val y = n.optInt("y", -1)
                    if (x >= 0 && y >= 0) {
                        controller.tap(x, y)
                        delay(500)
                    }
                    return
                }
            }
        } catch (_: Exception) {}
    }

    /** Look up a node's text/description label by flat-list index. */
    private suspend fun labelForIndex(index: Int): String? {
        return try {
            val arr = JSONArray(controller.screenFlat())
            for (i in 0 until arr.length()) {
                val n = arr.getJSONObject(i)
                if (n.optInt("i", -1) == index) {
                    val label = n.optString("t").ifBlank { n.optString("d") }.trim()
                    return label.ifBlank { null }
                }
            }
            null
        } catch (_: Exception) { null }
    }
}

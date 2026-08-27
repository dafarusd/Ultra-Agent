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
    }

    data class NavResult(val success: Boolean, val summary: String, val steps: Int)

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
        var lastTreePrefix = ""
        var stuckCount = 0
        val history = mutableListOf<String>()

        for (iter in 1..MAX_ITER) {
            val prompt = buildPrompt(goal, observation, history)
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
            history += "step $iter: $action → ${if (changed) "screen changed" else if (ok) "no visual change" else "FAILED"}"

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
        return NavResult(false, "iteration budget exhausted", MAX_ITER)
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

    private fun buildPrompt(goal: String, observation: String, history: List<String>): String {
        val hist = if (history.isEmpty()) "" else "\nHISTORY:\n" + history.takeLast(6).joinToString("\n")
        return """You are driving an Android phone's UI to accomplish: "$goal"

CURRENT SCREEN:
$observation
$hist
Reply with exactly ONE action on one line, one of:
  tap(INDEX)        — tap a listed element by its [index]
  type("text")      — type into the first TYPEABLE field, then submit
  type(INDEX, "text") — type into a specific field
  scroll(down) / scroll(up)
  back()
  done              — only when the goal is visibly complete

ACTION:"""
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
            return controller.tap(m.groupValues[1].toInt(), m.groupValues[2].toInt())
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
                    if (x >= 0 && y >= 0) return controller.tap(x, y)
                }
            }
            false
        } catch (_: Exception) {
            false
        }
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

package com.agent.ultra.agent

import android.content.Context
import com.agent.ultra.gate.Gate
import com.agent.ultra.gate.Manifest
import com.agent.ultra.provider.OpenAiClient
import com.agent.ultra.provider.ProviderConfig
import com.agent.ultra.ui.ChatMessage
import com.agent.ultra.ui.ChatStore
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The brain: a 12-turn tool loop. Ported from the proven BrainExecutor.ts —
 * same prompt shape, same parse rule (first balanced JSON object with a
 * "tool" key), dynamic token budget, push-once follow-through, stuck
 * detector, structured result feedback. Conversation-bleed fix in the port:
 * each request starts from a fresh message list with a capped history window.
 */
class Brain(context: Context) {

    private val controller = AgentController(context)
    private val tools: Tools
    private val client: OpenAiClient?
    private val gate: Gate

    init {
        val cfg = ProviderConfig.load(context)
        client = if (cfg.isUsable) OpenAiClient(cfg) else null
        tools = Tools(context, controller)
        if (client != null) tools.navigator = ReActNavigator(controller, client)
        gate = Gate(loadManifest(context))
    }

    private fun loadManifest(context: Context): Manifest = try {
        context.assets.open("ultra.manifest.json").bufferedReader().use { r ->
            Manifest.fromJson(JSONObject(r.readText()))
        }
    } catch (e: Exception) {
        android.util.Log.e("UltraBrain", "manifest load failed — gate will deny everything", e)
        Manifest.fromJson(JSONObject("""{"tools":[]}"""))
    }

    val configured: Boolean get() = client != null

    suspend fun run(userInput: String) {
        val ai = client
        if (ai == null) {
            emit("No AI provider configured. Push ultra_provider.json to the app's files dir or add settings UI.")
            return
        }

        // Fresh-window history: last exchanges from this conversation, char-capped.
        // (Fix-in-port: Build 29's context bleed came from carrying tool traces
        // across unrelated requests — tool feedback never enters this window.)
        val messages = mutableListOf(OpenAiClient.ChatMessage("system", systemPrompt()))
        val history = ChatStore.messages.takeLast(8)
        val budget = 4000
        var used = 0
        val kept = mutableListOf<OpenAiClient.ChatMessage>()
        for (m in history.asReversed()) {
            if (used + m.text.length > budget) break
            kept += OpenAiClient.ChatMessage(if (m.fromUser) "user" else "assistant", m.text)
            used += m.text.length
        }
        messages += kept.asReversed()
        messages += OpenAiClient.ChatMessage("user", userInput)

        runLoop(ai, userInput, messages)
    }

    private fun emit(text: String) {
        ChatStore.messages.add(ChatMessage(fromUser = false, text = text))
    }

    private suspend fun runLoop(
        ai: OpenAiClient,
        userInput: String,
        messages: MutableList<OpenAiClient.ChatMessage>,
    ) {
        val maxTurns = 12
        var hasBeenPushed = false
        var finalText = ""
        var lastTool = ""
        var lastToolFailed = false
        // One security episode per user request; secrets accumulate across tools.
        val episode = Gate.Episode(userInput)

        for (turn in 0 until maxTurns) {
            val maxTokens = if (turn == 0) 2000 else if (turn >= maxTurns - 2) 2500 else 1500
            val reply = ai.complete(messages, maxTokens, 0.2).getOrElse {
                emit("Error: model call failed — ${it.message}")
                return
            }
            val raw = reply.trim()

            var toolCall = parseToolCall(raw)

            if (toolCall == null) {
                // Push-once: user asked for an action, brain only described it
                if (turn > 0 && turn < maxTurns - 2 && !hasBeenPushed && userWantsAction(userInput) && raw.length < 800) {
                    hasBeenPushed = true
                    messages += OpenAiClient.ChatMessage("assistant", raw)
                    messages += OpenAiClient.ChatMessage("user",
                        "You described what to do but didn't do it. Use a tool to actually complete the action. Don't explain — execute.")
                    continue
                }
                finalText = raw
                break
            }

            // ── POLICY GATE (M3) — deterministic, no model judgment ──
            val verdict = gate.enforceCall(episode, toolCall.first, toolCall.second)
            if (!verdict.allowed) {
                val blockMsg = Gate.renderBlock(verdict)
                android.util.Log.i("UltraGate", "BLOCK ${toolCall.first}: ${verdict.violations.firstOrNull()?.hint}")
                messages += OpenAiClient.ChatMessage("assistant", raw)
                messages += OpenAiClient.ChatMessage("user",
                    "[RESULT: ${toolCall.first}] STATUS: blocked\nDATA: $blockMsg\nDECIDE: Continue with the rest of the task, or answer the user.")
                lastTool = toolCall.first
                lastToolFailed = true
                continue
            }

            // Confirmation notice for destructive tools — UX layer; the gate
            // above is the enforcement layer.
            if (Tools.DESTRUCTIVE.contains(toolCall.first)) {
                val desc = describeAction(toolCall.first, toolCall.second)
                emit("About to: $desc")
            }

            android.util.Log.i("UltraBrain", "TOOL CALL: ${toolCall.first} params=${toolCall.second.toString().take(120)}")
            val resultText = tools.execute(toolCall.first, toolCall.second)
            episode.observeSecrets(resultText)
            val failed = resultText.startsWith("Error:") || resultText.startsWith("Could not")
            android.util.Log.i("UltraBrain", "TOOL RESULT (${if (failed) "fail" else "ok"}): ${resultText.take(120)}")

            // Stuck detector: same tool failed twice in a row → stop honestly
            if (failed && lastToolFailed && lastTool == toolCall.first) {
                finalText = "That didn't work — ${toolCall.first} failed twice. ${resultText.take(150)}"
                break
            }
            lastTool = toolCall.first
            lastToolFailed = failed

            messages += OpenAiClient.ChatMessage("assistant", raw)
            messages += OpenAiClient.ChatMessage("user", buildFeedback(toolCall.first, resultText, turn, maxTurns, failed))

            if (turn == maxTurns - 1) finalText = "Ran ${toolCall.first}: ${resultText.take(300)}"
        }

        if (finalText.isNotBlank()) emit(finalText)
    }

    // ── Parsing & prompt (ported shapes) ───────────────────────────────

    /** First balanced {...} containing a "tool" key, code fences stripped. */
    private fun parseToolCall(text: String): Pair<String, JSONObject>? {
        val cleaned = text.replace("```json", "").replace("```", "").trim()
        val start = cleaned.indexOf('{')
        if (start < 0) return null
        var depth = 0
        var end = -1
        for (i in start until cleaned.length) {
            when (cleaned[i]) {
                '{' -> depth++
                '}' -> { depth--; if (depth == 0) { end = i; break } }
            }
        }
        if (end < 0) return null
        return try {
            val obj = JSONObject(cleaned.substring(start, end + 1))
            val tool = obj.optString("tool")
            if (tool.isBlank()) null
            else tool to (obj.optJSONObject("params") ?: JSONObject())
        } catch (_: Exception) { null }
    }

    private fun userWantsAction(input: String): Boolean =
        Regex("\\b(navigate|send|text|open|go to|take me|set|create|make|call|play|turn on|turn off|toggle|install|download|share|copy|find me|get me|show me|order|book|buy)\\b",
            RegexOption.IGNORE_CASE).containsMatchIn(input)

    private fun describeAction(tool: String, params: JSONObject): String = when (tool) {
        "sms_send" -> "Send a text to ${params.optString("to").ifBlank { "unknown" }}: \"${params.optString("message")}\""
        "file_delete" -> "Delete file: ${params.optString("filename").ifBlank { params.optString("path") }}"
        else -> "Execute $tool"
    }

    private fun buildFeedback(tool: String, result: String, turn: Int, maxTurns: Int, failed: Boolean): String {
        val status = if (failed) "failed" else "success"
        var fb = "[RESULT: $tool] STATUS: $status\nDATA: ${result.take(2500)}\nTURNS_LEFT: ${maxTurns - turn - 1}/$maxTurns"
        fb += if (tool == "web_search" && result.contains("Search results"))
            "\nYou have the search results above. Answer the user directly. Do NOT open a browser."
        else
            "\nDECIDE: Answer the user, or call the next tool."
        return fb
    }

    private fun systemPrompt(): String {
        val now = Date()
        val date = SimpleDateFormat("EEEE, MMMM d, yyyy", Locale.US).format(now)
        val time = SimpleDateFormat("h:mm a", Locale.US).format(now)
        val env = buildList {
            add(controller.batteryStatus())
            controller.currentWifiSsid()?.let { add("WiFi: $it") }
        }.joinToString(" | ")

        return """You are Ultra — a capable, concise AI agent controlling this Android phone.
PHONE STATE: $env
TODAY: $date at $time

FORMAT: To use a tool: {"tool":"name","params":{...}} — To talk: plain text. ONE tool call per response.

$TOOL_CATALOG

RULES:
1. Understand what the user WANTS, break it into steps, execute each with a tool call. You get up to 12 tool calls.
2. ALWAYS prefer direct tools over UI automation: toggles > app_launch > react_navigate. Only use react_navigate when you need to interact INSIDE an app.
3. When web_search returns text results, READ THEM and answer directly. Do NOT open a browser to see results you already have. MAX 2 web_searches per task.
4. After every tool call, VERIFY the result. If it failed, try a different approach. If the same tool fails twice, stop and tell the user.
5. Read screen content (read_text_on_screen) to gather data, then use it in the next tool call.
6. When you have enough information to answer, STOP calling tools and give a clear, complete answer.
7. If you hit a login screen, captcha, or permission dialog: STOP and ask the user to handle it.
8. NEVER send messages or make calls unless the user EXPLICITLY asks."""
    }

    companion object {
        private const val TOOL_CATALOG = """
DEVICE CONTROL (instant, ~99% reliable):
  wifi_toggle, bluetooth_toggle, do_not_disturb, flashlight_toggle, volume_set
  media_play, media_next

APPS & NAVIGATION (use app_launch to just open, react_navigate to open AND interact):
  app_launch — open app (no interaction). params: {target}
  react_navigate — open app AND do things inside it (tap, type, scroll). params: {goal, appHint}
  open_url — open a URL in browser. params: {url}

INFORMATION (fast, no UI needed):
  web_search — search internet, returns text results directly. params: {query}
  device_info, system_info, battery_status, device_location

COMMUNICATION:
  sms_send — send SMS. params: {to, message}
  sms_read — read inbox. params: {limit?}
  contacts_read — search contacts. params: {name?}

FILES & CLIPBOARD & CREATION:
  clipboard_write {text}, clipboard_read, note_create {text}, alarm_set {hour, minute?, label?}

SCREEN:
  read_text_on_screen, describe_screen
"""
    }
}

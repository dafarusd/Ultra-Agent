package com.agent.ultra.agent

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
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
class Brain(context: Context, private val local: com.agent.ultra.local.LocalModelEngine) {

    private val controller = AgentController(context)
    private val tools: Tools
    private val client: OpenAiClient?
    private val gate: Gate
    private val taskMemory = com.agent.ultra.data.UltraDatabase.get(context).taskMemory()
    private val recipes = Recipes(com.agent.ultra.data.UltraDatabase.get(context).recipes())

    /** Called with the final user-facing answer of a run. The voice session
     * speaks it; the chat screen speaks it when speak-back is enabled. */
    var onAnswer: ((String) -> Unit)? = null

    init {
        val cfg = ProviderConfig.load(context)
        client = if (cfg.isUsable) OpenAiClient(cfg) else null
        tools = Tools(context, controller)
        if (client != null) tools.navigator = ReActNavigator(controller, client)
        tools.recipes = recipes
        tools.recipeRunner = { name -> runRecipe(name) }
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

    /** What the model chip shows: the cloud model, or the on-device one. */
    val modelLabel: String get() = client?.modelName ?: "Gemma 3 1B (on-device)"

    /** Non-null while a confirmable policy-gate block waits on the operator.
     * The chat UI renders a confirm/cancel card from this. */
    var pendingConfirm by mutableStateOf<PendingConfirm?>(null)

    data class PendingConfirm(
        val description: String,
        val targets: List<String>,
        internal val tool: String,
        internal val params: JSONObject,
        internal val rawAssistant: String,
        internal val messages: MutableList<OpenAiClient.ChatMessage>,
        internal val turn: Int,
        internal val episode: Gate.Episode,
        internal val userInput: String,
    )

    /** The operator's decision on a paused action. */
    suspend fun resolvePending(approved: Boolean) {
        val p = pendingConfirm ?: return
        pendingConfirm = null
        val ai = client ?: return
        if (!approved) {
            emit("Cancelled: ${p.description}")
            return
        }
        // The operator's tap mints the targets as user-attested for this episode.
        p.targets.forEach { p.episode.confirm(it) }
        android.util.Log.i("UltraGate", "CONFIRMED ${p.tool} targets=${p.targets}")
        val resultText = tools.execute(p.tool, p.params)
        p.episode.observeSecrets(resultText)
        val failed = resultText.startsWith("Error:") || resultText.startsWith("Could not")
        p.messages += OpenAiClient.ChatMessage("assistant", p.rawAssistant)
        p.messages += OpenAiClient.ChatMessage("user",
            "[RESULT: ${p.tool}] STATUS: ${if (failed) "failed" else "success"}\nDATA: ${resultText.take(2500)}\nDECIDE: Answer the user, or call the next tool.")
        runLoop(ai, p.userInput, p.messages, startTurn = p.turn + 1, episodeOverride = p.episode)
    }

    suspend fun run(userInput: String) {
        // A recipe is a name the user chose. Matching it is a lookup, not a
        // judgment call — measured: llama-3.3-70b read "run my morning
        // briefing" as a question about which model it is. The engine owns
        // structure; the model never sees this one.
        if (tryRecipeShortcut(userInput)) {
            android.util.Log.i("UltraBrain", "RUN COMPLETE (recipe shortcut)")
            return
        }

        val ai = client
        if (ai == null) {
            // Offline/unconfigured path: the on-device model is the brain.
            if (!local.ensureLoaded()) {
                answer("No AI provider configured and no on-device model present.")
                return
            }
            emitLocal(userInput)
            return
        }

        // Local-first routing: simple device commands run on the on-device
        // model — faster, free, private, works offline. Complex or ambiguous
        // requests go straight to the cloud loop. A local miss escalates.
        if (isSimpleLocalIntent(userInput) && local.ensureLoaded()) {
            val handled = runLocalLoop(userInput)
            if (handled) return
            emit("(on-device model couldn't map that — trying the cloud)")
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

        // Task memory: prior successful sequence for this request, and any
        // tools with a failing record, become a system-side hint.
        memoryHint(userInput)?.let {
            android.util.Log.i("UltraBrain", "MEMORY HINT injected: ${it.take(100)}")
            messages.add(1, OpenAiClient.ChatMessage("system", it))
        }

        runLoop(ai, userInput, messages)
        android.util.Log.i("UltraBrain", "RUN COMPLETE")
    }

    /** Run a saved recipe directly when the request names one. Requires either
     * an explicit run verb ("run my morning briefing") or the bare recipe name,
     * so ordinary requests are never hijacked by a similarly-named routine. */
    private suspend fun tryRecipeShortcut(userInput: String): Boolean {
        return try {
            val row = recipes.resolve(userInput) ?: return false
            val hasRunVerb = Regex("^\\s*(run|start|do|execute|play)\\b")
                .containsMatchIn(userInput.lowercase())
            val isBareName = Recipes.normalize(userInput) == row.name
            if (!hasRunVerb && !isBareName) return false
            answer(runRecipe(row.name))
            true
        } catch (_: Exception) { false }
    }

    /**
     * Replay a saved recipe. The stored arguments were user-attested when the
     * recipe was created, so they are minted as confirmed targets for this
     * episode — otherwise every traceability contract would block, since
     * "run morning briefing" contains none of the recipe's actual targets.
     * Taint, spoof, and undeclared-tool checks are untouched and still apply.
     */
    private suspend fun runRecipe(name: String): String {
        val row = recipes.resolve(name)
            ?: return "Error: no recipe named \"$name\". Say \"list my recipes\" to see what is saved."
        val steps = recipes.stepsOf(row.name).orEmpty()
        if (steps.isEmpty()) return "Error: recipe \"${row.name}\" has no steps"

        val episode = Gate.Episode("run recipe ${row.name}")
        for (step in steps) {
            for (key in step.params.keys()) {
                step.params.opt(key)?.toString()?.let { episode.confirm(it) }
            }
        }

        android.util.Log.i("UltraBrain", "RECIPE RUN ${row.name} (${steps.size} steps)")
        val lines = mutableListOf<String>()
        var failures = 0
        for ((i, step) in steps.withIndex()) {
            val verdict = gate.enforceCall(episode, step.tool, step.params)
            if (!verdict.allowed) {
                val hint = verdict.violations.firstOrNull()?.hint ?: "blocked"
                android.util.Log.i("UltraGate", "RECIPE BLOCK ${step.tool}: $hint")
                lines += "${i + 1}. ${step.tool} — blocked by policy gate ($hint)"
                failures++
                continue
            }
            val result = tools.execute(step.tool, step.params)
            episode.observeSecrets(result)
            if (result.startsWith("Error:")) failures++
            android.util.Log.i("UltraBrain", "RECIPE STEP ${step.tool}: ${result.take(80)}")
            lines += "${i + 1}. ${result.take(200)}"
        }
        recipes.markRun(row.name)
        val header = if (failures == 0) "Ran \"${row.name}\" (${steps.size} steps):"
            else "Ran \"${row.name}\" with $failures problem(s):"
        return header + "\n" + lines.joinToString("\n")
    }

    private fun requestKey(input: String): String =
        input.lowercase().replace(Regex("[^a-z0-9 ]"), "").replace(Regex("\\s+"), " ").trim()

    /** Content words only — the words that carry what the request is about. */
    private fun contentTokens(input: String): Set<String> =
        requestKey(input).split(" ")
            .filter { it.length > 2 && it !in STOPWORDS }
            .toSet()

    /**
     * Find what worked for a request like this one.
     *
     * Exact-string keys were nearly useless: "whats my location" and "what is
     * my location" were separate rows with separate memories. Matching is now
     * a token-set overlap over content words, so the same question phrased two
     * ways hits the same memory.
     */
    private suspend fun bestShortcut(userInput: String): Pair<com.agent.ultra.data.TaskShortcutEntity, Double>? {
        val mine = contentTokens(userInput)
        if (mine.isEmpty()) return null
        var best: com.agent.ultra.data.TaskShortcutEntity? = null
        var bestScore = 0.0
        for (row in taskMemory.allShortcuts()) {
            val theirs = contentTokens(row.requestKey)
            if (theirs.isEmpty()) continue
            // Containment, not Jaccard. The same job asked at different
            // lengths ("battery level" vs "how is the battery doing") scores
            // badly under Jaccard purely for being wordier. What matters is
            // whether the smaller request's subject is present in the larger.
            val overlap = mine.intersect(theirs).size.toDouble()
            val score = overlap / minOf(mine.size, theirs.size)
            if (score > bestScore) { bestScore = score; best = row }
        }
        return if (best != null && bestScore >= MATCH_THRESHOLD) best!! to bestScore else null
    }

    private suspend fun memoryHint(userInput: String): String? {
        return try {
            val parts = mutableListOf<String>()
            val match = bestShortcut(userInput)
            if (match != null && match.first.successCount > 0) {
                val row = match.first
                val how = row.stepsJson.ifBlank { row.toolsCsv }
                parts += "MEMORY: a request like this succeeded before " +
                    "(\"${row.requestKey}\") using: $how. Prefer that approach."

                // Only warn about a tool with a bad record when it is relevant
                // here — the tool that worked last time is not it. A blanket
                // warning on every request is noise the model has to ignore.
                val used = row.toolsCsv.split("→").map { it.trim() }.toSet()
                val risky = taskMemory.unreliableTools()
                    .filter { it.failures >= MIN_FAILURES_TO_WARN && it.tool !in used }
                if (risky.isNotEmpty()) {
                    parts += "AVOID: " + risky.take(2).joinToString { "${it.tool} (${it.failures} recent failures)" }
                }
            }
            if (parts.isEmpty()) null else parts.joinToString("\n")
        } catch (_: Exception) { null }
    }

    /**
     * Record what worked — but only when the TASK worked.
     *
     * Success used to be counted per tool call, so a run that ended with "I
     * couldn't find the price" still stored its tool sequence as the way to do
     * that job, and the wrong lesson got replayed. Per-tool reliability is
     * still recorded either way; that genuinely is a per-call fact.
     */
    private suspend fun recordMemory(
        userInput: String,
        sequence: List<Triple<String, JSONObject, Boolean>>,
        taskSucceeded: Boolean,
    ) {
        try {
            val steps = sequence.filter { it.third && it.first !in RECIPE_TOOLS }
                .map { Recipes.Step(it.first, it.second) }
            if (steps.isNotEmpty()) lastRunSteps = steps

            for ((tool, _, ok) in sequence) {
                val cur = taskMemory.reliabilityFor(tool)
                taskMemory.upsertReliability(
                    com.agent.ultra.data.ToolReliabilityEntity(
                        tool,
                        (cur?.successes ?: 0) + (if (ok) 1 else 0),
                        (cur?.failures ?: 0) + (if (ok) 0 else 1),
                        if (ok) "" else "recent failure",
                    )
                )
            }

            if (!taskSucceeded || steps.isEmpty()) {
                android.util.Log.i("UltraBrain", "MEMORY: not recorded (task succeeded=$taskSucceeded)")
                return
            }
            val key = requestKey(userInput)
            val cur = taskMemory.shortcutFor(key)
            val stepsJson = org.json.JSONArray().also { arr ->
                steps.forEach { arr.put(JSONObject().put("tool", it.tool).put("params", it.params)) }
            }.toString()
            taskMemory.upsertShortcut(
                com.agent.ultra.data.TaskShortcutEntity(
                    key,
                    steps.joinToString(" → ") { it.tool },
                    (cur?.successCount ?: 0) + 1,
                    System.currentTimeMillis(),
                    stepsJson,
                )
            )
            android.util.Log.i("UltraBrain", "MEMORY: recorded \"$key\" -> ${steps.joinToString(" → ") { it.tool }}")
        } catch (_: Exception) {}
    }

    private fun emit(text: String) {
        ChatStore.add(ChatMessage(fromUser = false, text = text))
    }

    /** A run's final, user-facing answer: shown, persisted, and announced to
     * whoever is listening (the voice session, or chat speak-back). */
    private fun answer(text: String) {
        emit(text)
        onAnswer?.invoke(text)
    }

    /** Direct local answer for the offline path — no tool loop at 1B scale. */
    private suspend fun emitLocal(userInput: String) {
        val msg = ChatMessage(false, "")
        ChatStore.addToState(msg)
        val prompt = "You are Ultra, a concise assistant on an offline Android phone. " +
            "Answer briefly and honestly.\n\nUser: $userInput\nUltra:"
        local.generate(prompt, 400) { piece ->
            ChatStore.appendTo(msg.id, piece)
        }.onFailure {
            ChatStore.setText(msg.id, "Error: on-device model failed — ${it.message}")
        }
        val finalMsg = ChatStore.messageById(msg.id) ?: msg
        ChatStore.persist(finalMsg)
        onAnswer?.invoke(finalMsg.text)
    }

    /** Conservative classifier: only commands that map cleanly to the local
     * tool subset route on-device. Anything else goes cloud. */
    private fun isSimpleLocalIntent(input: String): Boolean {
        val u = input.lowercase()
        // Compounds and URL-like targets exceed the 1B model's measured
        // competence (suite t03/t05/t08): those go cloud.
        if (Regex("\\b(and then|then|after that| and )\\b").containsMatchIn(u)) return false
        if (Regex("[a-z0-9-]+\\.(com|org|net|io|edu|gov)\\b").containsMatchIn(u)) return false
        if (u.contains("http")) return false
        return Regex(
            "\\b(flashlight|torch|wi-?fi|bluetooth|do not disturb|dnd|volume|brightness|" +
                "airplane|alarm|timer|battery|clipboard|note this|open|launch|start)\\b"
        ).containsMatchIn(u)
    }

    /** The on-device tool loop: compact catalog, max 2 turns, gate enforced. */
    private suspend fun runLocalLoop(userInput: String): Boolean {
        val episode = Gate.Episode(userInput)
        // What worked before, for the 1B model too. One line, and only when a
        // single tool is involved — this model follows a short concrete hint
        // and drowns in a long one.
        val recalled = try {
            bestShortcut(userInput)?.first?.takeIf { !it.toolsCsv.contains("→") }?.toolsCsv
        } catch (_: Exception) { null }
        if (recalled != null) {
            android.util.Log.i("UltraBrain", "MEMORY HINT (local): $recalled")
        }
        // Few-shot examples — 1B models map intents reliably with them, not
        // without (measured: zero-shot picked flashlight_toggle for 'open
        // chrome'). Trimmed catalog for the local route.
        var prompt = """You are Ultra, an on-device Android agent. Reply with EXACTLY one JSON tool call and nothing else.

TOOLS:
flashlight_toggle {"on":true|false}
wifi_toggle {"on":true|false}
bluetooth_toggle {"on":true|false}
do_not_disturb {"on":true|false}
volume_set {"percent":0-100}
alarm_set {"hour":0-23,"minute":0-59,"label":"..."}
note_create {"text":"..."}
app_launch {"target":"app name"}
battery_status {}
clipboard_read {}
clipboard_write {"text":"..."}

EXAMPLES:
User: turn on the flashlight
JSON: {"tool":"flashlight_toggle","params":{"on":true}}

User: open chrome
JSON: {"tool":"app_launch","params":{"target":"chrome"}}

User: set an alarm for 7 30 am
JSON: {"tool":"alarm_set","params":{"hour":7,"minute":30,"label":"Ultra alarm"}}

User: what's my battery level
JSON: {"tool":"battery_status","params":{}}

User: turn off wifi
JSON: {"tool":"wifi_toggle","params":{"on":false}}

User: $userInput
JSON:"""
        if (recalled != null) {
            prompt = prompt.replace(
                "User: $userInput",
                "A request like this previously worked with: $recalled\n\nUser: $userInput",
            )
        }
        repeat(2) { attempt ->
            val raw = local.generate(prompt, 200).getOrElse { return false }
            // The 1B model keeps writing after its answer — it replays the
            // few-shot examples as if the conversation continued. Cut at the
            // first echoed turn so the logs and the parser see one answer.
            val out = raw.split(Regex("""\n\s*(User|JSON)\s*:"""), limit = 2).first().trim()
            android.util.Log.i("UltraBrain", "LOCAL turn $attempt: ${out.take(120)}")
            // The 1B model reliably emits the tool NAME, not the JSON wrapper
            // (measured on-device). Parse both: JSON first, bare name second —
            // a deterministic engine shapes the params either way.
            val call = parseToolCall(out) ?: parseBareToolCall(out, userInput) ?: run {
                prompt += "\n\nThat was not a JSON tool call. Reply with ONLY the JSON."
                return@repeat
            }
            val verdict = gate.enforceCall(episode, call.first, call.second)
            if (!verdict.allowed) {
                android.util.Log.i("UltraGate", "LOCAL BLOCK ${call.first}: ${verdict.violations.firstOrNull()?.hint}")
                emit("Blocked by policy gate: ${verdict.violations.firstOrNull()?.hint}")
                return true
            }
            android.util.Log.i("UltraBrain", "LOCAL TOOL: ${call.first} ${call.second.toString().take(80)}")
            val result = tools.execute(call.first, call.second)
            episode.observeSecrets(result)
            val verification = verifyAction(call.first, call.second) ?: ""
            val failed = result.startsWith("Error:")
            answer((if (failed) "Tried on-device: $result" else "$result (on-device)") + verification)
            android.util.Log.i("UltraBrain", "RUN COMPLETE (local, tool=${call.first}, ok=${!failed})")
            // On-device runs feed task memory and the recipe buffer too —
            // otherwise "save that as X" after a local command has nothing
            // to save.
            recordMemory(userInput, listOf(Triple(call.first, call.second, !failed)), !failed)
            return true
        }
        return false
    }

    private suspend fun runLoop(
        ai: OpenAiClient,
        userInput: String,
        messages: MutableList<OpenAiClient.ChatMessage>,
        startTurn: Int = 0,
        episodeOverride: Gate.Episode? = null,
    ) {
        val maxTurns = 12
        var hasBeenPushed = false
        var finalText = ""
        var lastTool = ""
        var lastToolFailed = false
        var lastParams = ""
        // One security episode per user request; secrets accumulate across tools.
        val episode = episodeOverride ?: Gate.Episode(userInput)
        // Task memory: track this run's tool outcomes (params included so a
        // successful run can be promoted into a named recipe).
        val toolSequence = mutableListOf<Triple<String, JSONObject, Boolean>>()
        // Task-level success: the model finished with its own answer and
        // nothing failed on the way. Running out of turns, giving up after a
        // repeated failure, or ending on a block are all NOT successes, even
        // though the individual calls before them may have returned fine.
        var naturalFinish = false
        var anyToolFailed = false

        for (turn in startTurn until maxTurns) {
            val maxTokens = if (turn == 0) 2000 else if (turn >= maxTurns - 2) 2500 else 1500
            // Stream the turn into a live bubble; the bubble is removed if the
            // turn ends up being a tool call (raw JSON isn't user-facing).
            val streamMsg = ChatMessage(false, "")
            ChatStore.addToState(streamMsg)
            val reply = ai.completeStreaming(messages, maxTokens, 0.2) { piece ->
                ChatStore.appendTo(streamMsg.id, piece)
            }.getOrElse {
                ChatStore.removeById(streamMsg.id)
                // Cloud failed (offline, quota, outage) — the on-device model
                // answers what it can rather than dying.
                if (local.ensureLoaded()) {
                    emit("(cloud unreachable — answering on-device)")
                    emitLocal(userInput)
                } else {
                    emit("Error: model call failed — ${it.message}")
                }
                return
            }
            val raw = reply.trim()

            val toolCall = parseToolCall(raw)
            // Raw tool JSON is not user-facing — retract the bubble it streamed into.
            if (toolCall != null) ChatStore.removeById(streamMsg.id)

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
                naturalFinish = true
                android.util.Log.i("UltraBrain", "FINAL TEXT (${raw.length} chars)")
                break
            }

            // ── POLICY GATE (M3) — deterministic, no model judgment ──
            val verdict = gate.enforceCall(episode, toolCall.first, toolCall.second)
            if (!verdict.allowed) {
                val blockMsg = Gate.renderBlock(verdict)
                android.util.Log.i("UltraGate", "BLOCK ${toolCall.first}: ${verdict.violations.firstOrNull()?.hint}")
                if (verdict.confirmable) {
                    // Resolve/confirm channel: pause and ask the operator.
                    // Their tap mints the targets user-attested (SPEC §2 R4, live).
                    val targets = verdict.violations.mapNotNull { v ->
                        v.arg?.let { a -> toolCall.second.optString(a).takeIf { it.isNotBlank() } }
                    }.distinct()
                    val desc = describeAction(toolCall.first, toolCall.second)
                    pendingConfirm = PendingConfirm(
                        desc, targets, toolCall.first, toolCall.second, raw,
                        messages, turn, episode, userInput,
                    )
                    emit("Paused by policy gate: $desc")
                    return
                }
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

            // Duplicate-call dedupe: the same tool with identical params just
            // succeeded → tell the model it's done instead of re-firing.
            // (Observed on-device: open_url fired twice per task.)
            if (lastTool == toolCall.first && !lastToolFailed &&
                toolCall.second.toString() == lastParams) {
                messages += OpenAiClient.ChatMessage("assistant", raw)
                messages += OpenAiClient.ChatMessage("user",
                    "[RESULT: ${toolCall.first}] STATUS: success\nDATA: Already done — this exact call just succeeded. Do not repeat it.\nDECIDE: Answer the user, or call a DIFFERENT tool.")
                continue
            }

            val resultText = tools.execute(toolCall.first, toolCall.second)
            episode.observeSecrets(resultText)
            val failed = resultText.startsWith("Error:") || resultText.startsWith("Could not")
            toolSequence += Triple(toolCall.first, toolCall.second, !failed)
            if (failed) anyToolFailed = true
            val verification = if (!failed) verifyAction(toolCall.first, toolCall.second) else null
            android.util.Log.i("UltraBrain", "TOOL RESULT (${if (failed) "fail" else "ok"}): ${resultText.take(120)}${verification ?: ""}")

            // Stuck detector: same tool failed twice in a row → stop honestly
            if (failed && lastToolFailed && lastTool == toolCall.first) {
                finalText = "That didn't work — ${toolCall.first} failed twice. ${resultText.take(150)}"
                break
            }
            lastTool = toolCall.first
            lastToolFailed = failed
            lastParams = toolCall.second.toString()

            messages += OpenAiClient.ChatMessage("assistant", raw)
            messages += OpenAiClient.ChatMessage("user",
                buildFeedback(toolCall.first, resultText + (verification ?: ""), turn, maxTurns, failed))

            if (turn == maxTurns - 1) finalText = "Ran ${toolCall.first}: ${resultText.take(300)}"
        }

        if (finalText.isNotBlank()) {
            // The final answer already streamed into a visible bubble — persist
            // it rather than double-emitting. Bubbles removed for tool turns
            // never reach here.
            val streamed = ChatStore.messages.lastOrNull()
            val alreadyOnScreen = streamed != null && !streamed.fromUser && streamed.text == finalText
            android.util.Log.i("UltraBrain", "EMIT TAIL: ${finalText.length}ch alreadyOnScreen=$alreadyOnScreen")
            if (alreadyOnScreen) {
                ChatStore.persist(streamed!!)
                onAnswer?.invoke(finalText)
            } else {
                answer(finalText)
            }
        } else if (lastToolFailed) {
            // Every turn ended in a block or failure — never end silently.
            answer("I couldn't complete that — the policy gate stopped the action and I had no safe alternative. Try rephrasing, or confirm the target if I ask.")
        }
        recordMemory(userInput, toolSequence, naturalFinish && !anyToolFailed)
    }

    // ── Parsing & prompt (ported shapes) ───────────────────────────────

    /** First balanced {...} containing a "tool" key, code fences stripped. */
    private fun parseToolCall(text: String): Pair<String, JSONObject>? {        val cleaned = text.replace("```json", "").replace("```", "").trim()
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

    /** Bare tool-name fallback for the 1B model: it emits the intent name, a
     * deterministic engine shapes params from the request text. */
    private fun parseBareToolCall(output: String, request: String): Pair<String, JSONObject>? {
        val names = listOf(
            "flashlight_toggle", "wifi_toggle", "bluetooth_toggle", "do_not_disturb",
            "volume_set", "alarm_set", "note_create", "app_launch",
            "battery_status", "clipboard_read", "clipboard_write",
        )
        val found = names.firstOrNull { n -> Regex("(^|\\W)$n(\\W|$)").containsMatchIn(output.trim()) }
            ?: return null
        val u = request.lowercase()
        val params = JSONObject()
        when {
            found.endsWith("_toggle") || found == "do_not_disturb" ->
                params.put("on", !Regex("\\b(off|disable)\\b").containsMatchIn(u))
            found == "volume_set" ->
                params.put("percent", Regex("(\\d{1,3})").find(u)?.value?.toIntOrNull() ?: 50)
            found == "alarm_set" -> {
                val m = Regex("(\\d{1,2})(:(\\d{2}))?\\s*(am|pm)?").find(u) ?: return null
                var hour = m.groupValues[1].toInt()
                if (m.groupValues[4] == "pm" && hour < 12) hour += 12
                if (m.groupValues[4] == "am" && hour == 12) hour = 0
                params.put("hour", hour)
                params.put("minute", m.groupValues[3].toIntOrNull() ?: 0)
                params.put("label", "Ultra alarm")
            }
            found == "app_launch" -> {
                val m = Regex("(?:open|launch|start)\\s+(.+)$").find(u) ?: return null
                params.put("target", m.groupValues[1].trim())
            }
            found == "note_create" -> {
                val m = Regex("note(?:\\s+this)?:?\\s+(.+)$").find(u) ?: return null
                params.put("text", m.groupValues[1].trim())
            }
            found == "clipboard_write" -> {
                val m = Regex("copy\\s+(.+?)(?:\\s+to\\s+(?:my\\s+)?clipboard)?$").find(u) ?: return null
                params.put("text", m.groupValues[1].trim())
            }
            // battery_status / clipboard_read take no params
        }
        return found to params
    }

    private fun userWantsAction(input: String): Boolean =
        Regex("\\b(navigate|send|text|open|go to|take me|set|create|make|call|play|turn on|turn off|toggle|install|download|share|copy|find me|get me|show me|order|book|buy)\\b",
            RegexOption.IGNORE_CASE).containsMatchIn(input)

    /**
     * Deterministic post-action verification — no model judgment. Returns a
     * "\nVERIFIED: …"/"\nUNVERIFIED: …" suffix for known-verifiable tools,
     * null when nothing can be checked.
     */
    private suspend fun verifyAction(tool: String, params: JSONObject): String? {
        return try {
            when (tool) {
                "app_launch" -> {
                    // Launch transitions run through systemui first on this
                    // device — check twice before declaring failure.
                    val target = controller.findPackage(params.optString("target")) ?: ""
                    var active = ""
                    for (waitMs in listOf(1500L, 2500L)) {
                        kotlinx.coroutines.delay(waitMs)
                        active = controller.activePackage()
                        if (active == target) break
                    }
                    if (active.isNotBlank() && active == target) "\nVERIFIED: $active is in front"
                    else "\nUNVERIFIED: expected $target in front, found '${active.ifBlank { "nothing" }}'"
                }
                "open_url" -> {
                    var active = ""
                    for (waitMs in listOf(1500L, 2500L)) {
                        kotlinx.coroutines.delay(waitMs)
                        active = controller.activePackage()
                        if (active.contains("chrome") || active.contains("browser") || active.contains("firefox")) break
                    }
                    if (active.contains("chrome") || active.contains("browser") || active.contains("firefox"))
                        "\nVERIFIED: a browser ($active) is in front"
                    else "\nUNVERIFIED: foreground is '$active'"
                }
                "clipboard_write" -> {
                    val want = params.optString("text")
                    val got = controller.clipboardRead()
                    if (got.contains(want)) "\nVERIFIED: clipboard holds the text"
                    else "\nUNVERIFIED: clipboard reads '$got'"
                }
                else -> null
            }
        } catch (_: Exception) { null }
    }

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
5. Read screen content to gather data, then use it in the next tool call. If what you need could be further down the page — results, prices, list items, article text — use read_screen_deep, not read_text_on_screen. Never report that content is unavailable until you have tried read_screen_deep.
6. When you have enough information to answer, STOP calling tools and give a clear, complete answer.
7. If you hit a login screen, captcha, or permission dialog: STOP and ask the user to handle it.
8. NEVER send messages or make calls unless the user EXPLICITLY asks.
9. RECIPES: "save that as X" / "remember that as X" → recipe_save {name:X}. "what are my routines" → recipe_list. "forget X" → recipe_delete {name:X}. Never answer a recipe request with prose — call the tool."""
    }

    companion object {
        /** Successful calls from the most recent completed run, process-wide.
         * "save that as morning briefing" is its own request with its own empty
         * sequence, so the steps to save must come from the run before it. */
        @Volatile var lastRunSteps: List<Recipes.Step> = emptyList()

        val RECIPE_TOOLS = setOf("recipe_save", "recipe_run", "recipe_list", "recipe_delete")

        /** How much two requests must overlap to count as the same job. */
        const val MATCH_THRESHOLD = 0.5

        /** A tool needs a real track record of failing before it gets named. */
        const val MIN_FAILURES_TO_WARN = 3

        /** Words that say nothing about what a request is for. */
        val STOPWORDS = setOf(
            // filler and grammar
            "the", "and", "for", "you", "your", "can", "will", "with", "that",
            "this", "then", "please", "what", "whats", "how", "hows", "why",
            "does", "did", "was", "are", "some", "get", "got", "let", "its",
            "have", "has", "just", "now", "one", "all", "any", "out", "about",
            "from", "into", "when", "where", "which", "there", "here", "again",
            "could", "would", "should", "much", "many", "doing", "going",
            // generic request verbs — they say nothing about the subject.
            // "open chrome" and "open amazon" are different jobs; without
            // dropping "open" they look half the same.
            "open", "launch", "start", "tell", "show", "give", "find", "check",
            "look", "make", "want", "need", "know", "like", "read", "say",
        )

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
  read_text_on_screen — what is visible right now. Fast.
  read_screen_deep — scrolls the page and reads ALL of it. params: {maxScrolls?}
    Use this whenever the answer is in a LIST, FEED, ARTICLE, SEARCH RESULTS,
    PRICES, or anything below the fold. read_text_on_screen sees the header only.
  describe_screen, screenshot, notification_read

RECIPES (the user's saved routines — replay a whole sequence by name):
  recipe_run — run a saved routine. params: {name}
  recipe_save — save the PREVIOUS successful run under a name. params: {name}
  recipe_list — list saved routines
  recipe_delete — delete one. params: {name}
"""
    }
}

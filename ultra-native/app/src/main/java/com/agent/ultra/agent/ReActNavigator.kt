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

        /** How many controls an app may accumulate across all its screens. */
        private const val APP_CONTROL_LIMIT = 80
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

    /** Where the screens this navigator drives keep what has been learned about
     * them. Set by Brain, which owns the database. */
    var screenMemory: com.agent.ultra.data.ScreenMemoryDao? = null

    /** Controls known for the screen this run is working on. */
    private var known: List<ScreenControls.Control> = emptyList()

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
        if (!controller.serviceRunning) return NavResult(false, controller.serviceProblem, 0)

        // Resolve and launch the target app
        val pkg = controller.findPackage(if (appHint.isBlank()) goal else appHint)
            ?: return NavResult(false, "no app matching '$appHint'", 0)
        if (!controller.launchApp(pkg)) return NavResult(false, "could not launch $pkg", 0)
        delay(2500)

        known = loadOrLearnControls(pkg)

        var observation = observe()
        // Launching the app may already have satisfied the goal.
        if (goalSatisfied(goal, observation)) {
            return NavResult(true, "already showing the goal", 0)
        }
        // Ask for a plan before acting. A failure here is not fatal: an empty
        // plan runs the old single-goal loop, which is what happened before
        // any of this existed.
        var plan = requestPlan(goal, observation)
        var stage = 0
        var stageSteps = 0
        // Was this stage's expectation already true when the stage began?
        //
        // Measured: a plan gave stages 1 and 2 the same expectation, "New tab",
        // which the screen already showed. Both stages completed instantly
        // without the menu ever opening, and stage 3 — the one that mattered —
        // became unreachable. A checkpoint has to mark a CHANGE. A condition
        // that held before the stage started is not evidence the stage did
        // anything, so the stage falls back to being guidance.
        var stagePreSatisfied = false
        var stageBudget = NavPlan.budgetFor(MAX_ITER, plan.size)
        var replanned = false
        // The plan stops steering the run when it is abandoned, but it is kept
        // so the run can still report how far it got.
        var planActive = plan.isNotEmpty()
        if (plan.isNotEmpty()) {
            stagePreSatisfied = NavPlan.satisfied(plan[0], observation)
            android.util.Log.i("UltraNav", "PLAN ${plan.size} stages, $stageBudget steps each: " +
                plan.joinToString(" | ") { "${it.description} => ${it.expect.ifBlank { "(model decides)" }}" })
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
            val aim = (if (planActive) plan.getOrNull(stage) else null)?.let {
                "${it.description}  (part of: $goal)"
            } ?: goal
            val prompt = buildPrompt(aim, observation, history, repeatedNoOp, leftAppFor, pkg)
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
            // Log the action and its outcome. Without this a failing run gives
            // no way to tell a bad choice from a good choice executed badly,
            // and both look like "the tap did not work".
            android.util.Log.i("UltraNav", "step $iter action: $action")
            val ok = executeAction(action, observation)
            delay(900)
            observation = observe()
            val changed = observation != before

            if (goalSatisfied(goal, observation)) {
                return NavResult(true, "goal visible on screen after $iter steps", iter)
            }

            // Has this stage arrived? The engine checks the text the plan named,
            // which costs nothing. The old loop spent model turns asking itself
            // whether it had finished, and a model asked that question says yes
            // more readily than it should.
            if (planActive) {
                stageSteps++
                val here = plan[stage]
                // A stage the engine cannot check is guidance, not a gate. It
                // is done as soon as an action moves the screen — otherwise a
                // model that answered "EXPECT: none", exactly as it was asked
                // to, would leave the run stuck against a door with no handle.
                if ((!here.checkable || stagePreSatisfied) && changed) {
                    stage++
                    stageSteps = 0
                    stagePreSatisfied = plan.getOrNull(stage)
                        ?.let { NavPlan.satisfied(it, observation) } ?: false
                    android.util.Log.i("UltraNav", "stage $stage/${plan.size} passed (nothing to check) at step $iter")
                    if (stage >= plan.size) {
                        return NavResult(true, "all ${plan.size} stages done", iter)
                    }
                } else if (NavPlan.satisfied(here, observation)) {
                    stage++
                    stageSteps = 0
                    stagePreSatisfied = plan.getOrNull(stage)
                        ?.let { NavPlan.satisfied(it, observation) } ?: false
                    if (stagePreSatisfied) {
                        android.util.Log.i("UltraNav",
                            "stage ${stage + 1} expects something already on screen — treating it as guidance")
                    }
                    android.util.Log.i("UltraNav", "stage ${stage}/${plan.size} reached at step $iter")
                    history += "step $iter: reached \"${here.description}\" — now do the next stage"
                    if (stage >= plan.size) {
                        return NavResult(true, "all ${plan.size} stages done", iter)
                    }
                } else if (stageSteps >= stageBudget) {
                    // Out of room on this stage. Replan once from where we
                    // actually are, then accept that the plan was wrong and
                    // finish the run on the goal alone rather than looping.
                    if (!replanned) {
                        replanned = true
                        val fresh = requestPlan(goal, observation)
                        if (fresh.isNotEmpty()) {
                            plan = fresh
                            stage = 0
                            stageSteps = 0
                            stagePreSatisfied = fresh.firstOrNull()
                                ?.let { NavPlan.satisfied(it, observation) } ?: false
                            stageBudget = NavPlan.budgetFor(MAX_ITER - iter, fresh.size)
                            android.util.Log.i("UltraNav", "REPLAN at step $iter: ${fresh.size} stages")
                            history += "step $iter: that approach stalled, starting a new plan"
                        } else {
                            planActive = false
                        }
                    } else {
                        android.util.Log.i("UltraNav", "plan abandoned at step $iter, continuing on the goal")
                        planActive = false
                    }
                }
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

            val refusal = lastRefusal
            lastRefusal = null
            val outcome = when {
                refusal != null -> "NOT DONE: $refusal"
                changed -> "screen changed"
                ok -> "NO CHANGE - do not repeat this"
                else -> "FAILED - do not repeat this"
            }
            val drift = if (drifted)
                " — you are now in $onPkg, NOT $pkg. Use back() unless leaving was intended."
            else ""
            android.util.Log.i("UltraNav", "step $iter outcome: $outcome$drift")
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
        // Say how far it got. "Iteration budget exhausted" tells the user only
        // that time ran out, and tells the brain nothing it can act on.
        val summary = if (plan.isEmpty()) "iteration budget exhausted"
            else "iteration budget exhausted — " + NavPlan.progressSummary(plan, stage) +
                if (!planActive) " (the plan was abandoned before the end)" else ""
        return NavResult(false, summary, iter)
    }

    /**
     * The dump the current observation was built from.
     *
     * Kept because everything downstream must talk about the screen the MODEL
     * was shown, not whatever the screen looks like by the time an action
     * runs. Reading it again to resolve an index is how a stale index turns
     * into a confident tap on the wrong thing.
     */
    private var lastFlat: String = ""

    /** a11y flat nodes → indexed TAPPABLE/TYPEABLE/SCROLLABLE lists (visible-only). */
    private suspend fun observe(): String {
        val flat = controller.screenFlat()
        lastFlat = flat
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
            // Typing with no index used to tap "the first editable node on
            // screen", which is a guess that is wrong on any page with more
            // than one box. When this screen has been here before, the app's
            // own name for its input is known and is used instead.
            if (idx == null && !focusKnownInput()) focusFirstEditable()
            val ok = controller.typeInto(selector, text)
            if (!ok) return false
            delay(300)
            // Read back what actually landed before committing it.
            //
            // Measured on Chrome: "chrome://history/" was typed and the field
            // held "chrome//history/". The colon was gone, the page failed to
            // load, and nothing in the run knew anything had happened — the
            // type reported success and the agent spent the rest of its budget
            // wondering why the site would not open. Pressing enter on text
            // the field did not accept is how an agent searches for, or sends,
            // something nobody asked for.
            val landed = textInFocusedField()
            if (landed != null && !landed.contains(text, ignoreCase = true)) {
                lastRefusal = "the field holds \"$landed\", not \"$text\" — " +
                    "it did not accept that text, so try another way in"
                android.util.Log.i("UltraNav", "type mismatch: wanted \"$text\", field has \"$landed\"")
                return false
            }
            controller.imeEnter()
            return true
        }
        Regex("scroll\\((up|down)\\)", RegexOption.IGNORE_CASE).find(a)?.let { m ->
            return controller.scroll(m.groupValues[1].lowercase())
        }
        if (a.equals("back()", true)) return controller.back()
        if (a.equals("home()", true)) return controller.home()
        return false
    }

    /** Resolve an [index] from the flat list to on-screen coordinates and tap. */
    /**
     * Tap what the model chose, or say why not.
     *
     * The label is carried from the observation the model was shown, so the
     * service can tell whether that index still holds the same thing. A
     * mismatch means the screen moved between being described and being acted
     * on — an advert loading, a page settling — and the honest response is to
     * look again, not to tap whatever is there now.
     */
    private suspend fun tapNodeIndex(index: Int): Boolean {
        val label = labelForIndex(index).orEmpty()
        if (!approveTap(label, "tap_index($index)")) return false
        return when (val outcome = controller.clickByIndex(index, label)) {
            "ok" -> true
            "moved" -> {
                lastRefusal = "the screen changed before that could be tapped — look at it again"
                android.util.Log.i("UltraNav", "tap refused: [$index] no longer holds \"$label\"")
                false
            }
            "gone" -> {
                lastRefusal = "[$index] is no longer on the screen — look at it again"
                false
            }
            else -> {
                android.util.Log.i("UltraNav", "tap failed on [$index] \"$label\" ($outcome)")
                false
            }
        }
    }

    /** What the focused text field holds now, or null if none can be read. */
    private suspend fun textInFocusedField(): String? = try {
        val arr = JSONArray(controller.screenFlat())
        var found: String? = null
        for (i in 0 until arr.length()) {
            val n = arr.getJSONObject(i)
            if (!n.optBoolean("e", false)) continue
            val t = n.optString("t")
            if (t.isNotBlank()) { found = t; break }
        }
        found
    } catch (_: Exception) { null }

    /** Why the last action was refused, so the model is told rather than left
     * to guess from a bare failure. Cleared once reported. */
    private var lastRefusal: String? = null

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
    /**
     * Tap the input this screen is known to have.
     *
     * False when the screen is new, when the app names nothing, or when the
     * remembered control is not on screen right now — in every one of those
     * cases the caller falls back to looking for an editable field, which is
     * what happened before any of this existed.
     */
    private suspend fun focusKnownInput(): Boolean {
        val target = ScreenControls.find(known, "search", ScreenControls.Role.INPUT)
            ?: known.firstOrNull { it.role == ScreenControls.Role.INPUT }
            ?: return false
        return try {
            val arr = JSONArray(controller.screenFlat())
            for (i in 0 until arr.length()) {
                val n = arr.getJSONObject(i)
                if (n.optString("vid") != target.vid) continue
                val x = n.optInt("x", -1)
                val y = n.optInt("y", -1)
                if (x < 0 || y < 0) return false
                controller.tap(x, y)
                delay(500)
                android.util.Log.i("UltraNav", "typed into known control #${target.vid}")
                return true
            }
            false
        } catch (_: Exception) { false }
    }

    /**
     * The controls for the screen just launched, remembered or worked out now.
     *
     * Ids and roles only, never a label — a button's label is user content and
     * a view id is a constant from a layout file. Failing to load or store is
     * not an error: the run carries on exactly as it did before.
     */
    private suspend fun loadOrLearnControls(pkg: String): List<ScreenControls.Control> {
        val dao = screenMemory ?: return emptyList()
        return try {
            val nodes = ScreenStructure.parse(controller.screenTree())
            if (nodes.isEmpty()) return emptyList()
            val fp = ScreenSignature.of(pkg, nodes)
            if (!fp.known) return emptyList()

            // Two places to look, because an app's furniture and its content
            // are not learned at the same rate.
            //
            // A browser's fingerprint includes the ids of whatever page is
            // loaded, so every website is a different screen — which is right,
            // and which means the toolbar was being relearned on every visit
            // to every site. The address bar is the same control on all of
            // them. Controls seen anywhere in an app accumulate under an
            // app-level row and are available everywhere in it; the screen row
            // holds what is specific to that page.
            val appKey = "$pkg/*"
            val screenRow = dao.get(fp.key)
            val appRow = dao.get(appKey)

            val found = ScreenControls.of(nodes)
            val remembered = (
                ScreenControls.fromJson(screenRow?.controlsJson ?: "") +
                    ScreenControls.fromJson(appRow?.controlsJson ?: "")
                ).distinctBy { it.vid }

            if (found.isNotEmpty()) {
                dao.put(
                    (screenRow ?: newRow(fp.key, pkg, fp.confidence.name)).copy(
                        controlsJson = ScreenControls.toJson(found),
                        seenCount = (screenRow?.seenCount ?: 0) + 1,
                        lastSeen = System.currentTimeMillis(),
                    )
                )
                // The app-level set is a union: a control seen on any screen of
                // the app stays available on the others.
                val union = (found + ScreenControls.fromJson(appRow?.controlsJson ?: ""))
                    .distinctBy { it.vid }
                    .take(APP_CONTROL_LIMIT)
                dao.put(
                    (appRow ?: newRow(appKey, pkg, fp.confidence.name)).copy(
                        controlsJson = ScreenControls.toJson(union),
                        seenCount = (appRow?.seenCount ?: 0) + 1,
                        lastSeen = System.currentTimeMillis(),
                    )
                )
            }

            val all = (found + remembered).distinctBy { it.vid }
            android.util.Log.i(
                "UltraNav",
                "screen ${fp.key}: ${found.size} on screen, ${remembered.size} remembered, ${all.size} usable",
            )
            all
        } catch (e: Exception) {
            android.util.Log.w("UltraNav", "controls unavailable: ${e.message}")
            emptyList()
        }
    }

    /**
     * Ask the model for a plan.
     *
     * One call, low temperature, and every failure returns an empty list: no
     * plan simply means the old single-goal loop runs. Planning must never be
     * able to make a run worse than not planning.
     */
    private suspend fun requestPlan(goal: String, observation: String): List<NavPlan.Checkpoint> {
        return try {
            val reply = client.complete(
                listOf(OpenAiClient.ChatMessage("user", NavPlan.prompt(goal, observation))),
                maxTokens = 400,
                temperature = 0.1,
            ).getOrNull() ?: return emptyList()
            NavPlan.parse(reply)
        } catch (e: Exception) {
            android.util.Log.w("UltraNav", "planning failed, continuing without one: ${e.message}")
            emptyList()
        }
    }

    private fun newRow(key: String, pkg: String, confidence: String) =
        com.agent.ultra.data.ScreenMemoryEntity(
            screenKey = key, pkg = pkg, template = "", recordCount = 0,
            fieldsCsv = "", seenCount = 0, lastSeen = 0L, confidence = confidence,
        )

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

    /**
     * The label the model was shown for this index.
     *
     * Read from the dump the observation was built from, never a fresh one.
     * Re-reading the screen here would return whatever is at that index NOW,
     * which is exactly the value that cannot be used to detect that the screen
     * moved.
     */
    private fun labelForIndex(index: Int): String? {
        return try {
            val arr = JSONArray(lastFlat.ifBlank { "[]" })
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

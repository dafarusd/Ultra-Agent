package com.agent.ultra.agent

import com.agent.ultra.data.RecipeDao
import com.agent.ultra.data.RecipeEntity
import org.json.JSONArray
import org.json.JSONObject

/**
 * Recipes — named, replayable tool sequences.
 *
 * Task memory already learns *which* tools succeeded for a request. A recipe is
 * the user promoting one of those runs into something they can name and re-run:
 * "save that as morning briefing" → "run morning briefing".
 *
 * A recipe stores the exact calls, arguments included. That matters for the
 * policy gate: on replay the arguments no longer appear in the user's words
 * ("run morning briefing" contains no URL), so every traceability contract
 * would block. The stored steps were user-attested when the recipe was
 * created — the user watched them run and then named them — so replay mints
 * them into the episode as confirmed targets. Nothing else is granted: taint,
 * spoof, and undeclared-tool checks all still apply to the replayed calls.
 */
class Recipes(private val dao: RecipeDao) {

    data class Step(val tool: String, val params: JSONObject)

    suspend fun save(rawName: String, steps: List<Step>): String {
        val name = normalizeForName(rawName)
        if (name.isEmpty()) return "Error: a recipe needs a name"
        if (steps.isEmpty()) return "Error: nothing to save — no successful tool calls in this conversation yet"
        val arr = JSONArray()
        for (s in steps) {
            arr.put(JSONObject().put("tool", s.tool).put("params", s.params))
        }
        val existing = dao.byName(name)
        dao.upsert(
            RecipeEntity(
                name = name,
                stepsJson = arr.toString(),
                createdAt = existing?.createdAt ?: System.currentTimeMillis(),
                lastRun = existing?.lastRun ?: 0L,
                runCount = existing?.runCount ?: 0,
            )
        )
        val verb = if (existing == null) "Saved" else "Updated"
        return "$verb recipe \"$name\": ${steps.joinToString(" → ") { it.tool }}"
    }

    /**
     * Keep a routine that was learned by watching.
     *
     * Same table as a spoken recipe, so there is one place to look and one
     * "list my routines" that shows everything. The steps are UI steps rather
     * than tool calls, so the JSON is stored under a marker key: a runner can
     * tell the two apart without guessing, and an old build reading a new row
     * sees an empty tool list rather than misinterpreting it.
     */
    suspend fun saveJourney(rawName: String, routeJson: String, stepsJson: String): String {
        val name = normalizeForName(rawName)
        if (name.isEmpty()) return "Error: a routine needs a name"
        val payload = JSONObject()
            .put("journey", JSONArray(routeJson))
            .put("demonstrated", JSONArray(stepsJson))
            .toString()
        val existing = dao.byName(name)
        dao.upsert(
            RecipeEntity(
                name = name,
                stepsJson = payload,
                createdAt = existing?.createdAt ?: System.currentTimeMillis(),
                lastRun = existing?.lastRun ?: 0L,
                runCount = existing?.runCount ?: 0,
            )
        )
        return name
    }

    /** The route of a routine learned by watching, or null if it is a tool recipe. */
    suspend fun journeyOf(rawName: String): String? {
        val row = dao.byName(normalize(rawName)) ?: return null
        return try {
            val o = JSONObject(row.stepsJson)
            if (o.has("journey")) o.getJSONArray("journey").toString() else null
        } catch (_: Exception) { null }
    }

    /** The UI steps of a routine learned by watching, or null if it is a tool recipe. */
    suspend fun demonstrationOf(rawName: String): String? {
        val row = dao.byName(normalize(rawName)) ?: return null
        return try {
            val o = JSONObject(row.stepsJson)
            if (o.has("demonstrated")) o.getJSONArray("demonstrated").toString() else null
        } catch (_: Exception) { null }
    }

    suspend fun stepsOf(rawName: String): List<Step>? {
        val row = dao.byName(normalize(rawName)) ?: return null
        return parse(row.stepsJson)
    }

    /**
     * Fuzzy lookup so "run my morning briefing" finds "morning briefing".
     *
     * The most specific name wins. Taking the first match in whatever order the
     * database returned meant "run my morning sites" could resolve to an older
     * routine called "morning sites" while one called "my morning sites" sat
     * right there — and the agent then ran something the user did not ask for
     * and reported success.
     *
     * Same shape as the task-memory bug: a shorter remembered thing claiming a
     * request that merely contains it. Length is the tiebreak because a longer
     * name that still fits is carrying more of what was actually said.
     */
    suspend fun resolve(spoken: String): RecipeEntity? {
        val n = normalize(spoken)
        if (n.isEmpty()) return null
        dao.byName(n)?.let { return it }
        val all = dao.list()
        return all.filter { n.contains(it.name) }.maxByOrNull { it.name.length }
            ?: all.filter { it.name.contains(n) }.minByOrNull { it.name.length }
    }

    suspend fun markRun(name: String) {
        val row = dao.byName(name) ?: return
        dao.upsert(row.copy(lastRun = System.currentTimeMillis(), runCount = row.runCount + 1))
    }

    suspend fun list(): String {
        val all = dao.list()
        if (all.isEmpty()) return "No recipes saved yet. Run a task, then say: save that as <name>"
        return "Saved recipes:\n" + all.joinToString("\n") { r ->
            val steps = parse(r.stepsJson).joinToString(" → ") { it.tool }
            val runs = if (r.runCount > 0) " (run ${r.runCount}×)" else ""
            "• ${r.name}: $steps$runs"
        }
    }

    suspend fun delete(rawName: String): String {
        val name = normalize(rawName)
        val row = dao.byName(name) ?: return "Error: no recipe named \"$name\""
        dao.delete(row.name)
        return "Deleted recipe \"${row.name}\""
    }

    private fun parse(json: String): List<Step> = try {
        val arr = JSONArray(json)
        (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            val tool = o.optString("tool")
            if (tool.isBlank()) null
            else Step(tool, o.optJSONObject("params") ?: JSONObject())
        }
    } catch (_: Exception) { emptyList() }

    companion object {
        /** Recipe names are matched loosely — strip filler and punctuation. */
        /**
         * The form used to LOOK SOMETHING UP.
         *
         * Strips the words people put in front of a name when asking for it —
         * "run", "my", "the" — so that "run my morning briefing" finds
         * "morning briefing".
         */
        fun normalize(s: String): String = s.lowercase()
            .replace(Regex("^(run|start|do|play|execute)\\s+"), "")
            .replace(Regex("^(my|the)\\s+"), "")
            .replace(Regex("\\s+recipe$"), "")
            .replace(Regex("[^a-z0-9 ]"), "")
            .replace(Regex("\\s+"), " ")
            .trim()

        /**
         * The form a routine is STORED under.
         *
         * Deliberately different, and the difference matters. Stripping "my"
         * when naming meant "my morning sites" and "morning sites" were the
         * same routine: saving one silently replaced the other, and the agent
         * then ran something the user had not asked for. Measured on the phone
         * — a newly taught route overwrote an older routine of nearly the same
         * name without a word about it.
         *
         * A name the user chose is theirs. Only the leading command verb goes,
         * because "run the school run" is a request wrapped around a name, not
         * a name.
         */
        fun normalizeForName(s: String): String = s.lowercase()
            .replace(Regex("^(run|start|do|play|execute)\\s+"), "")
            .replace(Regex("\\s+recipe$"), "")
            .replace(Regex("[^a-z0-9 ]"), "")
            .replace(Regex("\\s+"), " ")
            .trim()
    }
}

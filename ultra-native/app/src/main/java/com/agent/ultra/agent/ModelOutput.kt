package com.agent.ultra.agent

import org.json.JSONObject

/**
 * Reading what the model actually said.
 *
 * Both parsers this replaces were written for a model that answers exactly as
 * asked. Real ones do not, and the cost of that was out of all proportion: a
 * single unparseable line ended a fifteen-step task with "model gave no
 * parseable action", after the agent had already done half the work.
 *
 * Pulled out of both callers so the parsing can be argued with in a test rather
 * than only observed failing on a phone.
 */
object ModelOutput {

    /**
     * The first complete JSON object in the text, honouring string literals.
     *
     * Brace counting that ignores quotes miscounts the moment a value contains
     * one: `{"tool":"sms_send","params":{"message":"see you at 8 {maybe}"}}`
     * closes early, the substring is invalid JSON, and the whole tool call
     * silently degrades to a plain answer. The user sees the agent say
     * something instead of doing something, with nothing explaining why.
     *
     * An escaped quote inside a string does not end it, which is the other half
     * of the same bug.
     */
    fun firstJsonObject(text: String): String? {
        val cleaned = text.replace("```json", "").replace("```", "")
        val start = cleaned.indexOf('{')
        if (start < 0) return null
        var depth = 0
        var inString = false
        var escaped = false
        for (i in start until cleaned.length) {
            val c = cleaned[i]
            when {
                escaped -> escaped = false
                c == '\\' && inString -> escaped = true
                c == '"' -> inString = !inString
                inString -> {}
                c == '{' -> depth++
                c == '}' -> { depth--; if (depth == 0) return cleaned.substring(start, i + 1) }
            }
        }
        return null
    }

    /** A tool call, or null when the reply is simply prose. */
    fun toolCall(text: String): Pair<String, JSONObject>? {
        val json = firstJsonObject(text) ?: return null
        return try {
            val obj = JSONObject(json)
            val tool = obj.optString("tool")
            if (tool.isBlank()) null
            else tool to (obj.optJSONObject("params") ?: JSONObject())
        } catch (_: Exception) { null }
    }

    /**
     * The one action in a navigator reply.
     *
     * Three things changed from the version this replaces.
     *
     * Typed text was matched with `[^)]`, so anything containing a closing
     * bracket was truncated — `type("call me :)")` typed `call me :` and the
     * rest vanished. Quoted text now runs to its own closing quote, brackets
     * and all.
     *
     * An `ACTION:` line was trusted entirely, so `ACTION: I will now tap the
     * menu` became a literal action string that no executor understood, failing
     * the step for a reason the model could not see. What follows `ACTION:` is
     * now checked against the vocabulary like anything else.
     *
     * And the search no longer stops at the first line. A model that explains
     * itself for a paragraph and then gives a perfectly good action used to
     * lose the whole run.
     */
    fun action(text: String): String? {
        // Prefer an ACTION: line, but only if what follows is really an action.
        Regex("""(?im)^\s*ACTION:\s*(.+)$""").findAll(text).forEach { m ->
            val candidate = m.groupValues[1].replace(Regex("""\s*//.*$"""), "").trim()
            matchAction(candidate)?.let { return it }
        }
        // Otherwise the first thing anywhere in the reply that IS an action.
        return matchAction(text)
    }

    /** The action vocabulary, found anywhere in a string. */
    private fun matchAction(s: String): String? {
        VERBS.forEach { re -> re.find(s)?.let { return it.value.trim() } }
        return null
    }

    /**
     * Ordered: the more specific forms are tried first, so `tap_index(3)` is
     * not read as a bare `tap(3)` with rubbish around it.
     *
     * `type` accepts either quote style and allows any character inside,
     * including the brackets that used to truncate it.
     */
    private val VERBS = listOf(
        Regex("""tap_index\(\s*\d+\s*\)""", RegexOption.IGNORE_CASE),
        Regex("""type\(\s*\d*\s*,?\s*"[^"]*"\s*\)""", RegexOption.IGNORE_CASE),
        Regex("""type\(\s*\d*\s*,?\s*'[^']*'\s*\)""", RegexOption.IGNORE_CASE),
        Regex("""tap\(\s*\d+(?:\s*,\s*\d+)?\s*\)""", RegexOption.IGNORE_CASE),
        Regex("""scroll\(\s*(?:up|down)\s*\)""", RegexOption.IGNORE_CASE),
        Regex("""back\(\)""", RegexOption.IGNORE_CASE),
        Regex("""home\(\)""", RegexOption.IGNORE_CASE),
        Regex("""\bdone\b""", RegexOption.IGNORE_CASE),
    )
}

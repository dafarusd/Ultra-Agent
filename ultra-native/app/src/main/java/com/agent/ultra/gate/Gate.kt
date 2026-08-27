package com.agent.ultra.gate

import org.json.JSONObject

/**
 * The enforcement runtime (port of gatellml lang/runtime.py).
 * The model is never trusted; the program is.
 *
 * One Episode per user request. Secrets observed in tool results accumulate
 * over the episode and may never leave via egress tools.
 */
class Gate(private val manifest: Manifest) {

    class Episode(userRequest: String) {
        val requestNorm: String = norm(userRequest)
        val secrets = mutableListOf<String>()

        /** Call after each tool result: collect secret-shaped material. */
        fun observeSecrets(toolResult: String) {
            secrets += findSecrets(toolResult)
        }
    }

    data class Violation(val rule: String, val arg: String?, val hint: String)

    data class Verdict(val allowed: Boolean, val violations: List<Violation> = emptyList()) {
        val rule: String? get() = violations.firstOrNull()?.rule
    }

    private fun mintOrigin(text: String, ep: Episode): OriginSet {
        val n = norm(text)
        return if (n.isNotEmpty() && n in ep.requestNorm) OriginSet(setOf(UserOrigin))
        else OriginSet(setOf(ToolOrigin()))
    }

    private fun bindArgs(args: JSONObject, ep: Episode): Map<String, TrackedArg> {
        val out = mutableMapOf<String, TrackedArg>()
        for (key in args.keys()) {
            val v = args.opt(key) ?: continue
            val s = v.toString()
            val tainted = ep.secrets.any { secret -> s.isNotEmpty() && s in secret }
            out[key] = TrackedArg(s, OriginSet(mintOrigin(s, ep).items, tainted))
        }
        return out
    }

    fun enforceCall(ep: Episode, function: String, args: JSONObject): Verdict {
        val spec = manifest.tool(function) ?: return Verdict(
            false, listOf(Violation("undeclared_tool", null, "tool '$function' is not in the manifest"))
        )

        val bindings = bindArgs(args, ep)
        val violations = mutableListOf<Violation>()

        // Taint-egress: secrets observed this episode may never leave
        if (Effect.EGRESS in spec.effects && ep.secrets.isNotEmpty()) {
            val blob = args.keys().asSequence().joinToString(" ") { args.opt(it)?.toString() ?: "" }
            if (ep.secrets.any { it in blob }) {
                violations += Violation("taint_egress", null,
                    "outbound arguments contain secret-shaped strings observed in tool output")
            }
        }

        for (c in spec.requires) {
            val why = c.check(bindings, ep.requestNorm)
            if (why != null) violations += Violation(c.name, c.arg, why)
        }

        return if (violations.isEmpty()) Verdict(true) else Verdict(false, violations)
    }

    companion object {
        fun renderBlock(verdict: Verdict): String {
            val detail = verdict.violations.take(2).joinToString("; ") { it.hint }
            return "BLOCKED by security policy (${verdict.rule}). This action was not explicitly " +
                "requested by the user (targets must be named in the user's original request). " +
                "Do not retry this exact action; continue with the rest of the task or ask the " +
                "user for confirmation." + (if (detail.isNotEmpty()) " Detail: $detail" else "")
        }
    }
}

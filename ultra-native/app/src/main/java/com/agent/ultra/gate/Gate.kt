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
        val observations = ObservationLog()
        /** Targets the operator explicitly confirmed this episode (the
         * resolve/confirm channel — gatellml SPEC §2 R4 made live). */
        private val confirmed = mutableSetOf<String>()

        init {
            observations.record(
                Fact(
                    tool = "<user>",
                    source = Fact.Source.USER_REQUEST,
                    confidence = Fact.Confidence.HIGH,
                    summary = userRequest.take(80),
                )
            )
        }

        /** The effective trusted text: the request plus user-confirmed targets. */
        val effectiveRequestNorm: String
            get() = if (confirmed.isEmpty()) requestNorm
            else requestNorm + " " + confirmed.joinToString(" ")

        fun confirm(target: String) {
            val n = norm(target)
            if (n.isNotEmpty()) confirmed += n
        }

        /** Call after each tool result: collect secret-shaped material. */
        fun observeSecrets(toolResult: String) {
            secrets += findSecrets(toolResult)
        }

        /** Record that a tool produced an observation with a known source. */
        fun observeTool(tool: String, resultSummary: String = "") {
            val source = Fact.sourceOf(tool) ?: return
            observations.record(tool, source, resultSummary)
        }

        /** Record that the operator confirmed an action via the gate card. */
        fun observeOperatorConfirmation(tool: String) {
            observations.record(
                Fact(
                    tool = tool,
                    source = Fact.Source.OPERATOR_CONFIRMATION,
                    confidence = Fact.Confidence.HIGH,
                    summary = "operator confirmed $tool",
                )
            )
        }
    }

    data class Violation(val rule: String, val arg: String?, val hint: String)

    data class Verdict(
        val allowed: Boolean,
        val violations: List<Violation> = emptyList(),
        /** True when every violation is traceability-class — i.e. an operator
         * confirmation could legitimately cure it. Taint, spoof, and
         * undeclared-tool violations are never confirmable. */
    ) {
        val rule: String? get() = violations.firstOrNull()?.rule
        val confirmable: Boolean
            get() = violations.isNotEmpty() && violations.all {
                it.rule in CONFIRMABLE_RULES
            }

        companion object {
            private val CONFIRMABLE_RULES = setOf(
                "recipient_traceable", "any_arg_traceable", "atom_in_request",
                "domain_in_request", "origin_subset", "low_confidence_egress",
            )
        }
    }

    /**
     * Did the user actually say this, or does it merely appear inside what they
     * said?
     *
     * The ported rule was plain substring containment, and that is trivially
     * satisfied: an argument of "on", "to", "1" or "a" is inside almost any
     * sentence, so the gate would mark it as coming from the user and let it
     * through. A check that anything short passes is not a check.
     *
     * This is the fourth time today the same shape has been found — a short
     * value claiming a longer one that merely contains it. It broke
     * "looks sensitive" (`tor` matching calcula*tor*), task memory ("battery
     * level" claiming a request about banking), and routine names ("morning
     * sites" claiming "my morning sites"). Worth stating as a rule: **never let
     * containment alone decide a match.**
     *
     * Whole words now, in order. Punctuation is trimmed from both sides before
     * comparing, so a request ending "...open news.ycombinator.com." still
     * matches the domain argument.
     *
     * This is deliberately the strict direction. Being wrong here means either
     * refusing something the user asked for, which they see and can confirm, or
     * permitting something they did not, which they never see at all.
     */
    internal fun saidByUser(value: String, requestNorm: String): Boolean {
        fun tokens(s: String) = s.split(' ')
            .map { it.trim('.', ',', ';', ':', '!', '?', '"', '\'', '(', ')') }
            .filter { it.isNotEmpty() }
        // Normalise BOTH. Taking the request pre-normalised was a footgun: any
        // caller passing raw text got silent non-matches, and a security check
        // that quietly says "no" is as wrong as one that quietly says "yes".
        // norm is idempotent, so doing it again costs nothing.
        val want = tokens(norm(value))
        val said = tokens(norm(requestNorm))
        if (want.isEmpty() || want.size > said.size) return false
        for (i in 0..(said.size - want.size)) {
            if (want.indices.all { said[i + it] == want[it] }) return true
        }
        return false
    }

    private fun mintOrigin(text: String, ep: Episode): OriginSet =
        if (saidByUser(text, ep.effectiveRequestNorm)) OriginSet(setOf(UserOrigin))
        else OriginSet(setOf(ToolOrigin()))

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

        // Low-confidence egress: if the agent gathered information but all of
        // it came from screen reads (accessibility tree), egress requires
        // operator confirmation. System API results or a prior operator
        // confirmation clear this gate.
        if (Effect.EGRESS in spec.effects && ep.observations.hasLowToolOnly()) {
            violations += Violation("low_confidence_egress", null,
                "outbound action backed only by screen reads (low confidence)")
        }

        for (c in spec.requires) {
            val why = c.check(bindings, ep.effectiveRequestNorm)
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

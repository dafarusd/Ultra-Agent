package com.agent.ultra.gate

/**
 * Origin tracking (port of gatellml lang/origins.py): every argument value
 * carries the attested sources it was derived from. v0 semantics kept exactly:
 * origins mint by substring membership against the operator's request text.
 */

private val EMAIL_RE = Regex("""[\w.+-]+@[\w-]+\.[\w.]+""")
private val URL_RE = Regex("""https?://\S+""")
private val IBAN_RE = Regex("""[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}""")

private val SECRET_PATTERNS = listOf(
    Regex("""sk-[A-Za-z0-9_\-]{16,}"""),
    Regex("""AKIA[0-9A-Z]{16}"""),
    Regex("""(?i)password\s*[:=]\s*\S+"""),
    Regex("""(?i)(api[_-]?key|token|secret)\s*[:=]\s*\S{8,}"""),
    Regex("""\b[0-9a-f]{40,}\b""", RegexOption.IGNORE_CASE),
    Regex("""\b[A-Za-z0-9+/]{40,}={0,2}\b"""),
)

fun norm(s: String): String = s.replace(Regex("""\s+"""), " ").trim().lowercase()

/** Origin markers. v0 uses two: User (verbatim in the request) and
 * ToolOrigin (everything else). RequestSpan exists for the future resolve
 * channel — see gatellml SPEC section 2 R4. */
sealed interface Origin
object UserOrigin : Origin
data class ToolOrigin(val tool: String = "<untracked>") : Origin
data class RequestSpan(val mention: String) : Origin

data class OriginSet(
    val items: Set<Origin> = emptySet(),
    val taintHit: Boolean = false,
) {
    fun union(other: OriginSet) = OriginSet(items + other.items, taintHit || other.taintHit)

    fun hasUser() = items.any { it is UserOrigin }

    /** None = admissible. Mirrors origins.py OriginSet.satisfies. */
    fun satisfies(requestNorm: String): String? {
        for (o in items) {
            when (o) {
                is UserOrigin -> continue
                is RequestSpan -> {
                    if (norm(o.mention) in requestNorm) continue
                    return "resolved entity '${o.mention}' does not trace to the user's request"
                }
                is ToolOrigin -> return "value originates from tool output, not from the user's request"
            }
        }
        return null
    }
}

fun extractAtoms(text: String): List<String> =
    (EMAIL_RE.findAll(text) + URL_RE.findAll(text) + IBAN_RE.findAll(text))
        .map { it.value }.toList()

fun findSecrets(text: String): List<String> {
    val found = mutableListOf<String>()
    for (pat in SECRET_PATTERNS) {
        for (m in pat.findAll(text)) {
            var s = m.value
            if (Regex("(?i)password|api|token|secret").containsMatchIn(s)) {
                s = s.split(Regex("[:=]"), limit = 2).last().trim()
            }
            if (s.length >= 8) found += s
        }
    }
    return found
}

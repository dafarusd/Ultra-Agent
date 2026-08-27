package com.agent.ultra.gate

import org.json.JSONObject

/**
 * Contracts (port of gatellml lang/contracts.py): the deliberately tiny,
 * decidable check fragment. Every check is O(size of argument); each returns
 * null on pass or a human-readable hint on violation.
 */

/** A bound argument: raw value plus its minted origin set. */
data class TrackedArg(val value: String, val origin: OriginSet)

interface Contract {
    /** null on pass, violation hint on failure. */
    fun check(bindings: Map<String, TrackedArg>, requestNorm: String): String?

    val name: String
    val arg: String?
}

data class OriginSubset(override val arg: String) : Contract {
    override val name = "origin_subset"
    override fun check(bindings: Map<String, TrackedArg>, requestNorm: String): String? {
        val v = bindings[arg] ?: return "missing argument '$arg'"
        return v.origin.satisfies(requestNorm)
    }
}

data class NotTainted(override val arg: String) : Contract {
    override val name = "not_tainted"
    override fun check(bindings: Map<String, TrackedArg>, requestNorm: String): String? {
        val v = bindings[arg] ?: return "missing argument '$arg'"
        if (v.origin.taintHit) return "argument '$arg' carries secret-shaped material"
        return null
    }
}

data class AtomInRequest(override val arg: String) : Contract {
    override val name = "atom_in_request"
    override fun check(bindings: Map<String, TrackedArg>, requestNorm: String): String? {
        val v = bindings[arg] ?: return "missing argument '$arg'"
        for (a in extractAtoms(v.value)) {
            if (norm(a) !in requestNorm) return "target '${a.take(40)}' does not trace to the user's request"
        }
        return null
    }
}

data class LenCheck(override val arg: String, val minimum: Int) : Contract {
    override val name = "len"
    override fun check(bindings: Map<String, TrackedArg>, requestNorm: String): String? {
        val v = bindings[arg] ?: return "missing argument '$arg'"
        if (v.value.length < minimum) return "argument '$arg' too short"
        return null
    }
}

/** Recipient-named argument: extracted atoms (or the raw value when
 * non-atom-shaped and len>=3) must trace to the request. */
data class RecipientTraceable(override val arg: String) : Contract {
    override val name = "recipient_traceable"
    override fun check(bindings: Map<String, TrackedArg>, requestNorm: String): String? {
        val v = bindings[arg] ?: return null
        val atoms = extractAtoms(v.value)
        val targets = if (atoms.isNotEmpty()) atoms
        else if (v.value.length >= 3) listOf(v.value)
        else emptyList()
        for (a in targets) {
            if (norm(a) !in requestNorm) return "target '${a.take(40)}' does not trace to the user's request"
        }
        return null
    }
}

/** Mutation rule: at least one declared argument must trace to the request.
 * Atom-level extension (same spirit as the research's display-name fix): a
 * paraphrased value also traces when an email/URL/domain token inside it
 * appears in the request. */
data class AnyArgTraceable(val args: List<String>) : Contract {
    override val name = "any_arg_traceable"
    override val arg: String? = null
    private val domainPat = Regex(
        """\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*\.(?:com|org|net|io|co|info|biz|site|online|xyz|me|us|uk|ca|de|fr|jp)\b""",
        RegexOption.IGNORE_CASE)
    override fun check(bindings: Map<String, TrackedArg>, requestNorm: String): String? {
        for (a in args) {
            val v = bindings[a] ?: continue
            if (v.origin.satisfies(requestNorm) == null) return null
            if (v.value.length >= 3 && norm(v.value) in requestNorm) return null
            // Atom/domain-level trace for model paraphrases
            val tokens = extractAtoms(v.value) + domainPat.findAll(v.value).map { stripWww(it.value) }
            if (tokens.any { norm(stripWww(it)) in requestNorm }) return null
        }
        return "no mutation target traces to the user's request"
    }
}

/** Confirmation-spoof layer (parity with the regex gate): no argument may
 * claim prior user approval. */
class SpoofCheck : Contract {
    override val name = "spoof_check"
    override val arg: String? = null
    private val pat = Regex(
        """(user\s+(has\s+)?(confirmed|approved|agreed|said\s+yes)|they\s+said\s+yes|confirmation\s*[:=]\s*(yes|true)|already\s+(confirmed|approved)|approved\s+by\s+the\s+user)""",
        RegexOption.IGNORE_CASE)
    override fun check(bindings: Map<String, TrackedArg>, requestNorm: String): String? {
        for ((k, v) in bindings) {
            if (pat.containsMatchIn(v.value)) return "argument '$k' claims prior user approval"
        }
        return null
    }
}

/** Every domain-shaped token in the argument (scheme-less included) must
 * appear in the request. Closes the scheme-less-payload gap. A leading
 * "www." is normalized away on both sides (www.google.com ≡ google.com). */
data class DomainInRequest(override val arg: String) : Contract {
    override val name = "domain_in_request"
    private val pat = Regex(
        """\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*\.(?:com|org|net|io|co|info|biz|site|online|xyz|me|us|uk|ca|de|fr|jp)\b""",
        RegexOption.IGNORE_CASE)
    override fun check(bindings: Map<String, TrackedArg>, requestNorm: String): String? {
        val v = bindings[arg] ?: return null
        for (m in pat.findAll(v.value)) {
            val dom = stripWww(m.value.lowercase())
            if (dom !in requestNorm) return "domain '${m.value}' does not trace to the user's request"
        }
        return null
    }
}

internal fun stripWww(d: String): String = d.removePrefix("www.")

fun contractsFromJson(arr: org.json.JSONArray?): List<Contract> {
    val out = mutableListOf<Contract>()
    if (arr == null) return out
    for (i in 0 until arr.length()) {
        val d: JSONObject = arr.getJSONObject(i)
        when (val kind = d.getString("kind")) {
            "origin_subset" -> out += OriginSubset(d.getString("arg"))
            "not_tainted" -> out += NotTainted(d.getString("arg"))
            "atom_in_request" -> out += AtomInRequest(d.getString("arg"))
            "recipient_traceable" -> out += RecipientTraceable(d.getString("arg"))
            "any_arg_traceable" -> {
                val argsArr = d.optJSONArray("args")
                val args = mutableListOf<String>()
                if (argsArr != null) for (j in 0 until argsArr.length()) args += argsArr.getString(j)
                out += AnyArgTraceable(args)
            }
            "domain_in_request" -> out += DomainInRequest(d.getString("arg"))
            "len" -> out += LenCheck(d.getString("arg"), d.optInt("minimum", 1))
            "spoof_check" -> out += SpoofCheck()
            else -> throw IllegalArgumentException("unknown contract kind: $kind")
        }
    }
    return out
}

package com.agent.ultra.agent

/**
 * Walking a route the user once showed us.
 *
 * A recorded route is a list of screens, not a list of taps — Android reports a
 * tap only when an app chooses to, so what was captured is where the person
 * ended up, never how. Replaying it therefore means *searching*: from the screen
 * we are on, find the control that leads to the next screen in the route.
 *
 * ## Searching means tapping things, and that is the whole problem
 *
 * A blind search is an agent pressing buttons to see what they do, on someone's
 * real phone, in a banking app they allowed it into. "Delete account" and
 * "Confirm payment" are controls like any other and a search does not know the
 * difference.
 *
 * So the ordering below is not about efficiency. It is about what may be
 * touched at all:
 *
 * - Anything whose label reads like a commitment is **never tapped by the
 *   search**. Not deferred, not confirmed — a search is guessing, and guessing
 *   is not grounds to ask someone to approve a payment. If the route genuinely
 *   ends behind such a button, the walk stops and says so.
 * - Controls the app gave a name are tried before anonymous ones, because a
 *   named control is one the developer thought of as a control.
 * - A wrong guess is undone with `back()` before the next is tried, so the
 *   search leaves the phone where it found it.
 *
 * The result is a walker that can find its way through navigation and refuses
 * to find its way through a transaction.
 */
object RouteWalker {

    /**
     * Words that stop a control being tapped speculatively.
     *
     * Wider than the per-action gate's list on purpose. That gate asks a human
     * about a tap the *model* chose for a reason; this one governs taps chosen
     * by trial and error, where there is no reason at all — so the bar for
     * "leave it alone" is lower.
     */
    private val NEVER_GUESS = listOf(
        "pay", "buy", "purchase", "order", "checkout", "send", "transfer",
        "confirm", "submit", "delete", "remove", "erase", "clear", "reset",
        "sign out", "log out", "logout", "unsubscribe", "cancel subscription",
        "book", "reserve", "accept", "agree", "allow", "grant", "install",
        "uninstall", "call", "dial", "share", "post", "publish", "withdraw",
        "deposit", "confirm and", "place order",
    )

    /**
     * Would tapping this, purely to see what happens, risk doing something?
     *
     * Matched on whole words so "payment history" is safe to open while "pay"
     * is not, and so "account settings" is not caught by "count".
     */
    fun tooRiskyToGuess(label: String): Boolean {
        val l = label.lowercase().trim()
        if (l.isEmpty()) return false
        val words = l.split(Regex("[^a-z]+")).filter { it.isNotEmpty() }
        for (phrase in NEVER_GUESS) {
            val parts = phrase.split(' ')
            if (parts.size == 1) {
                if (words.any { it == parts[0] }) return true
            } else {
                for (i in 0..(words.size - parts.size).coerceAtLeast(0)) {
                    if (i + parts.size <= words.size &&
                        parts.indices.all { words[i + it] == parts[it] }
                    ) return true
                }
            }
        }
        return false
    }

    /** A control the walker is willing to try, and why it is ranked where it is. */
    data class Candidate(val index: Int, val vid: String, val label: String)

    /**
     * What to try next on this screen, best first.
     *
     * Anything unsafe to guess at is absent rather than last: this list is the
     * set of things that may be touched, not a preference order over all of
     * them.
     */
    fun candidates(
        nodes: List<ScreenStructure.Node>,
        alreadyTried: Set<String> = emptySet(),
    ): List<Candidate> {
        val out = mutableListOf<Candidate>()
        for (n in nodes) {
            if (!n.clickable || !n.enabled) continue
            val label = n.label
            if (tooRiskyToGuess(label)) continue
            val id = n.vid.takeIf { ScreenStructure.looksLikeAName(it) }.orEmpty()
            val key = if (id.isNotBlank()) "#$id" else "@${n.index}"
            if (key in alreadyTried) continue
            out += Candidate(n.index, id, label.take(40))
        }
        // A control the app named is one its developer thought of as a control;
        // an anonymous clickable View is as likely to be a layout wrapper.
        return out.sortedByDescending { it.vid.isNotBlank() }.take(MAX_CANDIDATES)
    }

    /**
     * Candidates taken from the FLAT dump, which is what a tap indexes into.
     *
     * The first version picked candidates out of the screen *tree* and then
     * tapped by index — two different traversals of the same screen, so the
     * index meant a different node in each. Six taps went out in a third of a
     * second and none of them landed, because none of them referred to what the
     * walker thought it was pressing.
     *
     * The same class of mistake as the two flatteners disagreeing on their cap.
     * Choosing and acting must read the same list.
     */
    fun candidatesFromFlat(flatJson: String, alreadyTried: Set<String> = emptySet()): List<Candidate> {
        val out = mutableListOf<Candidate>()
        try {
            val arr = org.json.JSONArray(flatJson)
            for (i in 0 until arr.length()) {
                val n = arr.optJSONObject(i) ?: continue
                if (!n.optBoolean("c", false)) continue
                val label = n.optString("t").ifBlank { n.optString("d") }.trim()
                if (tooRiskyToGuess(label)) continue
                val idx = n.optInt("i", -1)
                if (idx < 0) continue
                val rawVid = n.optString("vid")
                val vid = if (ScreenStructure.looksLikeAName(rawVid)) rawVid else ""
                val key = if (vid.isNotBlank()) "#$vid" else "@$idx"
                if (key in alreadyTried) continue
                out += Candidate(idx, vid, label.take(40))
            }
        } catch (_: Exception) { return emptyList() }
        return out.sortedByDescending { it.vid.isNotBlank() }.take(MAX_CANDIDATES)
    }

    /** How a candidate is remembered as tried, so the search does not loop. */
    fun keyOf(c: Candidate): String = if (c.vid.isNotBlank()) "#${c.vid}" else "@${c.index}"

    /** Attempts allowed per hop before the walk gives up and says where it got to. */
    const val TRIES_PER_HOP = 6

    /** More than this on one screen and the search is thrashing, not searching. */
    private const val MAX_CANDIDATES = 12
}

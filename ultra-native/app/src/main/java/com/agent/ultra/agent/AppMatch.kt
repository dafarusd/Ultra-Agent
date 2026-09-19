package com.agent.ultra.agent

/**
 * Which installed app a spoken name means.
 *
 * The old rule was "the label contains what was said". That fails the moment a
 * person says more than the label: on the Galaxy A15 "Samsung Notes" is labelled
 * just "Notes", so "open samsung notes" found nothing and the run gave up
 * (learnrun pass A, 2026-09-19). People say the maker's name, the package's
 * words, or less than the label — all of those have to land.
 *
 * Ranked, first rule that finds anything wins:
 *  1. package name equals the query
 *  2. label equals the query
 *  3. label contains the whole query                     ("calc" → "Calculator")
 *  4. the query contains the whole label, longest first  ("samsung notes" → "Notes")
 *  5. every query word is in the label or the package    ("google maps" → "Maps", com.google.android.apps.maps)
 *
 * Rule 4 takes the longest label so "google play store" picks "Play Store", not "Play".
 * Single-letter and filler words never count.
 */
object AppMatch {

    data class App(val label: String, val pkg: String)

    private val FILLER = setOf("app", "the", "my", "application", "open")

    private fun words(s: String) = s.lowercase().split(Regex("[^a-z0-9]+")).filter { it.length > 1 && it !in FILLER }.toSet()

    fun find(query: String, apps: List<App>): String? {
        val q = query.trim().lowercase()
        if (q.isEmpty()) return null
        apps.firstOrNull { it.pkg.lowercase() == q }?.let { return it.pkg }
        apps.firstOrNull { it.label.lowercase() == q }?.let { return it.pkg }
        apps.firstOrNull { it.label.lowercase().contains(q) }?.let { return it.pkg }
        val qw = words(q)
        if (qw.isEmpty()) return null
        apps.filter { a -> words(a.label).let { lw -> lw.isNotEmpty() && qw.containsAll(lw) } }
            .maxByOrNull { it.label.length }?.let { return it.pkg }
        return apps.firstOrNull { a -> (words(a.label) + words(a.pkg)).containsAll(qw) }?.pkg
    }

    /**
     * The user's own words for the app the model named, when both mean the same installed app.
     *
     * The gate traces an app_launch target to the request word for word, so a model that says
     * "Google Play Store" for "open the play store" is refused though it would open exactly the
     * app the user named (learnrun pass A, 2026-09-19). Rather than loosen the gate, the target is
     * rewritten to the request's words — then it traces, and it still opens the same package.
     * Null when no 1–3 word span of the request resolves to the package the target resolves to.
     */
    fun canonical(request: String, target: String, apps: List<App>): String? {
        val pkg = find(target, apps) ?: return null
        val toks = request.lowercase().split(Regex("[^a-z0-9]+")).filter { it.isNotEmpty() }
        for (n in 3 downTo 1) {
            for (i in 0..toks.size - n) {
                val span = toks.subList(i, i + n)
                if (span.first() in FILLER || span.last() in FILLER) continue   // "open the play" is not a name
                val phrase = span.joinToString(" ")
                if (find(phrase, apps) == pkg) return phrase
            }
        }
        return null
    }
}

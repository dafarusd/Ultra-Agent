package com.agent.ultra.agent

import org.json.JSONArray

/**
 * Structured screen reading.
 *
 * A flat list of labels cannot say which price belongs to which product — the
 * pairing has to be inferred, and inference is where a confident wrong answer
 * comes from. The accessibility tree already knows: a results list is a
 * container whose children are each one item, and each item's labels are its
 * own descendants.
 *
 * This rebuilds that tree from the flattened dump and finds the container
 * whose children look like a repeating list of multi-field things. That
 * pattern is not specific to shopping — an inbox, a feed, a chat thread, a
 * settings list and a search results page all have it.
 */
object ScreenStructure {

    data class Node(
        val index: Int,
        val parent: Int,
        val depth: Int,
        val text: String,
        val desc: String,
        val clickable: Boolean,
        val top: Int,
        val bottom: Int,
    ) {
        val label: String get() = text.ifBlank { desc }.trim()
    }

    /** One row of a list: the labels that genuinely belong together. */
    data class Item(val labels: List<String>, val top: Int, val clickable: Boolean) {
        /** Identity across overlapping reads while scrolling. */
        val signature: String get() = labels.joinToString("|").take(240)
    }

    fun parse(flatJson: String): List<Node> = try {
        val arr = JSONArray(flatJson)
        (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            Node(
                index = o.optInt("i", i),
                parent = o.optInt("p", -1),
                depth = o.optInt("dep", 0),
                text = o.optString("t").trim(),
                desc = o.optString("d").trim(),
                clickable = o.optBoolean("c", false),
                top = o.optInt("tp", o.optInt("y", 0)),
                bottom = o.optInt("b", o.optInt("y", 0)),
            )
        }
    } catch (_: Exception) { emptyList() }

    /**
     * Find the repeating list on screen and return its rows.
     *
     * Empty when the screen has no such structure — a settings page with one
     * control per section, a dialog, an article. The caller falls back to a
     * flat read, which is the honest thing to do rather than inventing groups.
     */
    /**
     * Find the repeating list on screen and return its rows.
     *
     * The winning signal is uniformity, not size. A results grid is a
     * container whose children all carry a similar amount of content —
     * measured on a live Amazon page, the product grid's children had
     * identical label counts. Height is useless here: virtualised rows report
     * zero bounds, which is why an area-based score picked the page banner.
     *
     * The count of items is multiplied by how substantial each one is, so a
     * fourteen-entry navigation menu of two words each loses to an
     * eleven-entry product list carrying titles, ratings and prices.
     *
     * Empty when the screen has no such structure — a dialog, an article, a
     * settings page. The caller falls back to a flat read, which is honest
     * rather than inventing groups that are not there.
     */
    fun items(nodes: List<Node>, minItems: Int = 3): List<Item> {
        if (nodes.isEmpty()) return emptyList()
        val children = HashMap<Int, MutableList<Node>>()
        for (n in nodes) children.getOrPut(n.parent) { mutableListOf() }.add(n)

        val labelCount = HashMap<Int, Int>()
        fun countLabels(n: Node): Int = labelCount.getOrPut(n.index) {
            var c = if (isUseful(n.label)) 1 else 0
            for (kid in children[n.index].orEmpty()) c += countLabels(kid)
            c
        }
        for (n in nodes) countLabels(n)

        var bestScore = 0.0
        var bestKids: List<Node> = emptyList()
        for ((_, kids) in children) {
            val items = kids.filter { (labelCount[it.index] ?: 0) >= 2 }
            if (items.size < minItems) continue
            val counts = items.map { (labelCount[it.index] ?: 0).toDouble() }
            val mean = counts.average()
            if (mean <= 0) continue
            val sd = kotlin.math.sqrt(counts.sumOf { (it - mean) * (it - mean) } / counts.size)
            val uniformity = (1.0 - sd / mean).coerceIn(0.0, 1.0)
            val substance = counts.sorted()[counts.size / 2].coerceAtMost(SUBSTANCE_CAP)
            val score = items.size * uniformity * substance
            if (score > bestScore) { bestScore = score; bestKids = items }
        }
        if (bestKids.isEmpty()) return emptyList()

        fun labelsUnder(n: Node): List<String> {
            val out = mutableListOf<String>()
            fun walk(x: Node) {
                if (isUseful(x.label)) out.add(x.label.take(160))
                for (kid in children[x.index].orEmpty()) walk(kid)
            }
            walk(n)
            // Pages repeat a title across the image link, the heading and the
            // anchor; the reader only needs it once.
            return out.distinct()
        }

        return bestKids
            .sortedBy { it.top }
            .map { Item(labelsUnder(it), it.top, it.clickable || anyClickableUnder(it, children)) }
            .filter { it.labels.size >= 2 }
    }

    /** Tracking parameters and opaque ids are labels to a screen reader and
     * noise to everyone else. */
    private val JUNK = Regex("""^(ref=|https?://|[A-Za-z0-9+/=_.\-]{28,}$)""")

    private fun isUseful(label: String): Boolean =
        label.isNotBlank() && !JUNK.containsMatchIn(label)


    private fun anyClickableUnder(n: Node, children: Map<Int, MutableList<Node>>): Boolean {
        if (n.clickable) return true
        return children[n.index].orEmpty().any { anyClickableUnder(it, children) }
    }

    private const val SUBSTANCE_CAP = 40.0

    private val PRICE = Regex("""[$£€]\s?\d[\d,]*(?:\.\d{2})?""")

    /** Render rows for the brain: one numbered item, its fields beneath it. */
    fun render(items: List<Item>, budget: Int): Pair<String, Int> {
        val sb = StringBuilder()
        var used = 0
        var shown = 0
        for ((n, item) in items.withIndex()) {
            val prices = item.labels.flatMap { PRICE.findAll(it).map { m -> m.value }.toList() }.distinct()
            val head = "${n + 1}. ${item.labels.first()}"
            val rest = item.labels.drop(1).joinToString("\n") { "   $it" }
            val priceLine = if (prices.size == 1) "\n   price: ${prices.first()}" else ""
            val block = head + (if (rest.isNotBlank()) "\n$rest" else "") + priceLine + "\n"
            if (used + block.length > budget) break
            sb.append(block)
            used += block.length
            shown++
        }
        return sb.toString().trimEnd() to shown
    }
}

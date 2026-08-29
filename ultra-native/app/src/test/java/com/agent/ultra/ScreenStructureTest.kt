package com.agent.ultra

import com.agent.ultra.agent.ScreenStructure
import com.agent.ultra.agent.ScreenStructure.Item
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Field naming.
 *
 * The rule under test is not "name as much as possible". It is "never name
 * something wrong" — a named field gets trusted by the model, so a bad name
 * turns into a confident wrong answer about what something costs.
 */
class ScreenStructureTest {

    private fun row(vararg labels: String) = Item(labels.toList(), top = 0, clickable = true)

    private fun named(item: Item): Map<String?, List<String>> =
        ScreenStructure.fields(item).groupBy({ it.name }, { it.value })

    @Test
    fun `first label is the title`() {
        val f = ScreenStructure.fields(row("Sony WH-1000XM5", "$348.00"))
        assertEquals("title", f.first().name)
        assertEquals("Sony WH-1000XM5", f.first().value)
    }

    @Test
    fun `price rating and reviews are each named`() {
        val f = named(row(
            "Sony WH-1000XM5 Wireless Headphones",
            "$348.00",
            "4.4 out of 5 stars",
            "12,847 ratings",
        ))
        assertEquals(listOf("$348.00"), f["price"])
        assertEquals(listOf("4.4 out of 5 stars"), f["rating"])
        assertEquals(listOf("12,847 ratings"), f["reviews"])
    }

    @Test
    fun `points are named on a link aggregator`() {
        val f = named(row("Show HN: I built a thing", "412 points", "by someone 3 hours ago"))
        assertEquals(listOf("412 points"), f["points"])
    }

    @Test
    fun `a rating line that also carries a count is a rating, not a review count`() {
        // "4.5 out of 5 stars, 1,234 ratings" arrives as one label on several
        // real layouts. Naming it "reviews" would file the rating under the
        // wrong field.
        val f = named(row("Thing", "4.5 out of 5 stars, 1,234 ratings"))
        assertEquals(listOf("4.5 out of 5 stars, 1,234 ratings"), f["rating"])
        assertNull(f["reviews"])
    }

    @Test
    fun `text matching two unrelated patterns is left unnamed`() {
        // A price and a review count in one line is ambiguous about which the
        // line is for. Unnamed is the honest outcome.
        val f = named(row("Thing", "$19.99 · 240 reviews"))
        assertTrue("should not be named price", f["price"] == null)
        assertTrue("should not be named reviews", f["reviews"] == null)
        assertEquals(listOf("$19.99 · 240 reviews"), f[null])
    }

    @Test
    fun `unrecognised text keeps its value with no name`() {
        val f = named(row("Thing", "Delivery Tuesday", "Colour: Midnight Black"))
        assertEquals(listOf("Delivery Tuesday", "Colour: Midnight Black"), f[null])
    }

    @Test
    fun `a bare number is not a review count`() {
        val f = named(row("Thing", "1,234"))
        assertEquals(listOf("1,234"), f[null])
    }

    @Test
    fun `a number above five is not a rating`() {
        val f = named(row("Thing", "48 out of 5"))
        assertNull(f["rating"])
    }

    @Test
    fun `two prices in one row are listed and flagged, never picked`() {
        val (out, shown) = ScreenStructure.render(
            listOf(row("Kettle", "$99.99", "$79.99")),
            budget = 4000,
        )
        assertEquals(1, shown)
        assertTrue("both prices must survive", out.contains("$99.99") && out.contains("$79.99"))
        assertTrue("ambiguity must be stated", out.contains("do not assume which is charged"))
    }

    @Test
    fun `a single price is named plainly`() {
        val (out, _) = ScreenStructure.render(listOf(row("Kettle", "$79.99")), budget = 4000)
        assertTrue(out.contains("price: $79.99"))
        assertTrue("no ambiguity warning for one price", !out.contains("do not assume"))
    }

    @Test
    fun `render stops at the budget instead of truncating a row`() {
        val rows = (1..50).map { row("Item $it", "$${it}.00") }
        val (out, shown) = ScreenStructure.render(rows, budget = 120)
        assertTrue("must stop early", shown in 1..49)
        assertTrue("output stays within budget", out.length <= 120)
    }

    @Test
    fun `a sponsored badge is named, so an ad is not mistaken for the best buy`() {
        val f = named(row("Cheap Thing", "Sponsored", "$9.99"))
        assertEquals(listOf("Sponsored"), f["sponsored"])
        assertEquals(listOf("$9.99"), f["price"])
    }

    @Test
    fun `a word merely containing ad is not a sponsored badge`() {
        // "ad" as a substring hits Adapter and Radio. The badge stands alone.
        val f = named(row("Thing", "USB Adapter", "Radio"))
        assertNull(f["sponsored"])
        assertEquals(listOf("USB Adapter", "Radio"), f[null])
    }

    @Test
    fun `out of stock is named, so a price on it is not the cheapest option`() {
        val f = named(row("Thing", "$4.99", "Currently unavailable"))
        assertEquals(listOf("Currently unavailable"), f["availability"])
    }

    @Test
    fun `in stock is named too`() {
        val f = named(row("Thing", "In stock", "Arrives Tuesday"))
        assertEquals(listOf("In stock", "Arrives Tuesday"), f["availability"])
    }

    @Test
    fun `an empty row yields no fields`() {
        assertEquals(emptyList<ScreenStructure.Field>(), ScreenStructure.fields(row()))
    }
}

/**
 * Container selection.
 *
 * Picking the wrong container is the failure that produced "Unknown product"
 * and a sign-in row where a product grid should have been. The winning signal
 * is uniformity times substance, never area — virtualised rows report zero
 * bounds, so an area score picks the page banner every time.
 *
 * These build the flat tree by hand so the heuristic can be proven without a
 * phone.
 */
class ScreenContainerTest {

    /** Build the flat JSON that [ScreenStructure.parse] consumes. */
    private class Tree {
        private val rows = mutableListOf<String>()
        var next = 0; private set

        fun add(parent: Int, text: String, top: Int = 0, clickable: Boolean = false): Int {
            val i = next++
            rows.add("""{"i":$i,"p":$parent,"dep":0,"t":${quote(text)},"d":"","c":$clickable,"tp":$top,"b":${top + 10}}""")
            return i
        }

        private fun quote(s: String) = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
        fun json() = rows.joinToString(",", "[", "]")
        fun nodes() = ScreenStructure.parse(json())
    }

    @Test
    fun `a product grid beats a bigger navigation menu`() {
        val t = Tree()
        val root = t.add(-1, "")
        // 14 nav entries of one word each — more children, far less substance.
        val nav = t.add(root, "")
        repeat(14) {
            val entry = t.add(nav, "")
            t.add(entry, "Dept $it")
            t.add(entry, "›")
        }
        // 5 products, each carrying a title, a price and a rating.
        val grid = t.add(root, "")
        repeat(5) {
            val card = t.add(grid, "", top = 100 + it * 50, clickable = true)
            t.add(card, "Product $it")
            t.add(card, "$${it + 10}.99")
            t.add(card, "4.${it} out of 5 stars")
            t.add(card, "${it * 100 + 7} ratings")
        }

        val items = ScreenStructure.items(t.nodes())
        assertEquals("should pick the 5-product grid", 5, items.size)
        assertTrue(items.all { it.labels.any { l -> l.startsWith("Product ") } })
    }

    @Test
    fun `the eleven-product page still wins - the case proven on device`() {
        // This is the layout validated on a live Amazon page before the
        // scoring changed. Keeping it means a future tweak to the heuristic
        // cannot quietly undo what was proven on hardware.
        val t = Tree()
        val root = t.add(-1, "")
        val nav = t.add(root, "")
        repeat(14) {
            val entry = t.add(nav, "")
            t.add(entry, "Dept $it")
            t.add(entry, "\u203a")
        }
        val grid = t.add(root, "")
        repeat(11) {
            val card = t.add(grid, "", top = 100 + it * 50, clickable = true)
            t.add(card, "Wireless Noise Cancelling Headphones model $it")
            t.add(card, "$${it + 10}.99")
            t.add(card, "4.${it % 6} out of 5 stars")
        }
        assertEquals(11, ScreenStructure.items(t.nodes()).size)
    }

    @Test
    fun `a long list of short entries loses to a short list of substantial rows`() {
        // The general form of the bug: count is linear, so without measuring
        // how much text a row carries, any long shallow menu wins.
        val t = Tree()
        val root = t.add(-1, "")
        val menu = t.add(root, "")
        repeat(30) {
            val entry = t.add(menu, "")
            t.add(entry, "Tag$it")
            t.add(entry, "·")
        }
        val list = t.add(root, "")
        repeat(3) {
            val row = t.add(list, "", top = it * 50)
            t.add(row, "A headline that carries real content number $it")
            t.add(row, "412 points by someone 3 hours ago")
            t.add(row, "128 comments")
        }
        val items = ScreenStructure.items(t.nodes())
        assertEquals(3, items.size)
    }

    @Test
    fun `a screen with no repeating list returns nothing`() {
        val t = Tree()
        val root = t.add(-1, "")
        t.add(root, "Settings")
        val a = t.add(root, ""); t.add(a, "Wi-Fi"); t.add(a, "Connected")
        val b = t.add(root, ""); t.add(b, "About this phone")
        assertTrue(ScreenStructure.items(t.nodes()).isEmpty())
    }

    @Test
    fun `rows come back in screen order`() {
        val t = Tree()
        val root = t.add(-1, "")
        val list = t.add(root, "")
        // Added bottom-first on purpose.
        for (top in listOf(300, 100, 200)) {
            val row = t.add(list, "", top = top)
            t.add(row, "Row at $top")
            t.add(row, "detail")
        }
        val items = ScreenStructure.items(t.nodes())
        assertEquals(listOf(100, 200, 300), items.map { it.top })
    }

    @Test
    fun `a title repeated across image, heading and link appears once`() {
        val t = Tree()
        val root = t.add(-1, "")
        val list = t.add(root, "")
        repeat(3) {
            val row = t.add(list, "", top = it * 50)
            t.add(row, "Same Title $it")   // image alt
            t.add(row, "Same Title $it")   // heading
            t.add(row, "Same Title $it")   // anchor
            t.add(row, "$${it}9.99")
        }
        val items = ScreenStructure.items(t.nodes())
        assertEquals(3, items.size)
        items.forEachIndexed { i, item ->
            assertEquals("title should not repeat", 1, item.labels.count { it == "Same Title $i" })
        }
    }

    @Test
    fun `tracking parameters and opaque ids are not fields`() {
        val t = Tree()
        val root = t.add(-1, "")
        val list = t.add(root, "")
        repeat(3) {
            val row = t.add(list, "", top = it * 50)
            t.add(row, "Real Title $it")
            t.add(row, "ref=sr_pg_1_$it")
            t.add(row, "https://example.com/dp/B0${it}XYZ")
            t.add(row, "$${it}9.99")
        }
        val items = ScreenStructure.items(t.nodes())
        assertEquals(3, items.size)
        assertTrue(
            "junk must be filtered",
            items.flatMap { it.labels }.none { it.startsWith("ref=") || it.startsWith("http") },
        )
    }

    @Test
    fun `a protected screen yields no nodes`() {
        val nodes = ScreenStructure.parse(com.agent.ultra.AgentAccessibilityService.PROTECTED)
        assertTrue(nodes.isEmpty())
        assertTrue(ScreenStructure.items(nodes).isEmpty())
    }

    @Test
    fun `malformed json is empty, not a crash`() {
        assertTrue(ScreenStructure.parse("not json at all").isEmpty())
        assertTrue(ScreenStructure.parse("").isEmpty())
    }
}

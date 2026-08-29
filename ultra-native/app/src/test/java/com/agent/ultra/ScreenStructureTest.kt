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
        val f = named(row("Thing", "Delivery Tuesday", "Sponsored"))
        assertEquals(listOf("Delivery Tuesday", "Sponsored"), f[null])
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
    fun `an empty row yields no fields`() {
        assertEquals(emptyList<ScreenStructure.Field>(), ScreenStructure.fields(row()))
    }
}

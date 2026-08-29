package com.agent.ultra

import com.agent.ultra.agent.RouteWalker
import com.agent.ultra.agent.ScreenStructure
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What an agent may touch while guessing its way through an app.
 *
 * Replaying a recorded route means searching, and searching means tapping
 * things to see what they do — on someone's real phone, in an app they allowed
 * it into. "Delete account" and "Confirm payment" are controls like any other
 * and a search does not know the difference. These tests are that difference.
 */
class RouteWalkerTest {

    private fun node(
        i: Int, label: String = "", vid: String = "",
        clickable: Boolean = true, enabled: Boolean = true,
    ) = ScreenStructure.Node(
        index = i, parent = -1, depth = 1, text = label, desc = "",
        clickable = clickable, top = i * 10, bottom = i * 10 + 8,
        cls = "Button", vid = vid, editable = false, enabled = enabled,
    )

    // ── What must never be guessed at ───────────────────────────────

    @Test
    fun `anything that commits is never tapped on spec`() {
        for (label in listOf(
            "Pay", "Pay now", "Buy it now", "Place order", "Checkout",
            "Send", "Transfer", "Confirm", "Confirm and pay", "Submit",
            "Delete", "Delete account", "Remove card", "Sign out",
            "Book", "Reserve", "Accept", "Agree", "Install", "Call",
            "Share", "Post", "Withdraw",
        )) {
            assertTrue("'$label' must not be guessed at", RouteWalker.tooRiskyToGuess(label))
        }
    }

    @Test
    fun `ordinary navigation is fine to try`() {
        for (label in listOf(
            "Settings", "History", "Bookmarks", "More", "Menu", "Back",
            "Payment history", "Account settings", "Notifications", "Search",
        )) {
            assertFalse("'$label' is navigation", RouteWalker.tooRiskyToGuess(label))
        }
    }

    @Test
    fun `a risky word inside another word does not trip it`() {
        // "payment history" is a page; "pay" is a button. The difference is the
        // whole word, which is the same rule four other bugs today needed.
        assertFalse(RouteWalker.tooRiskyToGuess("Payment history"))
        assertFalse(RouteWalker.tooRiskyToGuess("Shareholder report"))
        assertFalse(RouteWalker.tooRiskyToGuess("Bookmarks"))
        assertTrue(RouteWalker.tooRiskyToGuess("Book"))
    }

    @Test
    fun `an unlabelled control is allowed, because it commits to nothing visible`() {
        assertFalse(RouteWalker.tooRiskyToGuess(""))
    }

    // ── What gets tried, and in what order ──────────────────────────

    @Test
    fun `dangerous controls are absent, not merely last`() {
        val c = RouteWalker.candidates(listOf(
            node(1, "Settings", "settings_button"),
            node(2, "Pay now", "pay_button"),
            node(3, "History", "history_button"),
        ))
        assertEquals(listOf("settings_button", "history_button"), c.map { it.vid })
    }

    @Test
    fun `a control the app named is tried before an anonymous one`() {
        val c = RouteWalker.candidates(listOf(
            node(1, "", ""),
            node(2, "Menu", "menu_button"),
        ))
        assertEquals("menu_button", c.first().vid)
    }

    @Test
    fun `things that cannot be tapped are not candidates`() {
        val c = RouteWalker.candidates(listOf(
            node(1, "Label only", clickable = false),
            node(2, "Greyed out", "disabled_btn", enabled = false),
            node(3, "Menu", "menu_button"),
        ))
        assertEquals(1, c.size)
        assertEquals("menu_button", c[0].vid)
    }

    @Test
    fun `something already tried is not tried again`() {
        val nodes = listOf(node(1, "Menu", "menu_button"), node(2, "History", "history_button"))
        val first = RouteWalker.candidates(nodes)
        val tried = setOf(RouteWalker.keyOf(first.first()))
        val second = RouteWalker.candidates(nodes, tried)
        assertFalse(second.any { RouteWalker.keyOf(it) in tried })
    }

    @Test
    fun `a crowded screen does not become an endless search`() {
        val many = (1..80).map { node(it, "Item $it", "item_$it") }
        assertTrue(RouteWalker.candidates(many).size <= 12)
    }

    @Test
    fun `content-shaped ids are treated as anonymous`() {
        // Product codes and record numbers change every visit, so remembering
        // one as "the control I tried" is remembering nothing.
        val c = RouteWalker.candidates(listOf(node(1, "Thing", "1248879011")))
        assertEquals("", c.first().vid)
        assertEquals("@1", RouteWalker.keyOf(c.first()))
    }
}

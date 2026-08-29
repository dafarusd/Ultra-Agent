package com.agent.ultra

import com.agent.ultra.agent.Demonstration
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What a demonstration is allowed to remember.
 *
 * The recording itself is trivial. The judgement about what survives it is not,
 * and it is the whole reason this feature is safe to have: a recording of the
 * path is a macro, a recording of the payload is a copy of someone's bank
 * details.
 */
class DemonstrationTest {

    private fun click(pkg: String, vid: String = "", cls: String = "android.widget.Button",
                      text: String = "", desc: String = "") =
        """{"cat":"A11Y_CLICK","t":1,"data":{"pkg":"$pkg","cls":"$cls","vid":"$vid","text":"$text","desc":"$desc"}}"""

    // ── What is kept ────────────────────────────────────────────────

    @Test
    fun `no label is stored, whatever it says`() {
        // The first design kept "control-like" labels. Its own test killed it:
        // "Sarah Miller" is short, wordlike and digit-free, and is a person.
        val steps = Demonstration.stepsFrom(listOf(
            click("com.bank", vid = "recipient", text = "Sarah Miller"),
            click("com.bank", vid = "pay_button", text = "Pay"),
        ))
        val json = Demonstration.toJson(steps)
        assertFalse("a name is not kept", json.contains("Sarah"))
        assertFalse("nor is a control word", json.contains("Pay"))
        assertTrue("the route survives", json.contains("pay_button"))
        assertTrue(json.contains("recipient"))
    }

    @Test
    fun `an id that is really content is refused`() {
        // Web content exposes product codes and record numbers as ids. They
        // change every visit and are content wearing an id's clothes.
        val steps = Demonstration.stepsFrom(listOf(
            click("com.shop", vid = "1248879011", cls = "android.view.View"),
            click("com.shop", vid = "0d6f55ac-a8a3-46bb-a6a5-f7e069fa3ff1", cls = "android.view.View"),
        ))
        assertTrue("neither id is a name", steps.all { it.vid.isEmpty() })
    }

    @Test
    fun `no captured value reaches storage`() {
        val steps = Demonstration.stepsFrom(listOf(
            click("com.bank", vid = "amount", text = "240.00"),
            click("com.bank", vid = "recipient", text = "Sarah Miller"),
            click("com.bank", vid = "pay_button", text = "Pay"),
        ))
        val json = Demonstration.toJson(steps)
        assertFalse(json.contains("240"))
        assertFalse(json.contains("Sarah"))
        assertTrue("the route survives", json.contains("pay_button"))
    }

    // ── What is dropped ─────────────────────────────────────────────

    @Test
    fun `only taps become steps`() {
        val events = listOf(
            """{"cat":"A11Y_NOTIF","t":1,"data":{"pkg":"com.msg","text":"Mum: are you coming"}}""",
            """{"cat":"A11Y_WINDOW","t":2,"data":{"pkg":"com.bank","cls":"Main"}}""",
            click("com.bank", vid = "pay_button", text = "Pay"),
        )
        val steps = Demonstration.stepsFrom(events)
        assertEquals(1, steps.size)
        assertFalse("a notification is private correspondence",
            Demonstration.toJson(steps).contains("Mum"))
    }

    @Test
    fun `the agent's own screen is not a step`() {
        val steps = Demonstration.stepsFrom(listOf(
            click("com.agent.ultra", text = "Send"),
            click("com.bank", vid = "pay_button", text = "Pay"),
        ))
        assertEquals(1, steps.size)
        assertEquals("com.bank", steps[0].pkg)
    }

    @Test
    fun `a tap it could not inspect teaches nothing`() {
        assertTrue(Demonstration.stepsFrom(listOf(
            click("com.bank", text = "[external]"))).isEmpty())
    }

    @Test
    fun `pressing a slow button four times is one step`() {
        val same = click("com.bank", vid = "pay_button", text = "Pay")
        assertEquals(1, Demonstration.stepsFrom(listOf(same, same, same, same)).size)
    }

    @Test
    fun `malformed events are skipped, not fatal`() {
        val steps = Demonstration.stepsFrom(listOf(
            "not json", "", "{}", click("com.bank", vid = "ok", text = "OK")))
        assertEquals(1, steps.size)
    }

    // ── Round trip and reporting ────────────────────────────────────

    @Test
    fun `steps survive being stored and read back`() {
        val steps = Demonstration.stepsFrom(listOf(
            click("com.bank", vid = "login", text = "Log in"),
            click("com.bank", vid = "pay_button", text = "Pay"),
        ))
        val back = Demonstration.fromJson(Demonstration.toJson(steps))
        assertEquals(steps.map { it.signature }, back.map { it.signature })
    }

    @Test
    fun `a corrupt routine reads back as nothing, not a crash`() {
        assertTrue(Demonstration.fromJson("not json").isEmpty())
        assertTrue(Demonstration.fromJson("").isEmpty())
    }

    @Test
    fun `a demonstration of nothing is not worth a name`() {
        assertFalse(Demonstration.worthKeeping(emptyList()))
        assertFalse(Demonstration.worthKeeping(
            Demonstration.stepsFrom(listOf(click("com.bank", vid = "login_button")))))
        assertTrue(Demonstration.worthKeeping(Demonstration.stepsFrom(listOf(
            click("com.bank", vid = "login_button"),
            click("com.bank", vid = "pay_button"),
        ))))
    }

    @Test
    fun `it can say back what it learned`() {
        val steps = Demonstration.stepsFrom(listOf(
            click("com.bank", vid = "login", text = "Log in"),
            click("com.bank", vid = "pay_button", text = "Pay"),
        ))
        val text = Demonstration.describe(steps)
        assertTrue("it names the controls by the app's own ids", text.contains("login"))
        assertTrue(text.contains("pay_button"))
        assertTrue(text.contains("com.bank"))
    }
}

package com.agent.ultra

import com.agent.ultra.agent.ScreenJourney
import com.agent.ultra.agent.ScreenJourney.Waypoint
import com.agent.ultra.agent.ScreenStructure
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Remembering a route by the screens it passes through.
 *
 * This exists because watching for taps does not work: Android reports a click
 * only when an app chooses to, and taps inside web content are never reported
 * at all. Screens can always be read.
 */
class ScreenJourneyTest {

    private fun wp(pkg: String, d: String) = Waypoint(pkg, d, "IDS")

    private fun tree(name: String) = ScreenStructure.parse(
        javaClass.getResourceAsStream("/$name.json")!!.bufferedReader().readText()
    )

    // ── Building a route ────────────────────────────────────────────

    @Test
    fun `arriving somewhere new extends the route`() {
        var r = emptyList<Waypoint>()
        r = ScreenJourney.append(r, wp("com.chrome", "aaa"))
        r = ScreenJourney.append(r, wp("com.chrome", "bbb"))
        assertEquals(2, r.size)
    }

    @Test
    fun `sitting on one screen does not repeat it`() {
        // A sampler looks many times while a person reads. Arriving once is one
        // waypoint.
        var r = emptyList<Waypoint>()
        repeat(20) { r = ScreenJourney.append(r, wp("com.chrome", "aaa")) }
        assertEquals(1, r.size)
    }

    @Test
    fun `going back somewhere is a real step and is kept`() {
        var r = emptyList<Waypoint>()
        r = ScreenJourney.append(r, wp("com.chrome", "aaa"))
        r = ScreenJourney.append(r, wp("com.chrome", "bbb"))
        r = ScreenJourney.append(r, wp("com.chrome", "aaa"))
        assertEquals("returning is part of the route", 3, r.size)
    }

    @Test
    fun `a screen that cannot be identified is not a waypoint`() {
        var r = emptyList<Waypoint>()
        r = ScreenJourney.append(r, null)
        r = ScreenJourney.append(r, Waypoint("", "aaa", "IDS"))
        r = ScreenJourney.append(r, Waypoint("com.chrome", "", "IDS"))
        assertTrue(r.isEmpty())
    }

    @Test
    fun `a wander is capped rather than recorded forever`() {
        var r = emptyList<Waypoint>()
        for (i in 1..200) r = ScreenJourney.append(r, wp("com.chrome", "s$i"))
        assertTrue("a route is a task, not a day", r.size <= 24)
    }

    @Test
    fun `one screen is where the phone was, not a journey`() {
        assertFalse(ScreenJourney.worthKeeping(listOf(wp("com.chrome", "aaa"))))
        assertFalse(ScreenJourney.worthKeeping(emptyList()))
        assertTrue(ScreenJourney.worthKeeping(listOf(wp("a", "1"), wp("a", "2"))))
    }

    // ── Reading a real screen ───────────────────────────────────────

    @Test
    fun `a real captured screen becomes a waypoint`() {
        val w = ScreenJourney.waypointOf("com.sec.android.app.clockpackage", tree("native-clock"))
        assertNotNull(w)
        assertEquals("com.sec.android.app.clockpackage", w!!.pkg)
        assertTrue(w.digest.isNotBlank())
    }

    @Test
    fun `two different screens are different waypoints`() {
        val clock = ScreenJourney.waypointOf("pkg", tree("native-clock"))!!
        val settings = ScreenJourney.waypointOf("pkg", tree("native-settings"))!!
        assertTrue(clock.key != settings.key)
    }

    @Test
    fun `an empty screen is not a waypoint`() {
        assertNull(ScreenJourney.waypointOf("com.chrome", emptyList()))
        assertNull(ScreenJourney.waypointOf("", tree("native-clock")))
    }

    // ── Certainty about arrival ─────────────────────────────────────

    @Test
    fun `arrival is recognised without asking anyone`() {
        // The whole point: a plan's checkpoint stops being text the model hoped
        // to see and becomes a fact the engine can check.
        val nodes = tree("native-clock")
        val target = ScreenJourney.waypointOf("com.clock", nodes)!!
        assertTrue(ScreenJourney.arrivedAt(target, "com.clock", nodes))
    }

    @Test
    fun `a different screen is not arrival`() {
        val target = ScreenJourney.waypointOf("com.clock", tree("native-clock"))!!
        assertFalse(ScreenJourney.arrivedAt(target, "com.clock", tree("native-settings")))
    }

    @Test
    fun `the same screen in a different app is not arrival`() {
        val target = ScreenJourney.waypointOf("com.one", tree("native-clock"))!!
        assertFalse(ScreenJourney.arrivedAt(target, "com.two", tree("native-clock")))
    }

    // ── Storage ─────────────────────────────────────────────────────

    @Test
    fun `a route survives being stored and read back`() {
        val r = listOf(wp("com.chrome", "aaa"), wp("com.chrome", "bbb"))
        assertEquals(r.map { it.key }, ScreenJourney.fromJson(ScreenJourney.toJson(r)).map { it.key })
    }

    @Test
    fun `a corrupt route reads back as nothing, not a crash`() {
        assertTrue(ScreenJourney.fromJson("not json").isEmpty())
        assertTrue(ScreenJourney.fromJson("").isEmpty())
    }

    @Test
    fun `no screen text is stored`() {
        // A fingerprint is a hash of which view ids and widget kinds a screen is
        // built from. Nothing that was ON the screen may survive into it.
        val json = ScreenJourney.toJson(
            listOf(ScreenJourney.waypointOf("com.clock", tree("native-clock"))!!))
        for (onScreen in listOf("Morning Alarm", "8:15", "Wake Up")) {
            assertFalse("'$onScreen' was on that screen", json.contains(onScreen))
        }
    }

    @Test
    fun `it describes a route in words rather than hashes`() {
        val text = ScreenJourney.describe(listOf(wp("com.chrome", "aaa"), wp("com.bank", "bbb")))
        assertTrue(text.contains("2 screens"))
        assertTrue(text.contains("com.chrome"))
        assertFalse("a hash means nothing to a person", text.contains("aaa"))
    }
}

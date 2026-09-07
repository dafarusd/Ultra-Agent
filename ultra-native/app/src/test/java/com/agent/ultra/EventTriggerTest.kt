package com.agent.ultra

import com.agent.ultra.agent.EventTrigger
import com.agent.ultra.agent.EventTrigger.Action
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class EventTriggerTest {

    @Before
    fun reset() {
        val field = EventTrigger::class.java.getDeclaredField("triggers")
        field.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        (field.get(null) as MutableList<*>).clear()
    }

    private fun triggerCount(): Int {
        val field = EventTrigger::class.java.getDeclaredField("triggers")
        field.isAccessible = true
        return (field.get(null) as List<*>).size
    }

    private fun ctx(): android.content.Context = android.content.ContextWrapper(null)

    @Test
    fun `no triggers returns empty`() {
        val actions = EventTrigger.evaluate(ctx(), "com.test.app", "Title", "Body text")
        assertTrue(actions.isEmpty())
    }

    @Test
    fun `custom trigger fires`() {
        EventTrigger.register(object : EventTrigger.Trigger {
            override val name = "test_trigger"
            override fun evaluate(
                context: android.content.Context,
                pkg: String, title: String, text: String,
            ): Action? =
                if (text.contains("fire")) Action(Action.Type.TOAST, "Fired!")
                else null
        })
        val actions = EventTrigger.evaluate(ctx(), "com.test", "", "please fire now")
        assertEquals(1, actions.size)
        assertEquals(Action.Type.TOAST, actions[0].type)
        assertEquals("Fired!", actions[0].label)
    }

    @Test
    fun `custom trigger skips when no match`() {
        EventTrigger.register(object : EventTrigger.Trigger {
            override val name = "test_trigger"
            override fun evaluate(
                context: android.content.Context,
                pkg: String, title: String, text: String,
            ): Action? = null
        })
        val actions = EventTrigger.evaluate(ctx(), "com.test", "", "nothing here")
        assertTrue(actions.isEmpty())
    }

    @Test
    fun `multiple triggers can fire`() {
        EventTrigger.register(object : EventTrigger.Trigger {
            override val name = "a"
            override fun evaluate(
                context: android.content.Context,
                pkg: String, title: String, text: String,
            ) = Action(Action.Type.TOAST, "A")
        })
        EventTrigger.register(object : EventTrigger.Trigger {
            override val name = "b"
            override fun evaluate(
                context: android.content.Context,
                pkg: String, title: String, text: String,
            ) = Action(Action.Type.CLIPBOARD_COPY, "B", "data")
        })
        val actions = EventTrigger.evaluate(ctx(), "com.test", "", "")
        assertEquals(2, actions.size)
        assertEquals("A", actions[0].label)
        assertEquals("B", actions[1].label)
        assertEquals("data", actions[1].data)
    }

    @Test
    fun `failing trigger does not break others`() {
        EventTrigger.register(object : EventTrigger.Trigger {
            override val name = "boom"
            override fun evaluate(
                context: android.content.Context,
                pkg: String, title: String, text: String,
            ): Action = throw RuntimeException("kaboom")
        })
        EventTrigger.register(object : EventTrigger.Trigger {
            override val name = "ok"
            override fun evaluate(
                context: android.content.Context,
                pkg: String, title: String, text: String,
            ) = Action(Action.Type.TOAST, "survived")
        })
        val actions = EventTrigger.evaluate(ctx(), "com.test", "", "")
        assertEquals(1, actions.size)
        assertEquals("survived", actions[0].label)
    }

    @Test
    fun `registerDefaults adds sms trigger once`() {
        EventTrigger.registerDefaults()
        EventTrigger.registerDefaults()
        assertEquals(1, triggerCount())
    }

    @Test
    fun `action data defaults to empty`() {
        val a = Action(Action.Type.TOAST, "hello")
        assertEquals("", a.data)
    }
}

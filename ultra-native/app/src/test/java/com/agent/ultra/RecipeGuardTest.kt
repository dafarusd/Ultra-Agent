package com.agent.ultra

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What may become a saved routine.
 *
 * Both rules here come from the store polluting itself during a real test
 * session, not from imagining what might go wrong.
 */
class RecipeGuardTest {

    private val META = setOf(
        "watch_me", "stop_watching", "cancel_watching",
        "recipe_save", "recipe_run", "recipe_list", "recipe_delete",
    )

    private fun realSteps(tools: List<String>) = tools.filterNot { it in META }

    @Test
    fun `a routine made only of managing routines is nothing`() {
        // The store came out of a session holding two entries whose only step
        // was "start watching". Running one starts a recording, reports
        // success, and does nothing anyone wanted.
        assertTrue(realSteps(listOf("watch_me")).isEmpty())
        assertTrue(realSteps(listOf("watch_me", "stop_watching")).isEmpty())
        assertTrue(realSteps(listOf("recipe_list", "recipe_save")).isEmpty())
    }

    @Test
    fun `real work survives alongside the managing`() {
        assertEquals(
            listOf("open_url", "read_screen_deep"),
            realSteps(listOf("watch_me", "open_url", "read_screen_deep", "recipe_save")),
        )
    }

    @Test
    fun `an ordinary routine is untouched`() {
        val tools = listOf("app_launch", "react_navigate", "notification_read")
        assertEquals(tools, realSteps(tools))
    }
}

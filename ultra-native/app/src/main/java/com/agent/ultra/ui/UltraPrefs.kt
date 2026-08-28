package com.agent.ultra.ui

import android.content.Context

/** App-level preferences that are not provider credentials. */
object UltraPrefs {
    private const val PREFS = "ultra_settings"
    private const val K_SPEAK = "speak_answers"

    /** Speak answers aloud in the chat screen. The voice session always
     * speaks — that is the point of it — so this covers typed use only. */
    fun speakAnswers(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getBoolean(K_SPEAK, false)

    fun setSpeakAnswers(context: Context, on: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putBoolean(K_SPEAK, on).apply()
    }
}

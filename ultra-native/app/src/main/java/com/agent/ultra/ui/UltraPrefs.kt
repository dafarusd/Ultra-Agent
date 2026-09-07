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

    private const val K_NOTIF = "capture_notifications"
    private const val K_PERSONAL = "allow_personal_data"

    /**
     * Whether the agent may touch messages, contacts and location.
     *
     * Off by default. These tools reach Android's own providers directly, so
     * the app-access list does not cover them — that list gates what the
     * accessibility service can see on screen, and reading the SMS database
     * never goes near a screen. On a phone that takes real calls and texts,
     * the default has to be no.
     */
    fun allowPersonalData(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getBoolean(K_PERSONAL, false)

    fun setAllowPersonalData(context: Context, on: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putBoolean(K_PERSONAL, on).apply()
    }

    /** Whether the notification listener keeps a rolling log on disk. Off by
     * default: it runs whether or not a task is active, so it is collection
     * rather than perception, and it catches message previews and one-time
     * codes. notification_read simply returns nothing when this is off. */
    fun captureNotifications(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getBoolean(K_NOTIF, false)

    fun setCaptureNotifications(context: Context, on: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putBoolean(K_NOTIF, on).apply()
    }

    fun setSpeakAnswers(context: Context, on: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putBoolean(K_SPEAK, on).apply()
    }

    private const val K_SMS_CODE = "auto_extract_sms_code"

    /** Auto-copy verification codes from incoming SMS to the clipboard. Off
     *  by default: this reads message content as it arrives, which is
     *  standing collection. Requires the notification listener. */
    fun autoExtractSmsCode(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getBoolean(K_SMS_CODE, false)

    fun setAutoExtractSmsCode(context: Context, on: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putBoolean(K_SMS_CODE, on).apply()
    }
}

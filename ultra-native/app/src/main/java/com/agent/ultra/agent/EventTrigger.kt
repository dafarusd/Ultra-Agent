package com.agent.ultra.agent

import android.content.Context
import android.util.Log

/**
 * Deterministic event triggers — reactions to phone events that don't need
 * the LLM. Each trigger is a pure function: event in, action out (or null
 * to skip). No brain, no cloud, no latency.
 *
 * The notification listener calls [evaluate] on every incoming notification.
 * Triggers that need preferences check them themselves.
 */
object EventTrigger {

    private const val TAG = "UltraTrigger"

    data class Action(
        val type: Type,
        val label: String,
        val data: String = "",
    ) {
        enum class Type { CLIPBOARD_COPY, TOAST }
    }

    interface Trigger {
        val name: String
        fun evaluate(context: Context, pkg: String, title: String, text: String): Action?
    }

    private val triggers = mutableListOf<Trigger>()

    fun register(trigger: Trigger) {
        triggers += trigger
        Log.i(TAG, "registered: ${trigger.name}")
    }

    fun evaluate(context: Context, pkg: String, title: String, text: String): List<Action> {
        val actions = mutableListOf<Action>()
        for (t in triggers) {
            try {
                val a = t.evaluate(context, pkg, title, text) ?: continue
                actions += a
                Log.i(TAG, "${t.name} fired: ${a.type} ${a.label}")
            } catch (e: Exception) {
                Log.w(TAG, "${t.name} failed: ${e.message}")
            }
        }
        return actions
    }

    /** Built-in: SMS verification code → clipboard. */
    object SmsCodeTrigger : Trigger {
        override val name = "sms_code"

        private val SMS_PACKAGES = setOf(
            "com.google.android.apps.messaging",
            "com.samsung.android.messaging",
            "com.android.mms",
        )

        override fun evaluate(context: Context, pkg: String, title: String, text: String): Action? {
            if (!com.agent.ultra.ui.UltraPrefs.autoExtractSmsCode(context)) return null
            if (pkg !in SMS_PACKAGES && !pkg.contains("messaging") && !pkg.contains("sms")) return null
            val code = SmsCodeDetector.extract(text) ?: return null
            return Action(Action.Type.CLIPBOARD_COPY, "Code $code copied", code)
        }
    }

    fun registerDefaults() {
        if (triggers.isEmpty()) register(SmsCodeTrigger)
    }
}

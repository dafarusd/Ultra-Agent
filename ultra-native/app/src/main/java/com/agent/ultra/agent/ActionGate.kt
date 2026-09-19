package com.agent.ultra.agent

import android.os.Looper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * The per-action gate for UI navigation.
 *
 * The policy gate checks that react_navigate's *goal* traces to what the user
 * asked for. It has nothing to say about the taps that follow: approving
 * "book me a table" approved every tap inside the app, including one labelled
 * "Confirm and pay". This closes that.
 *
 * The rule is deliberately narrow. Reading, scrolling, going back and tapping
 * ordinary controls carry on untouched — a gate that interrupts constantly
 * gets approved reflexively, which is worse than no gate. Only a tap whose
 * target reads like a commitment stops and asks.
 */
object ActionGate {

    data class Pending(
        val action: String,
        val label: String,
        val app: String,
        val reason: String,
    )

    var pending by mutableStateOf<Pending?>(null)
        private set

    private var waiter: CompletableDeferred<Boolean>? = null
    private val ui = CoroutineScope(Dispatchers.Main.immediate)

    private fun onUi(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else ui.launch { block() }
    }

    /**
     * Ask the operator. Returns false if they decline or never answer —
     * an unanswered prompt must never become an approval.
     */
    suspend fun approve(action: String, label: String, app: String, reason: String): Boolean {
        val d = CompletableDeferred<Boolean>()
        waiter = d
        onUi { pending = Pending(action, label, app, reason) }
        android.util.Log.i(TAG, "PAUSED: $action on \"$label\" in $app (matched \"$reason\")")
        // The navigator drives another app, so Ultra is in the background when
        // this fires. A card nobody can see is a gate that silently denies
        // everything after two minutes — bring the question to the front.
        bringUltraForward()
        val ok = withTimeoutOrNull(TIMEOUT_MS) { d.await() } ?: false
        onUi { pending = null }
        waiter = null
        android.util.Log.i(TAG, "RESOLVED: ${if (ok) "approved" else "denied"} — \"$label\"")
        return ok
    }

    fun resolve(approved: Boolean) {
        waiter?.complete(approved)
    }

    /** Deny anything outstanding — used when a run is abandoned. */
    fun cancelOutstanding() {
        waiter?.complete(false)
        onUi { pending = null }
    }

    /**
     * Does this control commit something? Returns the matched word, or null.
     *
     * Matching is positional, not just "contains": a button is imperative
     * ("Place your order", "Buy now", "Send"), whereas a navigation item that
     * happens to share the word is not ("Your Orders", "Order history"). A
     * false positive costs one tap of yours; a false negative costs money.
     */
    fun commitmentIn(rawLabel: String): String? {
        val label = rawLabel.trim().lowercase().replace(Regex("[^a-z0-9 &]"), " ")
            .replace(Regex("\\s+"), " ").trim()
        if (label.isBlank()) return null
        if (NAVIGATION.any { label == it }) return null
        for (word in COMMIT_WORDS) {
            if (label == word) return word
            if (label.startsWith("$word ")) return word
            if (label.contains(" $word ") && label.split(" ").size <= 5) return word
            if (label.endsWith(" $word") && label.split(" ").size <= 4) return word
        }
        return null
    }

    private fun bringUltraForward() {
        try {
            val ctx = com.agent.ultra.UltraApplication.instance
            ctx.startActivity(
                android.content.Intent(ctx, com.agent.ultra.MainActivity::class.java)
                    .addFlags(
                        android.content.Intent.FLAG_ACTIVITY_NEW_TASK or
                            android.content.Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                    )
            )
        } catch (e: Exception) {
            android.util.Log.w(TAG, "could not surface the confirmation", e)
        }
    }

    private const val TAG = "UltraActionGate"
    private const val TIMEOUT_MS = 120_000L

    /** Words that mean something happens that is hard to take back. */
    private val COMMIT_WORDS = listOf(
        "pay", "purchase", "buy", "checkout", "order", "reorder",
        "confirm", "submit", "send", "post", "publish",
        "transfer", "withdraw", "deposit", "subscribe", "renew",
        "delete", "remove", "cancel subscription", "unsubscribe",
        "authorize", "authorise", "agree", "accept",
        "book", "reserve", "donate", "tip", "bid",
        "install", "uninstall",
        // Irreversible for the phone itself. The navigator's planner proposed "Restart the
        // phone" for "open the weather app" and "open samsung notes" (learnrun, 2026-09-19).
        "restart", "reboot", "power off", "shut down", "reset", "factory reset",
        "erase", "sign out", "log out", "allow",
        // Deliberately absent: "sign" and "apply". "Sign in" and "Apply
        // filters" appear constantly, and a gate that fires on ordinary
        // navigation gets approved reflexively, which is worse than no gate.
        // Signing a document and applying for credit are real commitments;
        // they are rare enough on a phone to accept the gap knowingly.
    )

    /** Labels that share a word with the list above but only navigate. */
    private val NAVIGATION = listOf(
        "your orders", "my orders", "orders", "order history", "order status",
        "track order", "returns & orders", "returns and orders",
        "sent", "sent messages", "subscriptions", "my subscriptions",
        "deleted", "deleted items", "trash", "bin", "purchases", "my purchases",
        "buy again", "payments", "payment methods", "confirmations",
        // Cookie banners are on every site. Consent to tracking is a real
        // decision, but not the class this gate protects — money, messages
        // and deletion — and its frequency would train the operator to tap
        // through without reading.
        "accept all", "accept cookies", "accept all cookies",
        "accept necessary", "accept and continue",
    )
}

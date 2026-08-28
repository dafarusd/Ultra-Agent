package com.agent.ultra.ui

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import com.agent.ultra.AgentAccessibilityService

/**
 * Apps the agent must never read or touch.
 *
 * The accessibility service already had a blocklist; nothing ever put anything
 * in it. This is the list, and the reason it matters: an accessibility service
 * can read whatever is on screen, and whatever it reads is sent to the cloud
 * model as a tool result. "Don't act in my bank" is not enough — "don't look"
 * is the actual requirement.
 */
object ProtectedApps {

    /**
     * Package-name fragments that suggest an app holds money, identity, or
     * credentials. Used only to pre-tick the list on first run — a guess the
     * user can see and change, never a silent decision.
     */
    private val SENSITIVE_HINTS = listOf(
        "bank", "chase", "wellsfargo", "citi", "capitalone", "usaa", "hsbc",
        "barclays", "lloyds", "santander", "revolut", "monzo", "n26",
        "paypal", "venmo", "cashapp", "zelle", "wise",
        "wallet", "spay", "gpay", "googlepay", "applepay",
        "coinbase", "binance", "kraken", "crypto", "metamask",
        "authenticator", "lastpass", "1password", "bitwarden", "dashlane",
        "keepass", "authy", "duo",
        "健康", "health", "myfitnesspal",
        "irs", "turbotax", "hrblock",
    )

    fun blocked(context: Context): Set<String> =
        context.getSharedPreferences(AgentAccessibilityService.BLOCK_PREFS, Context.MODE_PRIVATE)
            .getStringSet(AgentAccessibilityService.BLOCK_KEY, emptySet()) ?: emptySet()

    fun setBlocked(context: Context, packages: Set<String>) {
        context.getSharedPreferences(AgentAccessibilityService.BLOCK_PREFS, Context.MODE_PRIVATE)
            .edit()
            // A fresh set: SharedPreferences hands back the same mutable
            // instance it stored, and editing that in place does not persist.
            .putStringSet(AgentAccessibilityService.BLOCK_KEY, HashSet(packages))
            .apply()
        AgentAccessibilityService.loadBlockedPackages(context)
    }

    fun toggle(context: Context, pkg: String, on: Boolean) {
        val next = blocked(context).toMutableSet()
        if (on) next += pkg else next -= pkg
        setBlocked(context, next)
    }

    data class Entry(val pkg: String, val label: String, val protected: Boolean, val suggested: Boolean)

    /** Launchable third-party apps, protected ones first. */
    fun installed(context: Context): List<Entry> {
        val pm = context.packageManager
        val blocked = blocked(context)
        return pm.getInstalledApplications(0)
            .asSequence()
            .filter { pm.getLaunchIntentForPackage(it.packageName) != null }
            .filter { it.packageName != context.packageName }
            .map { info: ApplicationInfo ->
                Entry(
                    pkg = info.packageName,
                    label = runCatching { pm.getApplicationLabel(info).toString() }
                        .getOrDefault(info.packageName),
                    protected = info.packageName in blocked,
                    suggested = looksSensitive(info.packageName),
                )
            }
            .sortedWith(compareByDescending<Entry> { it.protected }
                .thenByDescending { it.suggested }
                .thenBy { it.label.lowercase() })
            .toList()
    }

    fun looksSensitive(pkg: String): Boolean {
        val p = pkg.lowercase()
        return SENSITIVE_HINTS.any { p.contains(it) }
    }

    /**
     * On first run, pre-tick the apps that look sensitive. Returns true when
     * it wrote something, so the UI can say what it did rather than leaving
     * the user to discover it.
     */
    fun seedIfUnset(context: Context): Boolean {
        val prefs = context.getSharedPreferences(
            AgentAccessibilityService.BLOCK_PREFS, Context.MODE_PRIVATE
        )
        if (prefs.contains("seeded")) return false
        val pm = context.packageManager
        val guesses = pm.getInstalledApplications(0)
            .filter { pm.getLaunchIntentForPackage(it.packageName) != null }
            .map { it.packageName }
            .filter { looksSensitive(it) }
            .toSet()
        prefs.edit().putBoolean("seeded", true).apply()
        if (guesses.isNotEmpty()) setBlocked(context, blocked(context) + guesses)
        AgentAccessibilityService.loadBlockedPackages(context)
        return guesses.isNotEmpty()
    }
}

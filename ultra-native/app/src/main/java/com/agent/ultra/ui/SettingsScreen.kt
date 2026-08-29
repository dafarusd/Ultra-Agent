package com.agent.ultra.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.agent.ultra.local.LocalModelEngine
import com.agent.ultra.provider.ProviderConfig
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun SettingsScreen(
    localEngine: LocalModelEngine,
    onConfigSaved: () -> Unit,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    // Without this the system back button leaves the app entirely instead of
    // returning to the conversation.
    BackHandler { onBack() }

    var cfg by remember { mutableStateOf(ProviderConfig.load(context)) }
    var baseUrl by remember { mutableStateOf(cfg.baseUrl) }
    var apiKey by remember { mutableStateOf(cfg.apiKey) }
    var model by remember { mutableStateOf(cfg.model) }
    var savedFlash by remember { mutableStateOf(false) }

    var downloading by remember { mutableStateOf(false) }
    var progress by remember { mutableFloatStateOf(0f) }
    var downloadError by remember { mutableStateOf<String?>(null) }

    androidx.compose.material3.Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
    ) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .systemBarsPadding()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton(onClick = onBack) { Text("← Back") }
            Text(
                "Settings",
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.padding(start = 16.dp),
            )
        }

        // ── Cloud provider ────────────────────────────────────────────
        SectionTitle("AI PROVIDER (CLOUD)")
        Text(
            "Drives the tool loop when the network is up. Any OpenAI-compatible endpoint works.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
        )
        OutlinedTextField(
            value = baseUrl, onValueChange = { baseUrl = it },
            label = { Text("Base URL") }, singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = apiKey, onValueChange = { apiKey = it },
            label = { Text("API key") }, singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = model, onValueChange = { model = it },
            label = { Text("Model") }, singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Row(
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Button(onClick = {
                cfg = ProviderConfig(baseUrl.trim(), apiKey.trim(), model.trim())
                ProviderConfig.save(context, cfg)
                onConfigSaved()
                savedFlash = true
            }) { Text("Save") }
            Text(
                when {
                    savedFlash -> "Saved."
                    cfg.isUsable -> "Configured."
                    else -> "No API key — offline mode only."
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
            )
        }

        // ── On-device model ───────────────────────────────────────────
        SectionTitle("ON-DEVICE MODEL")
        Text(
            "A small model that runs entirely on this phone — the offline brain. " +
                "It answers simple device commands without touching the network, takes over " +
                "when the cloud is unreachable, and runs anything you prefix with /local.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
        )

        // Status refreshes while the screen is open — loading happens lazily on
        // first use, so a fixed snapshot would say "not loaded" forever.
        var statusTick by remember { mutableIntStateOf(0) }
        LaunchedEffect(Unit) {
            while (true) { statusTick++; kotlinx.coroutines.delay(1500) }
        }
        val onDisk = remember(statusTick, downloading) { localEngine.downloadedFileNames() }
        val liveStatus = remember(statusTick, downloading) {
            when {
                localEngine.loaded ->
                    "In memory and ready (${localEngine.modelFileSizeBytes / 1_048_576} MB)"
                localEngine.modelPresent ->
                    "Downloaded (${localEngine.modelFileSizeBytes / 1_048_576} MB) — loads on first use"
                else -> "Not downloaded"
            }
        }
        Text(localEngine.modelLabel, style = MaterialTheme.typography.bodyMedium)
        Text(
            liveStatus,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
        )
        Text(
            "\"Loads on first use\" is normal. The weights stay on disk until something " +
                "needs them, then take a few seconds to map into memory and stay there " +
                "until the app closes.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
        )

        if (downloading) {
            LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth())
            Text("Downloading… ${(progress * 100).toInt()}%", style = MaterialTheme.typography.bodySmall)
        }
        downloadError?.let {
            Text("Download failed: $it", color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall)
        }

        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            if (!localEngine.modelPresent && !downloading) {
                Button(onClick = {
                    downloading = true; downloadError = null; progress = 0f
                    scope.launch {
                        localEngine.downloadModel { p ->
                            // Hop to the main thread: Compose snapshot state is
                            // not thread-safe and this fires from OkHttp's IO
                            // thread throughout the download.
                            scope.launch(kotlinx.coroutines.Dispatchers.Main) { progress = p }
                        }.onFailure { downloadError = it.message }
                        downloading = false
                    }
                }) { Text("Download") }
            }
            if (localEngine.loaded) {
                OutlinedButton(onClick = { localEngine.unload() }) { Text("Free memory") }
            }
        }

        // Model chooser
        var showModels by remember { mutableStateOf(false) }
        var customUrl by remember { mutableStateOf("") }
        TextButton(onClick = { showModels = !showModels }) {
            Text(if (showModels) "Hide models" else "Change model")
        }
        if (showModels) {
            val totalRam = remember { LocalModelEngine.totalRamBytes(context) }
            Text(
                "This phone has ${totalRam / (1024 * 1024)} MB of memory. Each model below is " +
                    "marked for how it sits here. Downloading one does not delete the one you " +
                    "have — switching back is instant, and only one is ever in memory.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
            )
            for (m in LocalModelEngine.PRESETS) {
                val here = m.fileName in onDisk
                val current = m.fileName == localEngine.modelFileName
                val fit = LocalModelEngine.fitFor(m, totalRam)
                val fitLabel = when (fit) {
                    com.agent.ultra.local.Fit.COMFORTABLE -> "fits comfortably"
                    com.agent.ultra.local.Fit.TIGHT -> "tight — will run, may slow under load"
                    com.agent.ultra.local.Fit.TOO_BIG -> "too big for this phone"
                }
                val fitColor = when (fit) {
                    com.agent.ultra.local.Fit.COMFORTABLE -> MaterialTheme.colorScheme.primary
                    com.agent.ultra.local.Fit.TIGHT -> MaterialTheme.colorScheme.onSurface.copy(alpha = 0.75f)
                    com.agent.ultra.local.Fit.TOO_BIG -> MaterialTheme.colorScheme.error
                }
                Column(modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                    Text(
                        m.label + if (current) "  ← in use" else "",
                        style = MaterialTheme.typography.bodyMedium,
                        color = if (current) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.onSurface,
                    )
                    Text(
                        "${m.approxMb} MB  ·  $fitLabel",
                        style = MaterialTheme.typography.bodySmall,
                        color = fitColor,
                    )
                    Text(
                        "${if (here) "on this phone" else "not downloaded"}\n${m.note}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (!current) {
                            OutlinedButton(
                                enabled = !downloading && fit != com.agent.ultra.local.Fit.TOO_BIG,
                                onClick = {
                                localEngine.selectModel(m)
                                if (!localEngine.modelPresent) {
                                    downloading = true; downloadError = null; progress = 0f
                                    scope.launch {
                                        localEngine.downloadModel { p ->
                                            scope.launch(kotlinx.coroutines.Dispatchers.Main) { progress = p }
                                        }.onFailure { downloadError = it.message }
                                        downloading = false
                                    }
                                }
                                statusTick++
                            }) { Text(if (here) "Use this" else "Download & use") }
                        }
                        if (here && !current) {
                            TextButton(onClick = {
                                java.io.File(context.filesDir, "models/" + m.fileName).delete()
                                statusTick++
                            }) { Text("Delete file") }
                        }
                    }
                }
            }
            OutlinedTextField(
                value = customUrl,
                onValueChange = { customUrl = it },
                label = { Text("Or paste a GGUF download URL") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Button(
                enabled = customUrl.isNotBlank() && !downloading,
                onClick = {
                    val url = customUrl.trim()
                    val name = url.substringAfterLast('/').substringBefore('?')
                        .ifBlank { "custom-model.gguf" }
                    localEngine.selectModel(
                        com.agent.ultra.local.ModelChoice(
                            label = name.removeSuffix(".gguf"),
                            url = url,
                            fileName = name,
                            approxMb = 0,
                            note = "Custom",
                        )
                    )
                    downloading = true; downloadError = null; progress = 0f
                    scope.launch {
                        localEngine.downloadModel { p ->
                            scope.launch(kotlinx.coroutines.Dispatchers.Main) { progress = p }
                        }.onFailure { downloadError = it.message }
                        downloading = false
                        customUrl = ""
                    }
                },
            ) { Text("Download custom model") }
            Text(
                "It must be a GGUF file this build's llama.cpp can read, and it has to fit " +
                    "in memory alongside everything else. Anything past about 2 GB will " +
                    "refuse to load on this phone.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
            )
        }

        // ── Recipes ───────────────────────────────────────────────────
        SectionTitle("ROUTINES")
        val recipeDao = remember { com.agent.ultra.data.UltraDatabase.get(context).recipes() }
        var recipeList by remember {
            mutableStateOf<List<com.agent.ultra.data.RecipeEntity>>(emptyList())
        }
        LaunchedEffect(Unit) { recipeList = recipeDao.list() }
        if (recipeList.isEmpty()) {
            Text(
                "None yet. Run a task, then say \"save that as morning briefing\" — " +
                    "after that, \"run my morning briefing\" replays the whole thing.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
            )
        } else {
            for (r in recipeList) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(r.name, style = MaterialTheme.typography.bodyMedium)
                        Text(
                            steps(r.stepsJson) +
                                if (r.runCount > 0) "  ·  run ${r.runCount}×" else "",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                        )
                    }
                    OutlinedButton(onClick = {
                        scope.launch {
                            recipeDao.delete(r.name)
                            recipeList = recipeDao.list()
                        }
                    }) { Text("Delete") }
                }
            }
        }

        // ── App access ────────────────────────────────────────────────
        SectionTitle("WHERE THE AGENT MAY GO")
        var allowMode by remember { mutableStateOf(ProtectedApps.allowlistMode(context)) }
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Only apps I choose", style = MaterialTheme.typography.bodyMedium)
                Text(
                    "Recommended. The agent can read and act only in apps you tick below; " +
                        "everything else is invisible to it. The alternative is a block list, " +
                        "which means naming every risky app in advance — on a phone with " +
                        "hundreds of apps that is a bet you lose once.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                )
            }
            Switch(checked = allowMode, onCheckedChange = {
                allowMode = it
                ProtectedApps.setAllowlistMode(context, it)
            })
        }
        Text(
            "Blocking matters both ways: whatever the agent reads on screen is sent to the " +
                "cloud model to decide what to do next, so \"don't look\" is as important " +
                "as \"don't act\".",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
            modifier = Modifier.padding(top = 6.dp),
        )

        var appQuery by remember { mutableStateOf("") }
        var showApps by remember { mutableStateOf(false) }
        var appList by remember { mutableStateOf<List<ProtectedApps.Entry>>(emptyList()) }
        LaunchedEffect(showApps, allowMode) {
            if (showApps) {
                appList = withContext(kotlinx.coroutines.Dispatchers.IO) { ProtectedApps.installed(context) }
            }
        }
        Text(
            if (!showApps) "Tap below to choose."
            else if (allowMode) "${appList.count { it.allowed }} apps allowed of ${appList.size} installed."
            else "${appList.count { it.protected }} apps protected of ${appList.size} installed.",
            style = MaterialTheme.typography.bodyMedium,
        )
        TextButton(onClick = { showApps = !showApps }) {
            Text(if (showApps) "Hide app list" else if (allowMode) "Choose allowed apps" else "Choose protected apps")
        }
        if (showApps) {
            OutlinedTextField(
                value = appQuery,
                onValueChange = { appQuery = it },
                label = { Text("Search apps") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            val shown = appList.filter {
                appQuery.isBlank() || it.label.contains(appQuery, true) || it.pkg.contains(appQuery, true)
            }.take(60)
            for (app in shown) {
                val on = if (allowMode) app.allowed else app.protected
                Row(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(app.label, style = MaterialTheme.typography.bodyMedium)
                        Text(
                            app.pkg + if (app.suggested) "  ·  looks sensitive" else "",
                            style = MaterialTheme.typography.bodySmall,
                            color = if (app.suggested) MaterialTheme.colorScheme.error
                            else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
                        )
                    }
                    Switch(checked = on, onCheckedChange = { checked ->
                        if (allowMode) {
                            ProtectedApps.toggleAllowed(context, app.pkg, checked)
                            appList = appList.map { if (it.pkg == app.pkg) it.copy(allowed = checked) else it }
                        } else {
                            ProtectedApps.toggle(context, app.pkg, checked)
                            appList = appList.map { if (it.pkg == app.pkg) it.copy(protected = checked) else it }
                        }
                    })
                }
            }
            if (shown.size < appList.size) {
                Text(
                    "Showing ${shown.size} of ${appList.size}. Search to narrow.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
                )
            }
        }

        SectionTitle("PERSONAL DATA")
        var personal by remember { mutableStateOf(UltraPrefs.allowPersonalData(context)) }
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Messages, contacts and location", style = MaterialTheme.typography.bodyMedium)
                Text(
                    "Off by default. These read Android's own databases rather than the " +
                        "screen, so the app list above does not cover them. With this off, " +
                        "the agent cannot read your texts, look up a contact, send an SMS, " +
                        "or fetch your location — it is told so and carries on.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                )
            }
            Switch(checked = personal, onCheckedChange = {
                personal = it
                UltraPrefs.setAllowPersonalData(context, it)
            })
        }

        var capture by remember { mutableStateOf(UltraPrefs.captureNotifications(context)) }
        Row(
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Keep a notification log", style = MaterialTheme.typography.bodyMedium)
                Text(
                    "Off by default. When on, notification titles and previews are written " +
                        "to a file on this phone whether or not you asked for anything — " +
                        "including message previews and one-time codes. Protected apps are " +
                        "never logged.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                )
            }
            Switch(checked = capture, onCheckedChange = {
                capture = it
                UltraPrefs.setCaptureNotifications(context, it)
            })
        }
        OutlinedButton(onClick = {
            scope.launch {
                withContext(kotlinx.coroutines.Dispatchers.IO) {
                    java.io.File(context.filesDir, "notifications.log").delete()
                }
            }
        }) { Text("Delete notification log") }

        // ── Voice ─────────────────────────────────────────────────────
        SectionTitle("VOICE")
        var speak by remember { mutableStateOf(UltraPrefs.speakAnswers(context)) }
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Speak answers aloud", style = MaterialTheme.typography.bodyMedium)
                Text(
                    "Reads replies out with the phone's own voice. Hands-free sessions always speak.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                )
            }
            Switch(checked = speak, onCheckedChange = {
                speak = it
                UltraPrefs.setSpeakAnswers(context, it)
            })
        }
        Text(
            "Hands-free: set Ultra as your digital assistant, then hold the power button " +
                "(or use your phone's assist gesture) to talk without opening the app.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
            modifier = Modifier.padding(top = 8.dp),
        )
        OutlinedButton(onClick = {
            val tries = listOf(
                android.provider.Settings.ACTION_VOICE_INPUT_SETTINGS,
                android.provider.Settings.ACTION_APPLICATION_SETTINGS,
            )
            for (action in tries) {
                try {
                    context.startActivity(
                        android.content.Intent(action)
                            .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                    )
                    break
                } catch (_: Exception) { /* try the next one */ }
            }
        }) { Text("Choose assistant app") }

        // ── About ─────────────────────────────────────────────────────
        SectionTitle("ABOUT")
        val version = remember {
            try {
                context.packageManager.getPackageInfo(context.packageName, 0).versionName
            } catch (_: Exception) { "unknown" }
        }
        // Read from the manifest the gate actually enforces. A literal here
        // went stale twice (24 -> 30 -> 31): adding a tool never reminded
        // anyone to come back and edit this line.
        val toolCount = remember { com.agent.ultra.gate.Manifest.fromAssets(context).size }
        Text(
            "Agent Ultra $version\n" +
                "Policy gate: " + (if (toolCount > 0) "active (gatellml manifest, $toolCount tools declared)"
                    else "MANIFEST UNREADABLE - every tool will be refused") + "\n" +
                "Accessibility: " + if (com.agent.ultra.AgentAccessibilityService.isRunning()) "connected" else "not connected",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
        )
    }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(top = 8.dp),
    )
}

/** Tool names out of a recipe's stored step list, for display. */
private fun steps(json: String): String = try {
    val arr = org.json.JSONArray(json)
    (0 until arr.length()).joinToString(" → ") { arr.getJSONObject(it).optString("tool") }
} catch (_: Exception) { "—" }

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
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
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

    var modelStatus by remember {
        mutableStateOf(
            if (localEngine.modelPresent)
                "Present (${localEngine.modelFileSizeBytes / 1_048_576} MB)" +
                    if (localEngine.loaded) " — loaded" else " — not loaded"
            else "Not downloaded"
        )
    }
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
            "Gemma 3 1B runs fully on this phone — the offline brain. " +
                "Used automatically when the cloud is unreachable, or with /local in chat.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
        )
        Text(modelStatus, style = MaterialTheme.typography.bodyMedium)
        if (downloading) {
            LinearProgressIndicator(
                progress = { progress },
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                "Downloading… ${(progress * 100).toInt()}%",
                style = MaterialTheme.typography.bodySmall,
            )
        }
        downloadError?.let {
            Text("Download failed: $it", color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            if (!localEngine.modelPresent && !downloading) {
                Button(onClick = {
                    downloading = true
                    downloadError = null
                    progress = 0f
                    scope.launch {
                        localEngine.downloadModel { progress = it }
                            .onSuccess {
                                modelStatus = "Present (${it / 1_048_576} MB) — not loaded"
                            }
                            .onFailure { downloadError = it.message }
                        downloading = false
                    }
                }) { Text("Download (806 MB)") }
            }
            if (localEngine.loaded) {
                OutlinedButton(onClick = {
                    localEngine.unload()
                    modelStatus = "Present (${localEngine.modelFileSizeBytes / 1_048_576} MB) — not loaded"
                }) { Text("Unload from memory") }
            }
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
        Text(
            "Agent Ultra $version\n" +
                "Policy gate: active (gatellml manifest, 30 tools declared)\n" +
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

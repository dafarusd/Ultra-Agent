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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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

        // ── About ─────────────────────────────────────────────────────
        SectionTitle("ABOUT")
        val version = remember {
            try {
                context.packageManager.getPackageInfo(context.packageName, 0).versionName
            } catch (_: Exception) { "unknown" }
        }
        Text(
            "Agent Ultra $version\n" +
                "Policy gate: active (gatellml manifest, 24 tools declared)\n" +
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

package com.agent.ultra

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.agent.ultra.local.LocalModelEngine
import com.agent.ultra.ui.ChatScreen
import com.agent.ultra.ui.SettingsScreen
import com.agent.ultra.ui.theme.AgentUltraTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            AgentUltraTheme {
                var screen by remember { mutableStateOf("chat") }
                // Shared engine — one JNI handle, never two 800MB loads.
                val engine = remember { LocalModelEngine(applicationContext) }
                // Bump on provider save so the brain rebuilds with the new config.
                var configVersion by remember { mutableIntStateOf(0) }
                when (screen) {
                    "chat" -> ChatScreen(
                        localEngine = engine,
                        configVersion = configVersion,
                        onOpenSettings = { screen = "settings" },
                    )
                    "settings" -> SettingsScreen(
                        localEngine = engine,
                        onConfigSaved = { configVersion++ },
                        onBack = { screen = "chat" },
                    )
                }
            }
        }
    }
}

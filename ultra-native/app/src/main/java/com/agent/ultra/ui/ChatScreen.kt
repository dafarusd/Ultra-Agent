package com.agent.ultra.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.agent.ultra.AgentAccessibilityService
import com.agent.ultra.agent.Brain
import com.agent.ultra.local.LocalModelEngine
import kotlinx.coroutines.launch

data class ChatMessage(val fromUser: Boolean, val text: String)

/** Process-wide chat state for the M1 shell. The brain wires in at M2. */
object ChatStore {
    val messages = mutableStateListOf<ChatMessage>()
}

@Composable
fun ChatScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val brain = remember { Brain(context.applicationContext) }
    val localEngine = remember { LocalModelEngine(context.applicationContext) }
    var input by remember { mutableStateOf("") }
    var thinking by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()
    var a11yRunning by remember { mutableStateOf(AgentAccessibilityService.isRunning()) }

    LaunchedEffect(Unit) {
        while (true) {
            a11yRunning = AgentAccessibilityService.isRunning()
            kotlinx.coroutines.delay(3000)
        }
    }

    LaunchedEffect(ChatStore.messages.size) {
        if (ChatStore.messages.isNotEmpty()) listState.animateScrollToItem(ChatStore.messages.size - 1)
    }

    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .systemBarsPadding()
            .imePadding(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "Agent Ultra",
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.weight(1f),
            )
            Text(
                text = when {
                    thinking -> "agent: thinking…"
                    a11yRunning -> "agent: ready"
                    else -> "agent: a11y off"
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
            )
        }

        LazyColumn(
            state = listState,
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .padding(horizontal = 12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(ChatStore.messages) { msg ->
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = if (msg.fromUser) Arrangement.End else Arrangement.Start,
                ) {
                    Surface(
                        color = if (msg.fromUser) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.surfaceVariant,
                        shape = RoundedCornerShape(14.dp),
                    ) {
                        Text(
                            text = msg.text,
                            color = if (msg.fromUser) MaterialTheme.colorScheme.onPrimary
                            else MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                        )
                    }
                }
            }
        }

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            OutlinedTextField(
                value = input,
                onValueChange = { input = it },
                placeholder = { Text("Ask Agent Ultra…") },
                modifier = Modifier.weight(1f),
                maxLines = 4,
            )
            Button(
                enabled = !thinking,
                onClick = {
                    val text = input.trim()
                    if (text.isEmpty()) return@Button
                    ChatStore.messages.add(ChatMessage(fromUser = true, text = text))
                    input = ""
                    thinking = true
                    scope.launch {
                        try {
                            if (text.startsWith("/local ")) {
                                // Dev path: raw on-device generation (M4 spike proof)
                                val prompt = text.removePrefix("/local ").trim()
                                val bubble = ChatMessage(false, "")
                                ChatStore.messages.add(bubble)
                                val idx = ChatStore.messages.size - 1
                                val r = localEngine.generate(prompt, 300) { piece ->
                                    ChatStore.messages[idx] =
                                        ChatMessage(false, ChatStore.messages[idx].text + piece)
                                }
                                r.onFailure {
                                    ChatStore.messages[idx] = ChatMessage(false, "Error: ${it.message}")
                                }
                            } else {
                                brain.run(text)
                            }
                        } catch (e: Exception) {
                            ChatStore.messages.add(
                                ChatMessage(false, "Error: brain fault — ${e.message}")
                            )
                        } finally {
                            thinking = false
                        }
                    }
                },
            ) {
                Text("Send")
            }
        }
    }
    }
}

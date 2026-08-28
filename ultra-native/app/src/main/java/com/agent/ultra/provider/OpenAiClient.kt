package com.agent.ultra.provider

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Minimal OpenAI-compatible chat client. One method: send a message list, get
 * the assistant's text back. Matches the contract the brain was proven against
 * (Venice llama-3.3-70b, /chat/completions, no streaming).
 */
class OpenAiClient(private val config: ProviderConfig) {

    val modelName: String get() = config.model

    private val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    data class ChatMessage(val role: String, val content: String)

    suspend fun complete(
        messages: List<ChatMessage>,
        maxTokens: Int,
        temperature: Double,
    ): Result<String> = withContext(Dispatchers.IO) {
        try {
            val msgs = JSONArray()
            for (m in messages) {
                msgs.put(JSONObject().put("role", m.role).put("content", m.content))
            }
            val bodyJson = JSONObject()
                .put("model", config.model)
                .put("messages", msgs)
                .put("max_tokens", maxTokens)
                .put("temperature", temperature)
                .put("stream", false)

            val req = Request.Builder()
                .url(config.baseUrl.trimEnd('/') + "/chat/completions")
                .addHeader("Authorization", "Bearer ${config.apiKey}")
                .addHeader("Content-Type", "application/json")
                .post(bodyJson.toString().toRequestBody("application/json".toMediaType()))
                .build()

            http.newCall(req).execute().use { resp ->
                val body = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) {
                    return@withContext Result.failure(
                        Exception("HTTP ${resp.code}: ${body.take(300)}")
                    )
                }
                val text = JSONObject(body)
                    .getJSONArray("choices")
                    .getJSONObject(0)
                    .getJSONObject("message")
                    .optString("content", "")
                if (text.isBlank()) Result.failure(Exception("empty model response"))
                else Result.success(text)
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /**
     * Streaming variant: SSE deltas delivered via onToken, full text returned.
     * Falls back to a clean failure if the endpoint can't stream.
     */
    suspend fun completeStreaming(
        messages: List<ChatMessage>,
        maxTokens: Int,
        temperature: Double,
        onToken: (String) -> Unit,
    ): Result<String> = withContext(Dispatchers.IO) {
        try {
            val msgs = JSONArray()
            for (m in messages) {
                msgs.put(JSONObject().put("role", m.role).put("content", m.content))
            }
            val bodyJson = JSONObject()
                .put("model", config.model)
                .put("messages", msgs)
                .put("max_tokens", maxTokens)
                .put("temperature", temperature)
                .put("stream", true)

            val req = Request.Builder()
                .url(config.baseUrl.trimEnd('/') + "/chat/completions")
                .addHeader("Authorization", "Bearer ${config.apiKey}")
                .addHeader("Content-Type", "application/json")
                .post(bodyJson.toString().toRequestBody("application/json".toMediaType()))
                .build()

            http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) {
                    val body = resp.body?.string().orEmpty()
                    return@withContext Result.failure(Exception("HTTP ${resp.code}: ${body.take(300)}"))
                }
                val full = StringBuilder()
                resp.body!!.source().use { source ->
                    while (!source.exhausted()) {
                        val line = source.readUtf8Line() ?: break
                        if (!line.startsWith("data:")) continue
                        val data = line.removePrefix("data:").trim()
                        if (data == "[DONE]") break
                        try {
                            val delta = JSONObject(data)
                                .getJSONArray("choices")
                                .getJSONObject(0)
                                .optJSONObject("delta")
                                ?.optString("content", "") ?: ""
                            if (delta.isNotEmpty()) {
                                full.append(delta)
                                onToken(delta)
                            }
                        } catch (_: Exception) { /* non-JSON SSE line skipped */ }
                    }
                }
                if (full.isBlank()) Result.failure(Exception("empty stream"))
                else Result.success(full.toString())
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }
}

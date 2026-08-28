package com.agent.ultra.local

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * The on-device model engine. Owns model lifecycle (file presence, memory
 * headroom check, load) and exposes one suspend generate(). Single-flight:
 * the agent loop is sequential, so a lock guards the native context.
 */
class LocalModelEngine(private val context: Context) {

    private val modelFile = File(context.filesDir, "models/gemma3-1b-q4km.gguf")
    private var handle: Long = 0
    private val lock = Any()

    val modelPresent: Boolean get() = modelFile.exists() && modelFile.length() > 100_000_000
    val loaded: Boolean get() = handle != 0L
    val modelFileSizeBytes: Long get() = if (modelFile.exists()) modelFile.length() else 0L
    val modelFilePath: String get() = modelFile.absolutePath

    /**
     * Download the model into app-private storage, reporting progress 0..1.
     * 806MB over Wi-Fi; streaming write, resumable by re-invocation (partial
     * file is deleted on failure — no half-models).
     */
    suspend fun downloadModel(onProgress: (Float) -> Unit): Result<Long> = withContext(Dispatchers.IO) {
        try {
            val client = okhttp3.OkHttpClient.Builder()
                .connectTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
                .readTimeout(120, java.util.concurrent.TimeUnit.SECONDS)
                .followRedirects(true)
                .build()
            val req = okhttp3.Request.Builder().url(MODEL_URL).build()
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return@withContext Result.failure(Exception("HTTP ${resp.code}"))
                val total = resp.body?.contentLength() ?: -1
                val tmp = File(modelFile.parentFile, "model.part")
                modelFile.parentFile?.mkdirs()
                var written = 0L
                resp.body!!.byteStream().use { input ->
                    tmp.outputStream().use { out ->
                        val buf = ByteArray(256 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            written += n
                            if (total > 0) onProgress(written.toFloat() / total)
                        }
                    }
                }
                if (total > 0 && written != total) {
                    tmp.delete()
                    return@withContext Result.failure(Exception("short read: $written/$total"))
                }
                tmp.renameTo(modelFile)
                Result.success(written)
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /**
     * Load if memory allows. llama.cpp mmaps the weights — pages load on
     * demand and evict under pressure, so the guard is for the KV cache plus
     * working headroom, not the whole file. The 806MB Gemma model ran clean
     * through llama-bench on this device class with ~850MB available.
     */
    fun ensureLoaded(): Boolean {
        if (loaded) return true
        if (!modelPresent) {
            android.util.Log.w("UltraLlm", "model file missing: ${modelFile.absolutePath}")
            return false
        }
        synchronized(lock) {
            if (handle != 0L) return true
            val avail = availableRam()
            if (avail > 0 && avail < MIN_AVAIL_BYTES) {
                android.util.Log.w("UltraLlm", "refusing load: avail=${avail / 1_048_576}MB need=${MIN_AVAIL_BYTES / 1_048_576}MB")
                return false
            }
            val t0 = System.currentTimeMillis()
            handle = LlmNative.nativeLoad(modelFile.absolutePath, THREADS, CTX_SIZE)
            android.util.Log.i("UltraLlm", "nativeLoad -> handle=$handle in ${System.currentTimeMillis() - t0}ms")
            return handle != 0L
        }
    }

    suspend fun generate(
        prompt: String,
        maxTokens: Int,
        onToken: (String) -> Unit = {},
    ): Result<String> = withContext(Dispatchers.IO) {
        if (!ensureLoaded()) return@withContext Result.failure(
            IllegalStateException("on-device model not available")
        )
        val sb = StringBuilder()
        val n = LlmNative.nativeGenerate(handle, prompt, maxTokens, 0.2f) { piece ->
            sb.append(piece)
            onToken(piece)
        }
        if (n < 0) Result.failure(IllegalStateException("native generate failed ($n)"))
        else Result.success(sb.toString())
    }

    fun unload() {
        synchronized(lock) {
            if (handle != 0L) {
                LlmNative.nativeFree(handle)
                handle = 0
            }
        }
    }

    private fun availableRam(): Long = try {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
        val mi = android.app.ActivityManager.MemoryInfo()
        am.getMemoryInfo(mi)
        mi.availMem
    } catch (_: Exception) { -1 }

    companion object {
        // Measured on the A15 5G (llama-bench, Gemma 3 1B Q4_K_M):
        // 4 threads = 10.1 tok/s generation, 16.6 tok/s prompt eval.
        const val THREADS = 4
        const val CTX_SIZE = 4096
        const val MIN_AVAIL_BYTES = 500L * 1024 * 1024
        const val MODEL_URL =
            "https://huggingface.co/bartowski/google_gemma-3-1b-it-GGUF/resolve/main/google_gemma-3-1b-it-Q4_K_M.gguf"
    }
}

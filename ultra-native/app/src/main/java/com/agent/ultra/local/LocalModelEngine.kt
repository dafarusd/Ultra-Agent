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

    private val prefs = context.getSharedPreferences("ultra_local_model", Context.MODE_PRIVATE)
    private var handle: Long = 0
    private val lock = Any()

    /** Where the weights come from. Any GGUF the llama.cpp build understands. */
    var modelUrl: String
        get() = prefs.getString(K_URL, DEFAULT.url) ?: DEFAULT.url
        private set(v) { prefs.edit().putString(K_URL, v).apply() }

    /** Filename on disk. Distinct per model, so switching does not clobber
     * a model you already downloaded — swapping back is free. */
    var modelFileName: String
        get() = prefs.getString(K_FILE, DEFAULT.fileName) ?: DEFAULT.fileName
        private set(v) { prefs.edit().putString(K_FILE, v).apply() }

    val modelLabel: String
        get() = prefs.getString(K_LABEL, DEFAULT.label) ?: DEFAULT.label

    private val modelFile: File get() = File(context.filesDir, "models/" + modelFileName)

    val modelPresent: Boolean get() = modelFile.exists() && modelFile.length() > 100_000_000
    val loaded: Boolean get() = handle != 0L
    val modelFileSizeBytes: Long get() = if (modelFile.exists()) modelFile.length() else 0L
    val modelFilePath: String get() = modelFile.absolutePath

    /**
     * Point the engine at a different model. Unloads the current weights first
     * — the native context holds an mmap of the old file, and on a 3.5GB phone
     * two sets of weights do not fit. Does not download; call downloadModel()
     * afterwards if the new file is not already on disk.
     */
    fun selectModel(choice: ModelChoice) {
        unload()
        modelUrl = choice.url
        modelFileName = choice.fileName
        prefs.edit().putString(K_LABEL, choice.label).apply()
        android.util.Log.i("UltraLlm", "selected model: ${choice.label} (${choice.fileName})")
    }

    /** Delete the weights for the current selection. */
    fun deleteModelFile(): Boolean {
        unload()
        return modelFile.exists() && modelFile.delete()
    }

    /** Models on disk, so the user can see what a switch would cost to undo. */
    fun downloadedFileNames(): Set<String> =
        File(context.filesDir, "models").listFiles()
            ?.filter { it.isFile && it.length() > 100_000_000 }
            ?.map { it.name }?.toSet() ?: emptySet()

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
            val req = okhttp3.Request.Builder().url(modelUrl).build()
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
        /** One engine per process. The weights are ~800MB mmap'd against a
         * single native context — a second instance would load them twice. */
        @Volatile private var sharedInstance: LocalModelEngine? = null

        fun shared(context: Context): LocalModelEngine =
            sharedInstance ?: synchronized(this) {
                sharedInstance ?: LocalModelEngine(context.applicationContext)
                    .also { sharedInstance = it }
            }

        // Measured on the A15 5G (llama-bench, Gemma 3 1B Q4_K_M):
        // 4 threads = 10.1 tok/s generation, 16.6 tok/s prompt eval.
        const val THREADS = 4
        const val CTX_SIZE = 4096
        const val MIN_AVAIL_BYTES = 500L * 1024 * 1024
        private const val K_URL = "model_url"
        private const val K_FILE = "model_file"
        private const val K_LABEL = "model_label"

        /**
         * Presets. Every URL here was checked to resolve, and the sizes are the
         * real content-length, not the model card's claim. Anything larger than
         * about 2GB is not worth trying on a 3.5GB phone — the weights are
         * mmap'd, but the KV cache and the rest of the app still need room.
         */
        val PRESETS = listOf(
            ModelChoice(
                "Gemma 3 1B (Q4_K_M) — default",
                "https://huggingface.co/bartowski/google_gemma-3-1b-it-GGUF/resolve/main/google_gemma-3-1b-it-Q4_K_M.gguf",
                "gemma3-1b-q4km.gguf", 768,
                "Measured 10.1 tok/s on this phone. The one the tool loop was tuned against.",
            ),
            ModelChoice(
                "Llama 3.2 1B (Q4_K_M)",
                "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf",
                "llama32-1b-q4km.gguf", 770,
                "Same size class as the default. Different instruction style — worth a try if Gemma misreads you.",
            ),
            ModelChoice(
                "Gemma 3 1B (Q8_0) — higher quality",
                "https://huggingface.co/bartowski/google_gemma-3-1b-it-GGUF/resolve/main/google_gemma-3-1b-it-Q8_0.gguf",
                "gemma3-1b-q8.gguf", 1019,
                "Same model, less quantisation damage. Bigger and slower.",
            ),
            ModelChoice(
                "Qwen2.5 1.5B (Q4_K_M)",
                "https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf",
                "qwen25-15b-q4km.gguf", 940,
                "Larger, generally stronger at structured output. Slower than the 1B models.",
            ),
            ModelChoice(
                "Qwen2.5 3B (Q4_K_M) — may not fit",
                "https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf",
                "qwen25-3b-q4km.gguf", 1840,
                "The ceiling on this device. Expect slow generation and refused loads under memory pressure.",
            ),
        )

        val DEFAULT = PRESETS[0]
    }
}

/** A downloadable on-device model. */
data class ModelChoice(
    val label: String,
    val url: String,
    val fileName: String,
    val approxMb: Int,
    val note: String,
)

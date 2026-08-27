package com.agent.ultra.local

/** JNI declarations for the llama.cpp shim (libultra_llm.so). */
object LlmNative {

    init {
        System.loadLibrary("ultra_llm")
    }

    fun interface TokenCallback {
        fun onToken(piece: String)
    }

    /** Returns a handle, or 0 on failure. */
    external fun nativeLoad(path: String, threads: Int, ctxSize: Int): Long

    /**
     * Runs the prompt synchronously on the calling thread, streaming tokens
     * to [callback]. Returns the number of generated tokens, or a negative
     * error code.
     */
    external fun nativeGenerate(
        handle: Long,
        prompt: String,
        maxTokens: Int,
        temperature: Float,
        callback: TokenCallback?,
    ): Int

    external fun nativeFree(handle: Long)
}

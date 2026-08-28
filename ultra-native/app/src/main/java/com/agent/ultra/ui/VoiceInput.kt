package com.agent.ultra.ui

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log

/** On-device speech-to-text into the chat input. One-shot per tap. */
class VoiceInput(
    private val context: Context,
    private val onResult: (String) -> Unit,
) {
    private var recognizer: SpeechRecognizer? = null
    private var active = false

    fun start(): Boolean {
        return try {
            if (!SpeechRecognizer.isRecognitionAvailable(context)) {
                Log.w(TAG, "speech recognition unavailable")
                return false
            }
            stopInternal()
            val sr = SpeechRecognizer.createSpeechRecognizer(context)
            recognizer = sr
            sr.setRecognitionListener(object : RecognitionListener {
                override fun onResults(results: Bundle) {
                    val texts = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    if (!texts.isNullOrEmpty()) onResult(texts[0])
                    active = false
                }
                override fun onError(error: Int) {
                    Log.w(TAG, "error $error")
                    active = false
                }
                override fun onReadyForSpeech(params: Bundle?) {}
                override fun onBeginningOfSpeech() {}
                override fun onRmsChanged(rmsdB: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onEndOfSpeech() {}
                override fun onPartialResults(partialResults: Bundle?) {}
                override fun onEvent(eventType: Int, params: Bundle?) {}
            })
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
            sr.startListening(intent)
            active = true
            true
        } catch (e: Exception) {
            Log.w(TAG, "start failed", e)
            false
        }
    }

    fun stop() {
        stopInternal()
    }

    private fun stopInternal() {
        try {
            recognizer?.stopListening()
            recognizer?.destroy()
        } catch (_: Exception) {}
        recognizer = null
        active = false
    }

    companion object { private const val TAG = "UltraVoice" }
}

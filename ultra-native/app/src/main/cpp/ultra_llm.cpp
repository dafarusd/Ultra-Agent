#include <jni.h>
#include <string>
#include <vector>
#include <android/log.h>
#include "llama.h"

#define TAG "UltraLlm"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

namespace {

struct Engine {
    llama_model *model = nullptr;
    llama_context *ctx = nullptr;
    const llama_vocab *vocab = nullptr;
    int32_t ctxSize = 0;
};

bool backendReady = false;

// Global callback refs for the in-flight generation (single-flight by design).
JavaVM *gVm = nullptr;
jobject gCallback = nullptr;
jmethodID gOnToken = nullptr;

void deliverToken(const std::string &piece) {
    if (!gVm || !gCallback || !gOnToken) return;
    JNIEnv *env = nullptr;
    bool attached = false;
    if (gVm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) == JNI_EDETACHED) {
        if (gVm->AttachCurrentThread(&env, nullptr) != JNI_OK) return;
        attached = true;
    }
    if (env) {
        jstring s = env->NewStringUTF(piece.c_str());
        env->CallVoidMethod(gCallback, gOnToken, s);
        env->DeleteLocalRef(s);
    }
    if (attached) gVm->DetachCurrentThread();
}

} // namespace

extern "C" {

JNIEXPORT jlong JNICALL
Java_com_agent_ultra_local_LlmNative_nativeLoad(
        JNIEnv *env, jobject, jstring jpath, jint threads, jint ctxSize) {
    if (!backendReady) { llama_backend_init(); backendReady = true; }

    const char *path = env->GetStringUTFChars(jpath, nullptr);

    llama_model_params mparams = llama_model_default_params();
    mparams.n_gpu_layers = 0; // CPU path — measured winner on the A15 bench

    llama_model *model = llama_model_load_from_file(path, mparams);
    env->ReleaseStringUTFChars(jpath, path);
    if (!model) { LOGE("model load failed"); return 0; }

    llama_context_params cparams = llama_context_default_params();
    cparams.n_ctx = ctxSize;
    cparams.n_threads = threads;
    cparams.n_threads_batch = threads;

    llama_context *ctx = llama_init_from_model(model, cparams);
    if (!ctx) { LOGE("ctx init failed"); llama_model_free(model); return 0; }

    auto *engine = new Engine();
    engine->model = model;
    engine->ctx = ctx;
    engine->vocab = llama_model_get_vocab(model);
    engine->ctxSize = ctxSize;
    LOGI("loaded: ctx=%d threads=%d", ctxSize, threads);
    return reinterpret_cast<jlong>(engine);
}

JNIEXPORT jint JNICALL
Java_com_agent_ultra_local_LlmNative_nativeGenerate(
        JNIEnv *env, jobject, jlong handle, jstring jprompt, jint maxTokens,
        jfloat temperature, jobject callback) {
    auto *engine = reinterpret_cast<Engine *>(handle);
    if (!engine || !engine->ctx) return -1;

    const char *promptC = env->GetStringUTFChars(jprompt, nullptr);
    std::string prompt(promptC);
    env->ReleaseStringUTFChars(jprompt, promptC);

    // Tokenize
    std::vector<llama_token> tokens(prompt.size() + 32);
    int nTokens = llama_tokenize(engine->vocab, prompt.c_str(), prompt.size(),
                                 tokens.data(), tokens.size(), true, true);
    if (nTokens < 0) { LOGE("tokenize overflow"); return -2; }
    tokens.resize(nTokens);
    if ((int) tokens.size() >= engine->ctxSize - maxTokens - 8) {
        LOGE("prompt too long for ctx"); return -3;
    }

    // Register streaming callback
    if (callback) {
        env->GetJavaVM(&gVm);
        gCallback = env->NewGlobalRef(callback);
        gOnToken = env->GetMethodID(env->GetObjectClass(callback), "onToken", "(Ljava/lang/String;)V");
    } else {
        gCallback = nullptr;
    }

    // Release the callback on EVERY exit from here down, not just the happy one.
    //
    // The prompt-decode failure below returns -4 between minting that global
    // reference and releasing it. That leaked the reference, and left gCallback
    // non-null and dangling for whatever called next — a stale pointer into a
    // Java object that may no longer exist. A guard makes the class of mistake
    // impossible rather than fixing the one path that happened to show it: any
    // return added later is covered without anyone having to remember.
    struct CallbackScope {
        JNIEnv *env;
        explicit CallbackScope(JNIEnv *e) : env(e) {}
        ~CallbackScope() {
            if (gCallback) { env->DeleteGlobalRef(gCallback); gCallback = nullptr; }
            gOnToken = nullptr;
        }
        CallbackScope(const CallbackScope &) = delete;
        CallbackScope &operator=(const CallbackScope &) = delete;
    } cbScope(env);

    // Evaluate prompt
    llama_batch batch = llama_batch_get_one(tokens.data(), tokens.size());
    if (llama_decode(engine->ctx, batch) != 0) { LOGE("prompt decode failed"); return -4; }

    // Sampler: low-temp deterministic-ish for agent work
    llama_sampler *chain = llama_sampler_chain_init(llama_sampler_chain_default_params());
    llama_sampler_chain_add(chain, llama_sampler_init_top_p(0.9f, 1));
    llama_sampler_chain_add(chain, llama_sampler_init_temp(temperature));
    llama_sampler_chain_add(chain, llama_sampler_init_dist(42));

    int generated = 0;
    for (; generated < maxTokens; generated++) {
        llama_token tok = llama_sampler_sample(chain, engine->ctx, -1);
        if (llama_vocab_is_eog(engine->vocab, tok)) break;

        char buf[256];
        int len = llama_token_to_piece(engine->vocab, tok, buf, sizeof(buf), 0, true);
        if (len > 0) deliverToken(std::string(buf, len));

        llama_sampler_accept(chain, tok);
        llama_batch next = llama_batch_get_one(&tok, 1);
        if (llama_decode(engine->ctx, next) != 0) { LOGE("decode failed mid-gen"); break; }
    }

    llama_sampler_free(chain);
    return generated;   // cbScope releases the callback
}

JNIEXPORT void JNICALL
Java_com_agent_ultra_local_LlmNative_nativeFree(JNIEnv *, jobject, jlong handle) {
    auto *engine = reinterpret_cast<Engine *>(handle);
    if (!engine) return;
    if (engine->ctx) llama_free(engine->ctx);
    if (engine->model) llama_model_free(engine->model);
    delete engine;
}

} // extern "C"

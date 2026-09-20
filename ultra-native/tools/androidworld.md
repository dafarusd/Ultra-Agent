# AndroidWorld: Ultra on a public benchmark

[AndroidWorld](https://github.com/google-research/android_world) (Google Research) runs 116
hand-written tasks across 20 real Android apps on an emulator and checks the device's own state
afterwards. It grades; nothing of ours does.

## Setup on this laptop (once)

```
~/Android/cmdline-tools/latest/bin/sdkmanager --install "emulator" \
  "system-images;android-33;google_apis;x86_64" "platforms;android-33"
~/Android/cmdline-tools/latest/bin/avdmanager create avd -n AndroidWorldAvd \
  -k "system-images;android-33;google_apis;x86_64" -d pixel_6
ln -sfn ~/Android ~/Android/Sdk          # run.py only looks in ~/Android/Sdk/platform-tools
git clone https://github.com/google-research/android_world ~/androidworld
cd ~/androidworld && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/pip install -e .
```

## Each session

```
~/Android/emulator/emulator -avd AndroidWorldAvd -no-snapshot -grpc 8554 -no-audio -gpu swiftshader_indirect &
cd ~/vault/runtime/bridge && ULTRA_BRAIN=venice:llama-3.3-70b python3 brain_proxy.py &   # the brain, laptop-side
adb -s emulator-5554 reverse tcp:8799 tcp:8799
cd ~/projects/Audit-Discuss-Build/ultra-native && ./gradlew assembleDebug -Pbench
adb -s emulator-5554 install -r -g app/build/outputs/apk/debug/app-debug.apk
cd ~/androidworld && ANDROID_SERIAL=emulator-5554 .venv/bin/python bench_ultra.py \
  --agent_name=ultra --tasks=ClockStopWatchRunning,SimpleSmsSend --n_task_combinations=1
```

`bench_ultra.py` is android_world's own `run.py` with our agent added; the agent itself is
`tools/androidworld_agent.py`.

## Things that cost hours, so they are written down

- **The emulator boots in 2023**, so every HTTPS call from an app fails with "Unacceptable
  certificate". The brain proxy on the laptop is how Ultra reaches a model at all; it also makes
  the brain a laptop-side setting (`ULTRA_BRAIN=venice:MODEL | local:qwen`) so one harness can
  score four brains.
- **`-Pbench`** builds x86_64 without llama.cpp (CMake skips non-arm64; `LlmNative.available` is
  false and the cloud brain is used). The phone's arm64 release path is untouched.
- **Two accessibility services do not share this emulator.** With Ultra's on, the harness logs
  "Could not get a11y tree, retrying"; with only the forwarder it reads first try. Turning Ultra's
  off between tasks was tried: every task then failed. Ultra's stays on, the harness retries, and
  the adapter drives Ultra over adb + uiautomator, which keeps working.
- **Ultra's app policy** defaults to allow-list with nothing allowed. In the emulator write
  `/data/data/com.agent.ultra/shared_prefs/ultra_protected_apps.xml` with `allowlist_mode=false`
  (adb root; a file pushed to /sdcard/Android/data is not readable by the app).
- **The benchmark reads the live screen**, so the adapter brings the task's app back to the front
  when Ultra's chat ended up there — and only then: reordering an app that is already in front
  sends it back to its default tab (the Clock reopened on Alarm and a passing task started failing).

## Results

| When | Set | Score |
|---|---|---|
| 2026-09-19, first scored run | 12 tasks, 9 apps | **3/12 (25%)** |

For scale, the AndroidWorld paper's GPT-4 agent (M3A) reports ~30% on the full 116.

What the benchmark found in Ultra on day one, all of it live on the phone too: an empty text box
was invisible; open menus read as empty; unlabelled buttons (every "+") were dropped; the navigator
drove Ultra's own chat when an app name didn't resolve; a plan that only opened a tab counted as
done; and a run that only launched an app was stored as the way to do the job.

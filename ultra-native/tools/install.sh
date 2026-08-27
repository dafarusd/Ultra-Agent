#!/bin/bash
# Agent Ultra native — one-command device install.
# Handles: Play Protect "Don't send" dialog, a11y re-enable, app launch.
# Usage: install.sh [path-to-apk]   (default: the debug APK)
set -euo pipefail
APK="${1:-app/build/outputs/apk/debug/app-debug.apk}"
[ -f "$APK" ] || { echo "[install] APK not found: $APK"; exit 1; }
PKG=com.agent.ultra
SVC=$PKG/com.agent.ultra.AgentAccessibilityService

adb install -r -i com.android.vending "$APK" &
INSTALL_PID=$!

# Play Protect dialog appears mid-install on this device; dismiss it.
for i in $(seq 1 40); do
  if adb shell uiautomator dump /sdcard/_pp.xml > /dev/null 2>&1; then
    B=$(adb shell cat /sdcard/_pp.xml 2>/dev/null | grep -o "text=\"Don't send\"[^>]*bounds=\"[^\"]*\"" | grep -o 'bounds="[^"]*"' | sed 's/[^0-9]/ /g')
    if [ -n "$B" ]; then
      set -- $B
      adb shell input tap $(( ($1+$3)/2 )) $(( ($2+$4)/2 )) > /dev/null 2>&1
      echo "[install] Play Protect dismissed"
      break
    fi
  fi
  sleep 2
done
wait $INSTALL_PID

adb shell settings put secure enabled_accessibility_services $SVC
adb shell settings put secure accessibility_enabled 1
adb shell am start -n $PKG/.MainActivity > /dev/null 2>&1
sleep 3
adb shell dumpsys package $PKG | grep versionName | head -1
adb shell dumpsys accessibility | grep -o "AgentAccessibilityService" | head -1 && echo "[install] a11y bound"

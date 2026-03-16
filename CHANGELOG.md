# Agent Ultra -- Changelog

All notable changes to this project are documented here, organized by feature version. Dates reflect when work was completed.

---

## [v3.23.0] -- 2026-03-16 -- Feature: Total Access + System Information + Comprehensive Logging

### Added -- Total Access Settings & Deep Link Resolution Layer
- **New `src/core/SettingsDirectory.ts`** — 37 Android settings entries with intent action triggers (WiFi, Bluetooth, Display, Sound, Accessibility, Developer Options, etc.)
- **New `src/core/DeepLinkDirectory.ts`** — 19 app-specific deep links (Spotify, YouTube, Gmail, Maps, WhatsApp, Instagram, TikTok, Calendar, etc.)
- **New `src/core/SystemActions.ts`** — 4 system control actions (WiFi toggle, Bluetooth toggle, Airplane Mode, Brightness) routing to settings panels.
- **Settings intent resolution** integrated into IntentResolver Layer 2 (before rich intent patterns) — triggers `resolveSettingsIntent()`.
- **Deep link resolution** integrated into IntentResolver Layer 3 (after settings, before patterns) — triggers `resolveDeepLink()`.
- **System action resolution** integrated into TaskExecutor PATH B (before package lookup) — system commands checked before app launch attempts.

### Added -- System Information Capability
- **New capability `system_info`** registered in CapabilityRegistry (low risk, no permissions required).
- **CommandParser patterns** for user queries: "system info", "device info", "battery", "ram/memory", "storage", "cpu temperature".
- **TaskExecutor implementation** — `gatherSystemInfo()` function collects:
  - Battery: percentage, state (Unplugged/Charging/Full), low power mode flag
  - RAM: used MB, total MB
  - Storage: free GB, total GB (disk capacity)
  - CPU Temperature: from /sys/class/thermal (if available)
  - Device: model name, Android version
- **Graceful fallback** for unavailable sensors — missing reads logged in `failedReads` array, output shows "unavailable" for failed categories.

### Added -- Preferences Backup/Restore
- **New `src/services/PreferenceBackup.ts`** with `exportPreferences()` and `importPreferences()` functions.
- **Export:** Collects 7 keys (preferred_model, api_defaults, saved_apis, learned_patterns, user_preferences, daily_cost_limit, task_cost_limit), saves JSON to LogFolder, shares via Android file picker.
- **Import:** DocumentPicker UI for file selection, validates JSON structure (version/source/agent-ultra check), restores settings to SecureVault, returns count of restored keys.
- **Settings UI:** New "Preferences Backup" card on APIs tab with Export and Import buttons.

### Added -- Package Learning System
- **New `learnPackage(trigger, packageName)` method** in PreferenceLearner — stores immediate high-confidence mappings for frequently-used app launch queries.
- **Called by app launcher** on successful app launches — learns "spotify" → "com.spotify.music" at confidence 1.0.

### Added -- Comprehensive Logging for Total Access Features
- **6 new UltraDevLog categories:** SETTINGS_INTENT, DEEP_LINK, SYSTEM_ACTION, SYSTEM_INFO, PREFERENCE_BACKUP, LEARN_PACKAGE.
- **UltraDevLog.settingsIntent()** — logs settings query, match result, action/label, with HIT/MISS outcome.
- **UltraDevLog.deepLink()** — logs deep link query, match result, URI/label, with HIT/MISS outcome.
- **UltraDevLog.systemAction()** — logs system action trigger, routing to settings, success flag.
- **UltraDevLog.systemInfo()** — logs collected battery/RAM/storage/temperature values with failedReads array for diagnostics.
- **UltraDevLog.preferenceBackup()** — logs export/import operations with key count and error messages.
- **UltraDevLog.learnPackage()** — logs app package learning with trigger, package name, update vs. new pattern flag.
- **Deduplication fixes:**
  - `networkStatus()` now deduplicates identical status (isConnected:type key).
  - `modelState()` now deduplicates via hash to suppress picker_classification spam.
- **formatEntry cases** added for all 6 new categories with optimized display format (8-char category codes, compact field layout).

### Changed -- IntentResolver Sensor Wiring
- Added UltraDevLog imports and sensor calls at:
  - Line 325: `settingsIntent()` call after `resolveSettingsIntent()` 
  - Line 341: `deepLink()` call after `resolveDeepLink()` (only if settings didn't match)
- Settings intent logging happens before all other patterns for priority visibility.

### Changed -- SystemActions Sensor Wiring
- All 4 handlers now call `systemAction()` after `startActivityAsync()`:
  - WiFi toggle: `systemAction('wifi toggle', true, "Opened Wi-Fi settings", true)`
  - Bluetooth: `systemAction('bluetooth toggle', ...)`
  - Airplane Mode: `systemAction('airplane mode toggle', ...)`
  - Brightness: `systemAction('brightness adjust', ...)`

### Changed -- TaskExecutor.gatherSystemInfo() Sensor Wiring
- Refactored to collect all values into structured `sensorData` object before returning.
- Each try/catch block now populates sensorData fields and appends to failedReads on error.
- Calls `DebugLog.systemInfo(sensorData)` at the end for comprehensive diagnostic logging.

### Changed -- PreferenceBackup Sensor Wiring
- `exportPreferences()` calls `preferenceBackup('export', true/false, keyCount, errorMsg)`.
- `importPreferences()` calls `preferenceBackup('import', true/false, keyCount, errorMsg)`.
- Captures both success and failure paths with proper key counts.

### Changed -- PreferenceLearner Sensor Wiring
- `learnPackage()` method now calls `UltraDevLog.learnPackage(trigger, packageName, wasUpdate)` at the end.
- Distinguishes between new patterns and updates to existing patterns.

### Technical Details
- New files total: 4 (SettingsDirectory.ts, DeepLinkDirectory.ts, PreferenceBackup.ts, SystemActions.ts)
- Modified files: 5 (IntentResolver.ts, TaskExecutor.ts, CommandParser.ts, CapabilityRegistry.ts, app/settings.tsx, PreferenceLearner.ts, UltraDevLog.ts)
- New type categories in UltraLogCat: 6 total
- New static methods in UltraDevLog: 6 total
- New formatEntry cases: 6 total
- Packages installed: expo-battery, expo-document-picker, react-native-device-info

### Implications
- Users can now open any Android settings panel via natural language ("open WiFi settings", "open accessibility", etc.).
- Users can navigate to app-specific features via deep links ("open Gmail compose", "show me Spotify liked songs").
- System control capabilities (WiFi/Bluetooth/Airplane Mode/Brightness) route to settings since Android 12+ restricts direct toggles.
- Device system information is accessible on demand ("how much battery", "check RAM", "storage available", "CPU temp").
- All user settings (API defaults, learned patterns, cost limits) can be backed up and restored via JSON file.
- App launch learning now captures successful mappings for faster future lookups.
- All Total Access operations are comprehensively logged for remote debugging via UltraDevLog.

---

## [v3.22.0] -- 2026-03-15 -- Fix: Model Picker Empty Categories (Image/Video/Reasoning)

### Fixed -- Model picker filter tabs
- **Image tab**: Was showing 0 models. Venice image models (flux, fluently, stable-diffusion, etc.) were all classified as "text" because Venice API returns `type: "text"` for everything.
- **Video tab**: Was showing 0 models. Same root cause — no name-based heuristics existed.
- **Reasoning tab**: Was showing 29/47 models. `supportsReasoning` capability flag from Venice API is set on most models, making the Reasoning tab a dumping ground.

### Added -- Shared model classifier
- New `src/utils/classifyModelType.ts` — single source of truth for model category classification
- Uses name/ID pattern matching: image (flux, fluently, sdxl, stable-diffusion, pony-realism), video (wan-, luma, runway, kling), code (code, codestral), reasoning (reason, qwq, deepseek-r1)
- Removed dependency on Venice `supportsReasoning` capability flag for tab classification
- Both `app/index.tsx` (picker) and `app/settings.tsx` (defaults) now use the same classifier

### Added -- Classification devlog
- `MODEL_CLASSIFY` entry logged via `UltraDevLog.modelState('picker_classification', counts)` on each picker build
- Shows `{text:N, image:N, code:N, reasoning:N, video:N}` for remote debugging

### Fixed -- Model picker sheet height (v3.21.1)
- Added `height: SHEET_MAX_HEIGHT` to sheet `Animated.View` — FlatList with `flex: 1` previously resolved to 0 height because parent only had `maxHeight`
- Sheet now fully slides up showing the model list

---

## [v3.20.0] -- 2026-03-15 -- Fix: Log File Proliferation (Hundreds → 3-4 Files)

### Fixed -- Log file explosion
- **Root cause:** `agent-ultra-logs/` used timestamped filenames, creating a new file every 2-3 seconds instead of updating existing ones.
- **Solution:** Changed to fixed filenames (`ultra-devlog.jsonl`, `debug-log.jsonl`, `raw-export.jsonl`). Since `writeAsStringAsync` overwrites (doesn't append), each flush now updates the same file, making it grow naturally over the session.
- **Cleanup:** Added automatic deletion of old timestamped files on app startup to clean up accumulated files from prior versions.
- **Result:** 3-4 files max, ~5 MB max total, growing naturally to several MB per session. Files are never truncated mid-session.

### Added -- Comprehensive log proliferation report
- `LOG-FILE-PROLIFERATION-REPORT.md` contains full analysis, data flow, file cross-linkage, why it happened, and technical explanation.

### Changed
- `src/utils/UltraDevLog.ts` line 840: Fixed filename `ultra-devlog.jsonl`
- `src/utils/DebugLog.ts` line 395: Fixed filename `debug-log.jsonl`
- `src/utils/DebugLog.ts` lines 417, 422: Fixed filename `raw-export.jsonl`
- `src/services/LogFolder.ts` lines 45-52: Added cleanup block for old timestamped files

---

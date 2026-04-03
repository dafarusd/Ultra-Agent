# DEVLOG.md — Agent Ultra Development Log

This file is updated by Claude Code at the end of every work session.
Read this file at the start of every session to understand previous work.

---

## How to Use This File

**At session start:** Read this entire file before beginning work. It tells you what happened before and what's next.

**At session end:** Add a new entry at the top of the Session Log (newest first) with:
- Date and session summary
- What was changed and why
- What's still open
- What to pick up next
- Honest status (PROVEN / PARTIALLY PROVEN / SOURCE-FIXED BUT RUNTIME-UNPROVEN / etc.)

---

## Current State

**Last updated:** 2026-04-02 (Session 5)

**App status:** Clean TypeScript compile (0 errors). Node.js upgraded to 22.21.0. Native fixes (getScreenContentFlat window scan, moveTaskToBack) are in source and compile-clean but never reached at runtime — BrainExecutor tool selection bypasses react_navigate and possibly app_launch entirely.

**Current priority:** Run adb logcat with ReactNativeJS tag to capture console.warn breadcrumbs from BrainExecutor, determine which tool the LLM actually selects, then fix routing.

**Known blockers:**
- BrainExecutor LLM never selects react_navigate or app_launch — both native fixes are dead code at runtime until tool routing is fixed.
- Internal UltraDevLog inaccessible from release/preview builds (not debuggable). console.warn breadcrumbs added as workaround.
- Replit prompts 12/13/14 confirmed applied.

---

## Active Decisions

Decisions that affect ongoing work. Update as decisions are made or reversed.

- **BrainExecutor is sole active path.** AgentCore.execute() creates a new BrainExecutor per call and delegates. detectMode(), buildDynamicPrompt(), buildContext(), parseActionPlan() exist in AgentCore but are dead code on the active execution path.
- **Two-Claude workflow.** Chat Claude (claude.ai) = strategy, planning, architecture. Claude Code (this instance) = execution, validation, commits. Solution files from Chat Claude are validated against real codebase before applying.
- **react_navigate planning step applied.** ReActLoop now has planSteps() method, app context injection, plan-aware LLM prompt, and step advancement tracking. Committed f42909a.

---

## Session Log

<!-- Add new entries at the top. Most recent first. -->

### Session 5 — moveTaskToBack Wiring Confirmed + Tool Selection Diagnosed
- **Date:** 2026-04-02
- **Subsystems:** D (Actions/Device Control), A (Brain/Cognition), H (Build/Release)
- **Work done:**
  - Node.js upgraded from 18.20.0 to 22.21.0 (resolves React Native 0.81 / Expo / Metro engine requirements)
  - Confirmed moveTaskToBack wiring is correct end-to-end: Java `@ReactMethod` in AccessibilityBridgeModule (registers as "AppController"), TypeScript interface + noop + native controller, call site in TaskExecutor.ts — no name collision, no missing registration
  - Root cause of zero MOVE_TO_BACK logs: `native.moveTaskToBack` ternary guard silently returned `Promise.resolve(false)`. Replaced with explicit diagnostic logging (commit 21d8016)
  - Added moveTaskToBack call to all 3 app launch paths in react_navigate case: matched app, known package, URL/domain (commit 3b48621)
  - Two runtime adb tests both show **TOOL_NOT_SELECTED**: LLM never picks `react_navigate`, and `app_launch` handler with moveTaskToBack also never reached. Zero MOVE_TO_BACK entries, zero SCREEN_FLAT reading non-agent-ultra window, agent operates on own UI (`TEXT: text=shorts pkg=com.agent.ultra`)
  - Window dumps confirm: only systemui, launcher, honeyboard, and Agent Ultra in window stack. Target app (YouTube) never appears.
  - Internal UltraDevLog inaccessible from release/preview build (`run-as: package not debuggable`)
  - Added `console.warn` breadcrumbs at BrainExecutor tool selection (`[BRAIN] tool_selected:`), TaskExecutor case entries (`[TASK] entering:`), launch results (`[TASK] launch_result:`), and moveTaskToBack calls (`[TASK] moveTaskToBack: calling`) — visible via `adb logcat -s ReactNativeJS:*` (commit 499bd3e)
  - Preview build submitted, awaiting install and test
- **Committed:** 21d8016, 3b48621, 499bd3e
- **Status:** DIAGNOSTIC-IN-PROGRESS. Both native fixes are in source and compile-clean but never reached at runtime because BrainExecutor tool selection bypasses react_navigate and possibly app_launch entirely.
- **Next:** Run adb logcat with ReactNativeJS tag to capture console.warn breadcrumbs, determine which tool the LLM actually selects, then fix routing.

### Session 4 — adb Native Layer Deep Dive + Root Cause Discovery
- **Date:** 2026-04-02
- **Subsystems:** D (Actions/Device Control), A (Brain)
- **Work done:**
  - Established adb logcat debugging workflow: `$appid = adb shell pidof com.agent.ultra; adb logcat --pid=$appid -s AgentA11y:*`
  - Added `Log.i(TAG, ...)` calls alongside all `emitA11yLog` calls so native events are visible in adb logcat (previously invisible — emitA11yLog only writes to JS queue)
  - Added comprehensive logcat observability to: checkPackageAllowed (GATE), performTap (TAP), performText (TEXT), performScroll (SCROLL), performSwipe (SWIPE), performClick (CLICK), performBack (BACK), performHome (HOME), moveTaskToBack (MOVE_TO_BACK), getScreenContentFlat (SCREEN_FLAT with root_pkg and first node labels), getActivePackage (GET_PKG), waitForUiChange (WAIT_UI), onAccessibilityEvent (PKG_CHANGE)
  - Added `dumpWindowStack()` method — logs all accessibility windows with layer order, type, package, focused state. Called from getScreenContentFlat.
  - Added import for `AccessibilityWindowInfo`
  - Removed self-check from checkPackageAllowed (was unreliable — currentPackage flips to com.agent.ultra whenever JS thread fires accessibility events even when Agent Ultra is visually in background, proven via adb)
  - Added auto-allow to checkPackageAllowed — any non-blocked package is automatically allowed
  - Added moveTaskToBack native method to AccessibilityBridgeModule + AppController.ts interface + TaskExecutor.ts call before ReActLoop.execute()
  - **Fixed getScreenContentFlat** to scan all accessibility windows via `getWindows()`, pick the first `TYPE_APPLICATION` window that isn't com.agent.ultra, and read its tree. Falls back to `getRootInActiveWindow()` only if no other app window found.
- **ROOT CAUSES DISCOVERED (all proven via adb logcat):**
  1. **CRITICAL: getScreenContentFlat() always returned Agent Ultra's own window.** `getRootInActiveWindow()` returns the accessibility service host's window — always com.agent.ultra. The agent has NEVER seen another app's UI tree. Every plan, tap target, and text input has been against its own elements.
  2. **CRITICAL: moveTaskToBack never fires.** Zero MOVE_TO_BACK log entries in any adb capture. The call path in TaskExecutor.ts is not being reached. Need to inspect lines 1625-1645 to find why.
  3. **CRITICAL: Agent Ultra's activity stays in foreground** because moveTaskToBack never fires. Target app (YouTube) never gets an accessibility window in the stack. Window dumps show only: systemui, launcher, honeyboard, and Agent Ultra.
  4. **CONFIRMED: currentPackage is unreliable** — flips between com.agent.ultra, com.android.systemui, com.samsung.android.honeyboard, and target app dozens of times per second. Self-check using currentPackage was correctly removed.
  - **Evidence:** Full adb logcat captures showing `SCREEN_FLAT: root_pkg=com.agent.ultra` on every call, WINDOWS dumps with no YouTube window, `TEXT: text=short pkg=com.agent.ultra` (typing into own text box), zero MOVE_TO_BACK entries.
- **Committed:** c6a4c0c, b4e703f, f9c3139, 770eac0, cea84fd, fd5ff9e, 252f654, bf4f139, 33f66ed, 839bced, a4b1787
- **Status:** ROOT-CAUSE-PROVEN via adb. getScreenContentFlat window fix applied. moveTaskToBack call path still unreachable.
- **Next:** Inspect TaskExecutor.ts lines 1625-1645 to find why moveTaskToBack is unreachable, then build and test both fixes together.

### Session 3 — Runtime Log Analysis + Three Fixes
- **Date:** 2026-04-01
- **Subsystems:** A (Brain/Cognition), D (Actions/Device Control)
- **Work done:**
  - Analyzed runtime logs from session mngc4pfq (8931 entries) and live test session
  - Found and fixed three runtime-proven bugs:
  1. **BrainExecutor tool selection** (21167b2): LLM picked app_launch/web_search instead of react_navigate for "open X and do Y" tasks. Fixed tool descriptions and added TOOL SELECTION routing rules to system prompt.
  2. **ReActLoop foreground gate** (c4e6970): planSteps() ran while Agent Ultra was still in foreground, producing plans targeting its own UI elements ("tap Agent Ultra", "tap Ask Agent Ultra..."). Added foreground polling gate — waits up to 6s for target app, re-observes, returns clear error if timeout.
  3. **Native checkPackageAllowed keyboard bug** (e240eba): Every performTap/performText/performScroll was silently returning false whenever Samsung keyboard (honeyboard) was visible. checkPackageAllowed() used currentPackage which flips to keyboard on every keystroke. Fixed to use getRootInActiveWindow().getPackageName() — the actual app, not the keyboard overlay. THIS WAS THE ROOT CAUSE of all "result=false" failures in the ReActLoop.
  - **Evidence chain:** seq 658-702 (browser opens, Agent Ultra returns to foreground, planner sees own UI), seq 9267-9449 (LLM chose app_launch then web_search, never tried react_navigate), runtime observation of taps returning false with keyboard visible.
- **Committed:** 21167b2, c4e6970, e240eba
- **Status:** SOURCE-FIXED, COMPILE-VERIFIED, RUNTIME-UNPROVEN (needs new build + device test)
- **Next:** Build and test all three fixes together. If taps land reliably, react_navigate becomes functional.

### Session 2 — ReActLoop Planning Step + Replit Prompt Verification
- **Date:** 2026-04-01
- **Subsystems:** A (Brain/Cognition), D (Actions/Device Control)
- **Work done:**
  - Grep-verified all Replit prompt 12/13/14 fixes are applied: DESTRUCTIVE_TOOLS safety gate, Samsung Smart Capture dismiss, stuck loop prevention (prevWasSameTool), TAPPABLE/TYPEABLE/SCROLLABLE screen classification, RECENT ACTIONS history injection
  - Applied SOLUTION_react_navigate_planning_step.md — 5 edits to src/core/ReActLoop.ts:
    1. Added planSteps() method — one-time AI planning call producing 3-8 ordered UI steps
    2. Added app context resolution (AppController.getActivePackage) before loop
    3. Added per-iteration app context refresh inside loop
    4. Replaced LLM fallback prompt with plan-aware version (CURRENT STEP, FULL PLAN with progress markers)
    5. Added plan step advancement logic in both deterministic and LLM paths (advance on UI change, forced advance after 2 stuck iterations)
  - Verified appHint propagation: BrainExecutor → TaskExecutor.completeWithReActLoop → ReActLoop.execute(goal, appHint)
  - TypeScript remains at 0 errors
- **Committed:** f42909a — "feat: add planning step to ReActLoop (AppAgent pattern)"
- **Status:** SOURCE-FIXED BUT RUNTIME-UNPROVEN
- **Next:** Device build and runtime test of a real phone task through the full perceive→plan→act→verify loop

### Session 1 — Clean TypeScript Baseline
- **Date:** 2026-04-01
- **Subsystems:** All (type-level fixes across the board)
- **Work done:**
  - Fixed 165 TypeScript errors → 0 across the codebase
  - Expanded UltraLogCat type with ~167 missing log categories
  - Added missing properties to UltraExecutionResult (success), Mode union (system, vision), PricingInfo (inputPer1k/outputPer1k aliases), ChatMessage.meta (requiresApproval), Genome types (config, permissions, enabled, MutationRecord/MutationResult fields)
  - Created src/types/expo-intent-launcher.d.ts to augment ActivityAction with VIEW, DEVICE_ADMIN_SETTINGS, PERMISSION_USAGE_SETTINGS
  - Fixed call sites in ~15 files: ModelRouter, TaskExecutor, AgentCore, Cortex, DeviceContext, BuildSystem, SettingsDirectory, GroupRouter, RouteHistoryStore, CostTracker, VisionPipeline, GenomeMutator, GenomeValidator, GenomeFitness, SelfImprover, app/index.tsx, app/settings.tsx
  - Fixed UltraDevLog method signatures to match actual callers (modelSetDefault, modelDiscoveryStart, modelApiResponse, etc.)
  - Confirmed architecture: AgentCore.execute() → BrainExecutor.execute() (line 587). BrainExecutor has tool loop with MAX_TOOL_TURNS=12, DESTRUCTIVE_TOOLS safety gate, parseToolCall()
  - Git configured: user Dafarus, email dafarus@agentultra.local
- **Committed:** 88f29c1 — "checkpoint: clean TypeScript baseline, 0 errors"
- **Status:** SOURCE-FIXED BUT RUNTIME-UNPROVEN
- **Next:** Verify Replit prompt 12/13/14 application status in live source

### Session 0 — Pre-Claude-Code Audit (Chat Claude only)
- **Date:** Pre-2026-04-01
- **Subsystems:** A (Brain/Cognition), D (Actions/Device Control)
- **Work done:**
  - Chat Claude audited ReActLoop.ts, AgentCore.ts, TaskExecutor.ts
  - Three confirmed bugs designed for fix: self-interaction safety, memory injection into planning prompts, weather capability delegation
  - Replit prompts 12, 13, 14 were written to address these bugs
  - react_navigate overhaul designed (AppAgent pattern with planning step before loop)
- **Committed:** Multiple commits via Replit (see git log for 0680269, 93131c6, 82ae5e8, 70f9d24, 680d373)
- **Status:** CANNOT VERIFY FROM CURRENT ARTIFACTS — unknown which Replit prompts are applied in live source
- **Next:** Claude Code to grep-verify prompt application before building on top

---

**End of DEVLOG.**

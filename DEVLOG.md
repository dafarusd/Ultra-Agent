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

**Last updated:** 2026-04-02 (Session 4)

**App status:** Clean TypeScript compile (0 errors). Root causes of all react_navigate failures discovered via adb logcat. getScreenContentFlat now reads target app window instead of Agent Ultra's own window. moveTaskToBack exists but call path may be unreachable in TaskExecutor.ts.

**Current priority:** Inspect TaskExecutor.ts lines 1625-1645 to find why moveTaskToBack is unreachable, then build and test both fixes together.

**Known blockers:**
- Node.js v18.20.0 installed; React Native 0.81 / Expo / Metro require >= 20.19.4. Will hit issues at build time.
- Runtime behavior is entirely unproven — compile-clean is not proof of correctness.
- Replit prompts 12/13/14 confirmed applied (destructive tools gate, Samsung Smart Capture dismiss, stuck loop prevention, screen element classification, recent action history all present).

---

## Active Decisions

Decisions that affect ongoing work. Update as decisions are made or reversed.

- **BrainExecutor is sole active path.** AgentCore.execute() creates a new BrainExecutor per call and delegates. detectMode(), buildDynamicPrompt(), buildContext(), parseActionPlan() exist in AgentCore but are dead code on the active execution path.
- **Two-Claude workflow.** Chat Claude (claude.ai) = strategy, planning, architecture. Claude Code (this instance) = execution, validation, commits. Solution files from Chat Claude are validated against real codebase before applying.
- **react_navigate planning step applied.** ReActLoop now has planSteps() method, app context injection, plan-aware LLM prompt, and step advancement tracking. Committed f42909a.

---

## Session Log

<!-- Add new entries at the top. Most recent first. -->

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

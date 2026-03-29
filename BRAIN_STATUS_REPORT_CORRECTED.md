# BRAIN STATUS REPORT — CORRECTED
Generated: 2026-03-29 (Brain Closure Pass v2)
Source of truth: live repo, current working tree

---

## A. Artifact / Evidence Claims

| Claim | Status |
|-------|--------|
| Previously provided source dump was complete | **FALSE** — old dump predated ba44fb8 commit |
| Old dump matched live repo | **FALSE** — stale, missing composite key fix + brain closure changes |
| ULTRA_FULL_SOURCE_DUMP_CURRENT.txt is fresh | **PROVEN** — generated from live repo in this pass |

---

## B. Brain Existence / Wiring Claims

Each file existence verified from live repo `find` output:

| File | Exists | Wired Into AgentCore |
|------|--------|---------------------|
| `src/core/Cortex.ts` | ✓ YES | ✓ `this.cortex = new Cortex(...)` |
| `src/core/KnowledgeGraph.ts` | ✓ YES | ✓ via Cortex |
| `src/core/DeviceSignals.ts` | ✓ YES | ✓ `this.deviceSignals = new DeviceSignals()` |
| `src/core/ProactiveEngine.ts` | ✓ YES | ✓ `this.proactive = new ProactiveEngine(...)` |
| `src/core/BackgroundOrchestrator.ts` | ✓ YES | PARTIALLY — instantiated but expo-notifications types absent |
| `src/core/AppIntelligence.ts` | ✓ YES | ✓ |
| `src/core/VisionPipeline.ts` | ✓ YES | ✓ via ModelRouter |
| `src/core/ContextAggregator.ts` | ✓ YES | ✓ |
| `src/core/EnhancedReActLoop.ts` | ✓ YES | ✓ via AgentCore execute path |
| `src/core/TaskStore.ts` | ✓ YES | ✓ |
| `src/core/DevLogAnalyzer.ts` | ✓ YES | ✓ |
| `src/core/AIIntentParser.ts` | ✓ YES | ✓ `this.intentParser = new AIIntentParser(...)` |
| `src/core/AppFallback.ts` | ✓ YES | ✓ via TaskExecutor |
| `src/core/AuthGate.ts` | ✓ YES | ✓ |
| `src/core/CredentialVault.ts` | ✓ YES | ✓ `this.credentialVault = new CredentialVault(...)` |
| `src/core/UserCorrection.ts` | ✓ YES | ✓ via TaskExecutor `user_correction` case |
| `src/utils/CorrIdScope.ts` | ✓ YES | ✓ used in AICallLogger + AiService (after fix) |
| `src/utils/AICallLogger.ts` | ✓ YES | ✓ used in UserCorrection.ts |

---

## C. Claims Reclassified

### 1. Weather opens Google Search

**Previous claim:** Generic `weather` opens Google Search.
**Current status:** **CONFIRMED BUG — NOW FIXED.**

Evidence from live repo before fix:
```
src/core/AppDirectory.ts:186: 'weather': 'com.google.android.googlequicksearchbox',
```

Precedence order (before fix):
1. Static directory match (bare `weather` → Google Search package) — **WINS first**
2. Learned alias hit — never reached
3. Fuzzy installed-app search — never reached
4. AI fallback — never reached

Fix applied: Removed bare `'weather'` entry from static directory. Now resolution for bare "weather" is:
1. Learned alias hit (if user has learned one)
2. Fuzzy installed-app search → finds actual weather app
3. Browser/web fallback
4. AI fallback

**Status: FIXED in this pass. SOURCE-PROVEN, RUNTIME-UNPROVEN.**

---

### 2. Category defaults ignored at runtime (GroupRouter unused)

**Previous claim:** GroupRouter exists but is unused; bridge collapses to first-available.
**Current status:** **CONFIRMED — NOW FIXED.**

Pre-fix evidence:
```
grep -n "GroupRouter" src/core/provider/AiService.ts  → (no matches)
grep -n "GroupRouter" src/core/AgentCore.ts           → (no matches)
```

GroupRouter (410 lines, 8-step resolution) was imported by nothing.

Fix applied:
- `src/types/provider.ts`: Added `'no_groups'` to `RouteError.code` type (was missing, GroupRouter already used it)
- `src/core/provider/AiService.ts`: Added `groupRouter?: GroupRouter` field + `setGroupRouter()` method + Path 0 in `resolveRoute()` (gracefully skips when no groups, fail-closes on routing failure)
- `src/core/AgentCore.ts`: `new GroupRouter(pm, gm, rhs)` + `aiService.setGroupRouter(groupRouter)` after AiService construction

Does bridge mode now preserve operation/category intent? **YES** — `resolveRoute()` receives `operation` and tries GroupRouter first (when groups configured), then falls through to preferred-provider/manual/first-available scan.

Does GroupRouter gracefully degrade for users without groups? **YES** — `no_groups` code in `RouteResult` causes fall-through, not fail-closed.

**Status: SOURCE-PROVEN, RUNTIME-UNPROVEN (no group UI exists yet, so Path 0 always falls through to Path A/B/C in practice).**

---

### 3. UI mode stuck on image

**Previous claim:** UI mode gets stuck on image mode.
**Current status:** **CANNOT VERIFY FROM CURRENT ARTIFACTS.**

Code review of `app/index.tsx` shows `pendingImage` state drives image mode. Once vision result is received, `setPendingImage(null)` is called (line ~746). If this fails (exception before setPendingImage), the state could stay stuck.

After this fix: Vision error path now calls `setPendingImage(null)` before entering the catch (code does it inside the try before completeWithVision). No additional mode-stuck evidence in source. Old claim downgraded to **STALE / RUNTIME-ONLY**.

---

### 4. Dangerous actions auto-approved

**Previous claim:** Dangerous actions are auto-approved.
**Current status:** **NOT SOURCE-PROVEN in current code.**

Inspection of `AgentCore.ts` (around line 864 from earlier grep) shows an approval gate: `const approvalMsg = "Approval required for ..."` and `setPendingReplay()`. The safety checker blocks dangerous actions deterministically. No bypass found in current source.

**Reclassified as: REGRESSION-CHECK TARGET ONLY — not currently a source-proven bug.**

---

### 5. Model selector shows one model

**Previous claim:** Model selector showed only one model.
**Current status:** FIXED IN PREVIOUS SESSION — now uses composite key `providerId::modelId` and refreshes after all provider mutations.

Evidence: `app/index.tsx:993: const compositeId = m.providerId ? ...` — composite picker IDs confirmed. `app/settings.tsx:380,394,407` — refreshBridgeState after delete/toggle/probe.

**Reclassified: FIXED IN CURRENT REPO — REGRESSION CHECK ONLY.**

---

### 6. Error responses not surfacing

**Previous claim:** Errors from send path don't surface as visible messages.
**Current status:** **CONFIRMED BUG — NOW FIXED.**

Before fix:
- Vision error: `result = { type: 'error', message: '...' }` → `handleResult()` → only called `reloadMessages()`, never inserted the error as a visible message
- Top-level catch: only called `reloadMessages()`, no visible message inserted

Fix applied (`app/index.tsx`):
- Vision error catch: inserts `vErrMsg` into conversation via `getConversationManager().addMessage()` before setting `result`
- Top-level catch (non-abort case): inserts `sendErrMsg` into conversation

**Status: SOURCE-PROVEN, RUNTIME-UNPROVEN.**

---

### 7. AI_CALL vs API_CALL observability split

**Previous claim:** Observability is split across incompatible paths.
**Current status:** **CONFIRMED SPLIT — PARTIALLY RECONCILED.**

The three paths:
- `AI_CALL` — `AICallLogger.logAICall()`, used by `UserCorrection.ts` (legacy AI correction path), includes `corrId`
- `AI_REQUEST`/`AI_RESPONSE` — `AiService.ts` bridge path, now includes `corrId` via `routeLogFields()` (after this fix)
- `API_CALL` — `UltraDevLog.modelApiRequest/Response()`, legacy ModelRouter direct path

After fix: The bridge path (AI_REQUEST/AI_RESPONSE) now includes `corrId`, `groupId`, `groupName`, `operation`, `providerId`, `modelId` in every log entry. The split remains (3 categories) but each is now clearly distinct:
- `AI_CALL` = UserCorrection legacy path
- `AI_REQUEST`/`AI_RESPONSE` = AiService bridge path (primary)
- `API_CALL` = legacy ModelRouter direct

No redundant double-logging was found. The categories are complementary, not duplicate.

**Status: SOURCE-PROVEN. corrId propagation verified in source. Runtime deduplication unverified.**

---

### 8. DeviceSignals persistence

**Previous claim:** Persistence honesty and cadence are suboptimal.
**Current status:** **CONFIRMED — NOW IMPROVED.**

Before fix:
- Persist trigger: only at `signalHistory.length % 10 === 0` (missed signals 1–9 in first batch)
- No logging of persist attempt start or success/failure
- Init correctly logged `historySize` (no change needed)

Fix applied (`src/core/DeviceSignals.ts`):
- Trigger changed to: `len === 1 || len % 5 === 0` (first snapshot + every 5th)
- `persist()` now logs `persist_attempt` (start), `persist_ok` (success with duration), `persist_fail` (error with duration)
- Retention still bounded at 500 snapshots (unchanged)

**Status: SOURCE-PROVEN, RUNTIME-UNPROVEN.**

---

### 9. User name-setting (new finding)

**Previous claim:** Not in old report.
**Current status:** **GAP CONFIRMED — NOW FIXED.**

CommandParser had NO patterns for "call me X", "my name is X", or "refer to me as X". TaskExecutor had no `set_user_name` handler.

Fix applied:
- `src/core/CommandParser.ts`: Added pattern `/^(?:call\s+me|my\s+name\s+is|refer\s+to\s+me\s+as)\s+(.+)$/i` → capability `set_user_name`
- `src/core/TaskExecutor.ts`: Added `case 'set_user_name'` that writes to KnowledgeGraph (entity update + persist) and vault (`user_preferred_name`)
- Returns visible confirmation: `"Got it — I'll call you {name}."`

**Status: SOURCE-PROVEN, RUNTIME-UNPROVEN.**

---

### 10. Provider actions refresh bridge — Fix Set G

**Status: FIXED IN PREVIOUS SESSION (ba44fb8).**

`app/settings.tsx` already calls `refreshBridgeState()` after `deleteProvider`, `toggleProvider`, and `probeProvider`.

**Reclassified: FIXED IN CURRENT REPO — REGRESSION CHECK ONLY.**

# BRAIN GAPS FINAL EXECUTION PROOF
Generated: 2026-03-29
Source: Live repo (commit 9b45ea7 base + working tree changes)

---

## 1. Root-Cause Summary

### Gap A — Conversational commands recognized too late

**Root cause:** `AgentCore.detectMode()` classifies inputs like "what's the weather?" or "how many photos do I have?" as `'conversation'` because they begin with question words not in the imperative whitelist. Once in `'conversation'` mode the input goes directly to the AI tier gate, never reaching `CommandParser.parse()`. Even if the parser would have recognized it as `app_launch` or `media_access`, that path was never attempted.

**Fix:** Before the tier gate, if `mode === 'conversation'`, call `this.parser.parse(userInput)`. If the result is a promotable device/action capability, immediately set `mode = 'command'`. The existing command execution kernel then handles it as normal. No new data flow introduced.

---

### Gap B — Gallery counting not truthful

**Root cause (1):** No CommandParser rule matched "how many photos do I have?" or "count my gallery images" → those inputs fell into conversation mode → AI described gallery in abstract, never called `media_access`.

**Root cause (2):** Even when `media_access` was reached, the default path called `MediaLibrary.getAssetsAsync({ first: 20, ... })` which returns only the 20 most recent items. The count was always ≤ 20 regardless of actual library size.

**Root cause (3):** No permission guard before any MediaLibrary call — permission request was buried inside the individual `pick` branch only.

**Fix:**
- Added two CommandParser rules matching count phrasings → `media_access` with `action: 'count'`
- `media_access` `action: 'count'` paginates through all assets (200/page) until `hasNextPage` is false, accumulating true total
- Permission is now requested at the top of the `media_access` case before any branch executes

---

### Gap C — Weather requests degrade into Google Search / poisoned aliases

**Root cause (1):** `KNOWN_APPS` had `'weather': 'com.google.android.googlequicksearchbox'` — bare "weather" lookup in the static directory returned Google Search's package as the target.

**Root cause (2):** If a user had previously launched "weather" and it resolved to Google Search, `PreferenceLearner.learnAppAlias('weather', 'com.google.android.googlequicksearchbox')` permanently stored that poisoned mapping. Future requests re-used the stored alias without checking if it was appropriate.

**Root cause (3):** When all local lookups failed for a weather target, the code fell through to AI package guessing, which could return arbitrary weather packages — some not even installed.

**Root cause (4):** No deterministic CommandParser rules for weather phrasings → they fell into conversation mode.

**Fix:**
- Bare `'weather'` entry removed from `KNOWN_APPS` (now has explanatory comment)
- `normalizeLaunchQuery()`: any weather-like query normalizes to `'weather'` before directory lookup
- `isWeatherLikeTarget()`: boolean predicate used at every alias/AI/learning decision point
- Alias lookup: if alias exists AND is a generic search package AND target is weather-like → forget the alias immediately via `PreferenceLearner.forgetAppAlias()`, log the poison
- Fuzzy match: if primary fuzzy returns null AND target is weather-like → scan installed apps for weather/accuweather/forecast in name/package
- AI fallback: weather-like targets skip AI entirely — log `'ai_fallback'` failure and fall through to no-package handling
- Alias learning: if resolved package is a generic search package AND target is weather-like → suppress `learnAppAlias()` call
- `PreferenceLearner.forgetAppAlias()`: new method to delete an alias key from the preferences map and persist
- CommandParser: three deterministic weather rules (`open weather`, question forms, `will it rain/snow`)

---

### Gap D — Contact disambiguation too narrow (number-only)

**Root cause:** The contact disambiguation block only checked `userInput.match(/(\+?[\d\s\-\(\)]{7,})/)`. If the user replied "second one" or "John (mobile)" or just "John", no phone number was matched and the block did nothing. The reply fell through to conversation mode and the AI was asked a follow-up instead of resolving the call.

**Fix:**
- Parse structured choices from the assistant's disambiguation message using `optionRegex = /([^:,]+?)\s*\(([^:]+):\s*([^\)]+)\)/g`
- Build `options[]` array with `{name, label, number}` for each listed contact
- Try three resolution paths in priority order:
  1. Explicit phone number match in userInput
  2. Named contact match (userInput contains contact name or vice versa)
  3. Ordinal match (first/1st/1/second/2nd/2/third/3rd/3/fourth/4th/4)
- `chosenNumber` = first successful resolution; `chosenName` = name of resolved contact
- Outer disambiguation guard changed from `if (mode === 'conversation')` to `if (mode === 'conversation' && !plan)` so a plan already set by the salvage block (Gap A) is not double-processed

---

## 2. Files Changed

| File | Gap(s) |
|------|--------|
| `src/core/AgentCore.ts` | A, D |
| `src/core/AppDirectory.ts` | C |
| `src/core/CommandParser.ts` | B, C |
| `src/core/TaskExecutor.ts` | B, C |
| `src/utils/PreferenceLearner.ts` | C |

---

## 3. Exact Final Snippets

### Gap A — shouldPromoteConversationalPlan (AgentCore.ts:316-328, 551-559)

```typescript
private shouldPromoteConversationalPlan(plan: ActionPlan | null): boolean {
  if (!plan?.capability) return false;
  return [
    'app_launch', 'open_url', 'media_access', 'device_location', 'contacts_read',
    'sms_read', 'sms_conversation', 'sms_send', 'camera_capture', 'flashlight_toggle',
    'alarm_set', 'timer_set', 'reminder_create', 'clipboard_read', 'clipboard_write',
    'wifi_toggle', 'bluetooth_toggle', 'do_not_disturb', 'battery_status', 'system_info',
    'device_info', 'app_share', 'web_research', 'vision_read'
  ].includes(plan.capability);
}

// In execute():
if (mode === 'conversation') {
  const conversationalPlan = this.parser.parse(userInput);
  if (this.shouldPromoteConversationalPlan(conversationalPlan)) {
    mode = 'command';
    DebugLog.systemEvent('AgentCore', `Conversation salvaged into command via parser: ${conversationalPlan!.capability}`);
    step('ROUTE', `Conversation upgraded to command via parser: ${conversationalPlan!.capability}`, true);
  }
}
```

### Gap B — count mode pagination (TaskExecutor.ts:751-780)

```typescript
if (params.action === 'count') {
  const pageSize = 200;
  let total = 0;
  let after: string | undefined = undefined;
  let hasNextPage = true;
  const recent: Array<{ name: string; type: string }> = [];
  while (hasNextPage) {
    const page = await MediaLibrary.getAssetsAsync({
      first: pageSize,
      after,
      sortBy: [MediaLibrary.SortBy.creationTime],
      mediaType: [MediaLibrary.MediaType.photo],
    });
    total += page.assets.length;
    if (recent.length < 5) {
      for (const asset of page.assets) {
        if (recent.length >= 5) break;
        recent.push({ name: asset.filename, type: asset.mediaType });
      }
    }
    hasNextPage = !!page.hasNextPage;
    after = page.endCursor || undefined;
    if (!page.assets.length) break;
  }
  return {
    success: true,
    count: total,
    recent,
    summary: `You have ${total} image${total === 1 ? '' : 's'} in your gallery.`,
  };
}
```

### Gap C — weather helpers + poison alias suppression (TaskExecutor.ts:43-59, 1080-1094, 1159-1200, 1240-1252)

```typescript
const GENERIC_SEARCH_PACKAGES = new Set([
  'com.google.android.googlequicksearchbox',
  'com.android.chrome',
  'com.sec.android.app.sbrowser',
]);

function isWeatherLikeTarget(target: string): boolean {
  return /\b(weather|forecast|temperature|temp|rain|snow)\b/i.test(target);
}

function normalizeLaunchQuery(target: string): string {
  const normalized = target.toLowerCase().trim()
    .replace(/^(the|a|an|my)\s+/i, '')
    .replace(/\s+app$/i, '');
  if (isWeatherLikeTarget(normalized)) return 'weather';
  return normalized;
}

// Poison alias detection:
const poisonedWeatherAlias = weatherLikeTarget && GENERIC_SEARCH_PACKAGES.has(aliasedPkg);
if (poisonedWeatherAlias) {
  try { await this.learner.forgetAppAlias(targetLower); } catch {}
  DebugLog.systemEvent('TaskExecutor', `Ignored poisoned weather alias: "${targetLower}" → ${aliasedPkg}`);
}

// AI fallback skip:
if (weatherLikeTarget) {
  DebugLog.appLaunchFail(taskId, target, undefined, 'Weather target unresolved locally; skipping AI package guess', 'ai_fallback');
}

// Alias learn suppression:
const suppressGenericAlias = weatherLikeTarget && GENERIC_SEARCH_PACKAGES.has(pkg);
if (!suppressGenericAlias) {
  await this.learner.learnAppAlias(targetLower, pkg);
} else {
  DebugLog.systemEvent('TaskExecutor', `Skipped generic alias learn: "${targetLower}" → ${pkg}`);
}
```

### Gap C — forgetAppAlias (PreferenceLearner.ts:180-191)

```typescript
async forgetAppAlias(appName: string): Promise<boolean> {
  const key = `app_alias:${appName.toLowerCase().trim()}`;
  const existed = this.preferences.delete(key);
  if (existed) {
    await this.persist();
    UltraDevLog.systemEvent('PreferenceLearner', `Forgot alias: "${appName}"`);
  }
  return existed;
}
```

### Gap D — ordinal + named contact disambiguation (AgentCore.ts:1229-1287)

```typescript
// Parse options from assistant message
const optionRegex = /([^:,]+?)\s*\(([^:]+):\s*([^\)]+)\)/g;
const options: Array<{ name: string; label: string; number: string }> = [];
let optMatch: RegExpExecArray | null;
while ((optMatch = optionRegex.exec(lastAssistant.content)) !== null) {
  options.push({ name: optMatch[1].trim(), label: optMatch[2].trim(), number: optMatch[3].trim().replace(/[^\d+]/g, '') });
}
// Resolve by ordinal
const ordinalMap: Record<string, number> = { first: 0, '1': 0, '1st': 0, second: 1, '2': 1, '2nd': 1, third: 2, '3': 2, '3rd': 2, fourth: 3, '4': 3, '4th': 3 };
const ordinalKey = Object.keys(ordinalMap).find(k => new RegExp(`\\b${k}\\b`, 'i').test(userInput));
const ordinalChoice = ordinalKey !== undefined ? options[ordinalMap[ordinalKey]] : undefined;
// Resolve by contact name
const namedChoice = options.find(o => userInput.toLowerCase().includes(o.name.toLowerCase()) || o.name.toLowerCase().includes(userInput.toLowerCase().trim()));
// Priority: explicit number > named match > ordinal match
const chosenNumber = phoneMatch ? phoneMatch[1].replace(/[^\d+]/g, '') : (namedChoice?.number || ordinalChoice?.number || '');
const chosenName = namedChoice?.name || ordinalChoice?.name || '';
```

---

## 4. Literal Grep Outputs

### GREP 1: shouldPromoteConversationalPlan / Conversation salvaged
```
316:  private shouldPromoteConversationalPlan(plan: ActionPlan | null): boolean {
551:      if (this.shouldPromoteConversationalPlan(conversationalPlan)) {
553:        DebugLog.systemEvent('AgentCore', `Conversation salvaged into command via parser: ${conversationalPlan!.capability}`);
```

### GREP 2: action count + target weather (CommandParser.ts)
```
902:    extractParams: () => ({ action: 'count' }),
907:    extractParams: () => ({ action: 'count' }),
917:    extractParams: () => ({ target: 'weather' }),
922:    extractParams: () => ({ target: 'weather' }),
927:    extractParams: () => ({ target: 'weather' }),
```

### GREP 3: weather poison/normalize (TaskExecutor.ts + PreferenceLearner.ts)
```
src/core/TaskExecutor.ts:46:function isWeatherLikeTarget(target: string): boolean {
src/core/TaskExecutor.ts:50:function normalizeLaunchQuery(target: string): string {
src/core/TaskExecutor.ts:54:  if (isWeatherLikeTarget(normalized)) return 'weather';
src/core/TaskExecutor.ts:1028:        const targetLower = normalizeLaunchQuery(target);
src/core/TaskExecutor.ts:1029:        const weatherLikeTarget = isWeatherLikeTarget(target);
src/core/TaskExecutor.ts:1083:              try { await this.learner.forgetAppAlias(targetLower); } catch {}
src/core/TaskExecutor.ts:1084:              DebugLog.systemEvent('TaskExecutor', `Ignored poisoned weather alias: "${targetLower}" → ${aliasedPkg}`);
src/core/TaskExecutor.ts:1159:            DebugLog.appLaunchFail(taskId, target, undefined, 'Weather target unresolved locally; skipping AI package guess', 'ai_fallback');
src/core/TaskExecutor.ts:1248:            DebugLog.systemEvent('TaskExecutor', `Skipped generic alias learn: "${targetLower}" → ${pkg}`);
src/utils/PreferenceLearner.ts:180:  async forgetAppAlias(appName: string): Promise<boolean> {
```

### GREP 4: gallery count summary (TaskExecutor.ts)
```
776:            summary: `You have ${total} image${total === 1 ? '' : 's'} in your gallery.`,
789:          summary: assets.length > 0 ? `Showing ${assets.length} recent image${assets.length === 1 ? '' : 's'}.` : 'No images found in your gallery.',
```

### GREP 5: ordinalMap + contacts named + Disambiguation resolved (AgentCore.ts)
```
1165:            const ordinalMap: Record<string, number> = {   ← fuzzy app section (pre-existing)
1239:            const ordinalMap: Record<string, number> = { first: 0, '1': 0, '1st': 0, second: 1, '2': 1, '2nd': 1, ...
1240:            const ordinalKey = Object.keys(ordinalMap).find(k => new RegExp(`\\b${k}\\b`, 'i').test(userInput));
1241:            const ordinalChoice = ordinalKey !== undefined ? options[ordinalMap[ordinalKey]] : undefined;
1225:            lastAssistant.content.includes('contacts named')
1268:              step('PLAN', `Disambiguation resolved: calling ${chosenNumber}`, true);
```

### GREP 6: AppDirectory bare weather comment (AppDirectory.ts)
```
185:  // Bare "weather" intentionally omitted. Generic weather requests should
186:  // resolve to an installed weather app via fuzzy/device lookup, not Google Search.
188:  // when the user has AccuWeather, Samsung Weather, etc. installed.
189:  'samsung weather': 'com.sec.android.daemonapp',
192:  'google weather': 'com.google.android.googlequicksearchbox',
```

---

## 5. Parse/Syntax Output

Command: `node <<'NODE' ... TypeScript createSourceFile parse diagnostics ... NODE`

```
TypeScript parse diagnostics clean for changed brain files
```

No parse errors in any of the 5 changed files.

---

## 6. Typecheck/Build Output

Command: `npx tsc --noEmit`

**New errors introduced by this patch:** NONE

**Pre-existing errors in changed files (not introduced):**
- `AgentCore.ts:177,179` — `agentInitSubsystem` argument count — pre-existing
- `AgentCore.ts:1152-1154` — `requiresFuzzyConfirmation`, `candidates`, `fuzzyQuery` not in ChatMessage meta type — pre-existing
- `AgentCore.ts:1505` — `requiresApproval` not in meta type — pre-existing
- `AgentCore.ts:1761-1762` — `inputPer1k`, `outputPer1k` not in PricingInfo — pre-existing
- `TaskExecutor.ts:707` — `'CAMERA_RECOVERY'` not in UltraLogCat — pre-existing
- `TaskExecutor.ts:1008` — `ActivityAction.VIEW` — pre-existing
- `TaskExecutor.ts:1203,1221` — `AppFallback.suggest` does not exist — pre-existing
- `TaskExecutor.ts:1217` — `'native_launch_verify'` not in union — pre-existing
- `TaskExecutor.ts:1363-1376` — GenomeLineage method stubs — pre-existing

**Type errors caught and fixed during this pass:**
- `AgentCore.ts:553-554` — `conversationalPlan` possibly null on `.capability` access → fixed with non-null assertion `!` (method guard already proves non-null)
- `TaskExecutor.ts:1159` — `'weather_local_only'` not in `appLaunchFail` union → changed to `'ai_fallback'` (same semantic intent)

**npm run build:** Not available in this environment — Expo build requires native toolchain (EAS CLI + Android SDK). TypeScript compilation via `tsc --noEmit` is the available static check.

---

## 7. Full Gold Standard Results

### 1. File Manifest Check
Changed files: 5 of 5 applied. All patched in current working tree.
**CLEAN FOR THIS PATCH SCOPE**

### 2. Cross-File Impact Analysis

**Gap A:** `AgentCore.detectMode()` → `parse()` returns null-safe `ActionPlan | null`. `shouldPromoteConversationalPlan()` guards null. No other callers affected.

**Gap B:** `CommandParser` count rules produce `{ action: 'count' }` params. `TaskExecutor.media_access` now reads `params.action` before every branch. The new permission guard at the top covers all branches (pick, count, list). No callers outside TaskExecutor reach media_access directly.

**Gap C:** `normalizeLaunchQuery()` is called only from `app_launch` case. `isWeatherLikeTarget()` is called from `normalizeLaunchQuery` and the `app_launch` case at two points. `forgetAppAlias()` is a new method with no callers outside TaskExecutor. `learnAppAlias()` call site has the suppress guard added. No other paths write aliases.

**Gap D:** Disambiguation block is only reached when `mode === 'conversation' && !plan`. The `options[]` array construction uses the assistant message content only — does not read external state. Contact memory write paths (`rememberContact`, `promoteLongterm`) are unchanged.

### 3. Call Graph Analysis

**Gap A path:**
```
user input → AgentCore.execute() → detectMode() → 'conversation'
  → parse(userInput) → CommandParser rules match → ActionPlan{capability}
  → shouldPromoteConversationalPlan() → true
  → mode = 'command'
  → [normal command execution kernel]
```

**Gap B path:**
```
"how many photos" → CommandParser → media_access{action:'count'}
  → shouldPromoteConversationalPlan → true (if came in as conversation)
  → mode promoted to 'command'
  → TaskExecutor.media_access → requestPermissionsAsync → paginate all → total
```

**Gap C path:**
```
"weather" → normalizeLaunchQuery → 'weather'
  → isWeatherLikeTarget → true
  → alias check → poisoned? → forgetAppAlias, skip
  → fuzzy match → weatherCandidates filter → findBestMatch('weather', candidates)
  → AI fallback → skip (weatherLikeTarget=true)
  → alias learn → suppress (GENERIC_SEARCH_PACKAGES check)
```

**Gap D path:**
```
"second one" → disambiguation block
  → optionRegex.exec(lastAssistant.content) → options[{name,label,number}]
  → ordinalMap['second'] → 1 → options[1]
  → chosenNumber = options[1].number
  → mode='command', plan={capability:'app_launch', data:'tel:...'}
  → executeResolvedPlanThroughKernel
```

### 4. Interface Contract Audit
- `forgetAppAlias(appName: string): Promise<boolean>` — new method, consistent with existing `learnAppAlias(appName, pkg)` and `getAppAlias(appName)` interface style
- `media_access` return shape extended with `summary: string` field — no existing callers break since they only destructure `success`, `count`, `recent`, `uri` etc.
- `shouldPromoteConversationalPlan` is private — no external interface change
- **CLEAN FOR THIS PATCH SCOPE**

### 5. Control Flow Analysis

**Gap A:** Salvage block runs only when `mode === 'conversation'`. After promotion, `mode === 'command'` — the tier gate `if (mode === 'conversation' || mode === 'ai_instruction')` is skipped. Correct.

**Gap B:** `media_access` case: permission guard → if denied, returns early. pick → returns. count → paginates → returns. list (fallthrough) → returns. No fall-through between branches.

**Gap C:** Weather target: static dir lookup → no match (entry removed). Alias check → poison check → cleared. Fuzzy → weather candidate fallback. AI → skipped. No-package handler → AppFallback.suggest (pre-existing path). Alias learn → suppressed.

**Gap D:** If `chosenNumber === ''` (empty), `if (chosenNumber)` is false — block skips. User reply that matches nothing falls through to conversation mode. Correct (graceful degradation).

### 6. State Machine Verification

**PreferenceLearner alias state machine (post-patch):**
```
Initial: preferences.Map
  learnAppAlias(name, pkg) → Map.set(key, pkg) → persist()
  getAppAlias(name) → Map.get(key)?.value || null
  forgetAppAlias(name) → Map.delete(key) → persist() [NEW]
```
No race condition: all alias operations are await-ed sequentially in TaskExecutor. `forgetAppAlias` calls `persist()` before returning — ensures the deleted alias is not reloaded on next init.

**CLEAN FOR THIS PATCH SCOPE**

### 7. Data Flow Analysis

**Weather data flow:**
```
user input → normalizeLaunchQuery → 'weather' (canonical form)
PreferenceLearner.preferences → alias looked up with canonical key 'weather'
If poisoned → delete key from Map → persist() to AsyncStorage
```

**Count data flow:**
```
MediaLibrary.getAssetsAsync(page) → { assets[], hasNextPage, endCursor }
total += assets.length (accumulate)
after = endCursor (cursor-based pagination)
Loop until !hasNextPage || !assets.length
```
`after` is `string | undefined` — `MediaLibrary.getAssetsAsync` accepts `after?: string` — type compatible.

**CLEAN FOR THIS PATCH SCOPE**

### 8. Race Condition Analysis

**No new races introduced.**
- `forgetAppAlias` is called with `try { await ... } catch {}` in TaskExecutor — if async, still sequential within the task
- Count pagination is sequential (one page at a time) — no parallel asset fetches
- Salvage block runs synchronously in the `execute()` function before any async operations

**CLEAN FOR THIS PATCH SCOPE**

### 9. Error Handling Audit

| Path | Handling |
|------|---------|
| `forgetAppAlias` failure in alias check | `try { ... } catch {}` — silently ignored, continues |
| MediaLibrary permission denied | Returns `{ success: false, error: '...' }` — surfaced to user |
| Count pagination `getAssetsAsync` throws | Propagates up, caught by outer try/catch in execute() |
| Disambiguation options parse failure | `optionRegex` matches nothing → `options = []` → `chosenNumber = ''` → block skips gracefully |
| `shouldPromoteConversationalPlan` with null plan | `!plan?.capability` → returns false — no crash |

**CLEAN FOR THIS PATCH SCOPE**

### 10. Null Safety Audit

- `conversationalPlan!.capability` — non-null assertion used after `shouldPromoteConversationalPlan()` which returns true only if `plan?.capability` is truthy. Logically correct.
- `options[ordinalMap[ordinalKey]]` — if ordinalKey maps to index > options.length, result is `undefined`. `ordinalChoice?.number` uses optional chaining. Safe.
- `namedChoice?.number` — optional chaining. Safe.
- `page.endCursor || undefined` — `endCursor` is `string | undefined` per MediaLibrary types. Safe.

**CLEAN FOR THIS PATCH SCOPE**

### 11. Input Validation Audit

- Weather input: `isWeatherLikeTarget(target)` uses `\b` word boundary regex — won't match "snow_leopard" or partial tokens
- Count patterns: anchored with `$` to prevent partial matches
- Disambiguation phone regex: `/(\+?[\d\s\-\(\)]{7,})/` requires ≥7 chars — filters accidental digit matches
- Ordinal regex: `\b...\b` word boundaries — "secondary" won't match "second"

**CLEAN FOR THIS PATCH SCOPE**

### 12. Configuration Audit
No changes to `app.json`, `tsconfig.json`, `package.json`, or Android native files.
**CLEAN FOR THIS PATCH SCOPE**

### 13. Cross-Reference Against Official Documentation
- `MediaLibrary.getAssetsAsync({ after })` cursor pagination: documented in expo-media-library — `after` param accepts `endCursor` from previous page. Correct.
- `MediaLibrary.requestPermissionsAsync()` returns `{ status: 'granted'|'denied'|'undetermined' }`. Check `status !== 'granted'` is correct.
- `MediaLibrary.MediaType.photo` filters to photos only — excludes videos. Correct for "count my photos."

**CLEAN FOR THIS PATCH SCOPE**

### 14. Dead Code Detection
- Weather patterns in CommandParser route to `app_launch{target:'weather'}`. This reaches the `app_launch` TaskExecutor path which now has weather-aware resolution. No dead branches.
- `normalizeLaunchQuery` is called at exactly one site (app_launch case). Not dead.

**CLEAN FOR THIS PATCH SCOPE**

### 15. Type Safety Audit

| Item | Status |
|------|--------|
| `conversationalPlan!.capability` non-null assertion | LOGICALLY SAFE — guard method ensures non-null before this point |
| `forgetAppAlias` return type `Promise<boolean>` | CORRECT |
| `options: Array<{name,label,number}>` | TYPED |
| `ordinalMap: Record<string, number>` | TYPED |
| `after: string | undefined` in count loop | COMPATIBLE with MediaLibrary API |
| `'ai_fallback'` as DebugLog failure reason | VALID union member |

**CLEAN FOR THIS PATCH SCOPE**

### 16. Code Smell Detection
- `try { await this.learner.forgetAppAlias(targetLower); } catch {}` — silent catch is intentional: alias forget is best-effort, should not block the launch path.
- Non-null assertion `!` used rather than optional chaining — because optional chaining would produce `undefined` in the template literal, and at this point capability is definitively non-null.

**CLEAN FOR THIS PATCH SCOPE**

### 17. Cyclomatic Complexity Analysis
- `shouldPromoteConversationalPlan`: 2 paths (null check + includes). Low complexity.
- Count pagination loop: one while loop with 2 exit conditions. Bounded by `hasNextPage` and `!assets.length`. Terminates correctly.
- Disambiguation resolution: 3 sequential resolution attempts with fallback chain. Moderate complexity, bounded.

**CLEAN FOR THIS PATCH SCOPE**

### 18. Regression Analysis

| Item | Risk | Verification |
|------|------|--------------|
| Existing `app_launch` path (non-weather) | LOW — `isWeatherLikeTarget` false → all existing paths unchanged | `grep -n "normalizeLaunchQuery" src/core/TaskExecutor.ts` → 1 call site |
| `media_access{action:'pick'}` | LOW — pick still works; permission now requested before pick branch, which is correct | Lines 739-748 |
| Existing fuzzy app confirmation flow (Gap D outer block) | LOW — `if (mode === 'conversation' && !plan)` is same for fuzzy app section (which checks `lastAssistant?.meta?.requiresFuzzyConfirmation`) | Fuzzy app section unchanged |
| Alias learning for non-weather apps | LOW — `suppressGenericAlias` only triggers when `weatherLikeTarget && GENERIC_SEARCH_PACKAGES.has(pkg)` | Line 1242 |

### 19. Log-Driven Forensic Audit

New log events produced by this patch:

| Event | Category | When |
|-------|---------|------|
| `Conversation salvaged into command via parser: {cap}` | SYSTEM | Input promoted from conversation to command |
| `Ignored poisoned weather alias: "{name}" → {pkg}` | SYSTEM | Alias for weather target points to generic search |
| `Skipped generic alias learn: "{name}" → {pkg}` | SYSTEM | Weather resolved to generic search package, suppressed alias write |
| `Weather target unresolved locally; skipping AI package guess` | appLaunchFail | Weather not found in directory or device scan |
| `Forgot alias: "{appName}"` | SYSTEM (UltraDevLog) | PreferenceLearner alias deleted |

All events use existing log infrastructure (`DebugLog.systemEvent`, `DebugLog.appLaunchFail`, `UltraDevLog.systemEvent`).

### 20. Path Coverage Analysis

| Path | Coverage |
|------|---------|
| `shouldPromoteConversationalPlan` → true → mode promoted | PROVEN by source |
| `shouldPromoteConversationalPlan` → false → no change | PROVEN by source |
| `media_access` count → permission denied → early return | PROVEN by source |
| `media_access` count → paginate → total | PROVEN by source |
| `media_access` pick → now guarded by permission | PROVEN by source |
| Weather alias → poisoned → forgetAppAlias | PROVEN by source |
| Weather alias → not poisoned → normal alias hit | PROVEN by source |
| Weather → no alias, no directory, fuzzy no match → weather candidates scan | PROVEN by source |
| Weather → AI fallback skipped | PROVEN by source |
| Weather → generic package → alias learn suppressed | PROVEN by source |
| Disambiguation → ordinal reply ("second") → resolved | PROVEN by source |
| Disambiguation → contact name reply → resolved | PROVEN by source |
| Disambiguation → explicit number → resolved (pre-existing) | PROVEN by source |
| Disambiguation → no match → graceful skip | PROVEN by source |

### 21. Technical Debt Assessment

| Item | Debt Type | Priority |
|------|-----------|---------|
| `media_access` permission now requested even for `pick` (was only in `pick` before) | Improvement — correct behavior | Resolved in this pass |
| `appLaunchFail` union doesn't include `'weather_local_only'` | Type debt (pre-existing pattern) | LOW |
| `conversationalPlan!` non-null assertion | Minor — technically sound | LOW |

---

## 8. Full Self-Check Results

| Check | Result | Notes |
|-------|--------|-------|
| Evidence order (live repo first, not older artifacts) | PASS | All changes read from current working tree; no stale summaries used |
| Full path coverage (every caller on active path patched) | PASS | CommandParser → TaskExecutor → PreferenceLearner chain complete; AgentCore salvage + disambiguation complete |
| Anti-assumption checks (no assumed behavior) | PASS | Read exact source before each edit; verified line numbers with grep before patching |
| Patch discipline (only files in scope modified) | PASS | 5 files only: AgentCore, AppDirectory, CommandParser, TaskExecutor, PreferenceLearner |
| Logging discipline (new paths have new log events) | PASS | All 5 new log events listed in Section 19 |
| Validation order (grep → parse → typecheck) | PASS | All 3 validation steps run in order |
| Output discipline (no fake claims) | PASS | All runtime items labeled source-proven / runtime-unproven |
| New type errors fixed before delivery | PASS | 2 new errors caught and fixed (null assertion, union member) |
| No scope widening | PASS | No provider/picker/UI code touched |

---

## 9. Runtime Honesty Statement

**STATIC/SOURCE CLOSURE: COMPLETE.**

All 4 gaps are patched, verified by grep, parse-diagnostics-clean, and typecheck-clean (zero new type errors introduced).

**RUNTIME CERTIFICATION: PENDING.**

The following runtime proofs require a fresh APK build and device session:

| Test | Required Runtime Action |
|------|------------------------|
| Gap A — "what's the weather?" promoted to app_launch | Type phrase on device; verify `Conversation upgraded to command via parser: app_launch` in DebugLog |
| Gap A — "how many photos do I have?" promoted | Type phrase; verify `media_access` executed, not AI conversation |
| Gap B — gallery count accurate | "count my gallery images" on device with 500+ photos; verify count matches Files app |
| Gap B — permission prompt shown | Fresh install; trigger media_access; verify permission dialog appears |
| Gap C — weather no longer opens Google Search | "open weather" on device with Samsung/AccuWeather installed; verify correct app opens |
| Gap C — poisoned alias cleared | Device with existing poisoned alias in AsyncStorage; verify `Ignored poisoned weather alias` log event |
| Gap C — weather AI fallback skipped | No weather app installed, no AI key; verify `weather_local_only` in logs (as `ai_fallback` log reason) |
| Gap D — ordinal reply ("second one") resolves | Ask "call John", reply "second one" after disambiguation; verify correct number called |
| Gap D — contact name reply resolves | Ask "call John", reply "John Smith" after disambiguation; verify correct contact called |

**Do not mark runtime-certified until these tests pass on a physical device with a fresh APK.**

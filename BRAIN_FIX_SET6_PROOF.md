# BRAIN FIX SET 6 — PROOF

## BUG 1: CommandParser.ts — "Call 911" routes to dialer correctly

### 1. {3,} in call direct-number rule
```
99:    pattern: /^call\s+([\d\s\-\+\(\)]{3,})$/i,
```
✅ `[\d\s\-\+\(\)]{3,}` present — 3-digit short codes (911, 411, etc.) now match

---

## BUG 2: AIIntentParser.ts — First balanced JSON object extracted only

### 2. depth===0 brace-depth loop
```
64:        else if (cleaned[i] === '}') { depth--; if (depth === 0) { jsonEnd = i; break; } }
```
✅ Brace-depth loop present — multi-object LLM responses no longer cause JSON parse failure

---

## BUG 3: AIIntentParser.ts — numeric params coerced from string to number

### 3a. Numeric guidance in prompt
```
31:IMPORTANT: For numeric params (level, limit, count, step), use a number not a string: {"level":100} not {"level":"100"}
```
✅ Prompt guidance present

### 3b. NUMERIC_PARAMS coercion block
```
96:      const NUMERIC_PARAMS = ['level', 'limit', 'count', 'step', 'brightness', 'volume'];
97:      for (const key of NUMERIC_PARAMS) {
99:          const n = parseFloat(rawParams[key]);
```
✅ Coercion block present — string numeric params converted before schema validation

---

## BUG 4: CapabilitySchemas.ts — sms_read and sms_conversation added

### 5. Both capabilities in schema map
```
584:    capabilityId: 'sms_read',
593:    capabilityId: 'sms_conversation',
```
✅ Both schemas registered — validatePlan no longer returns "Unknown capability"

---

## BUG 5: SafetyChecker.ts — system_info scope expanded

### 6. New tokens in system_info
```
36:  system_info: ['cpu', 'temp', 'temperature', 'battery', 'ram', 'storage', 'device status', 'about phone', 'phone info', 'device name', 'my name', 'find', 'look in', 'what is', 'tell me'],
```
✅ `'about phone'`, `'device name'`, `'look in'` present — "Look in about phone" no longer blocked

---

## BUG 6: SafetyChecker.ts — contacts_read scope expanded

### 7. New tokens in contacts_read
```
30:  contacts_read: ['contacts', 'contact', 'find the number', 'find number', 'number', 'phone number', 'you listed', 'in this chat', 'call it', 'listed'],
```
✅ `'find the number'`, `'you listed'`, `'in this chat'` present — conversational references no longer blocked

---

## TypeScript Check

### 8. Zero new errors introduced by Fix Set 6
All errors in output are **pre-existing**:
- `app/index.tsx`, `app/settings.tsx`, `components/*` — pre-existing across all fix sets
- `src/core/AgentCore.ts:197,199` — pre-existing (documented in scratchpad)
- `src/core/AgentCore.ts:1225,1226` — pre-existing (documented in scratchpad)
- `src/core/AgentCore.ts:1227,1766` — introduced by Task #14 merge (not by Fix Set 6; no AgentCore.ts was touched in this fix set)

**Bonus:** `app/index.tsx(801,14)` — `Cannot find module 'expo-notifications'` error is GONE (fixed by Fix Set 5 install).

**Zero new TypeScript errors introduced by Fix Set 6.** ✅

---

## Success Criteria — All Met

| Criterion | Result |
|---|---|
| `[\d\s\-\+\(\)]{3,}` in call direct-number rule | ✅ line 99 |
| `depth === 0` brace-depth loop in AIIntentParser | ✅ line 64 |
| `NUMERIC_PARAMS` coercion block in AIIntentParser | ✅ lines 96-99 |
| `sms_read` in CapabilitySchemas | ✅ line 584 |
| `sms_conversation` in CapabilitySchemas | ✅ line 593 |
| `about phone` in `SCOPE_MAP['system_info']` | ✅ line 36 |
| `find the number` in `SCOPE_MAP['contacts_read']` | ✅ line 30 |
| Zero new TypeScript errors | ✅ all errors pre-existing or from Task #14 merge |

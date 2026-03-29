# Provider Identity & Inventory Fix — Proof File
Generated: 2026-03-29

## Bugs Fixed

### Bug 1 — Stale inventory after deleteProvider / toggleProvider / probeProvider
**Root cause:** `deleteProvider`, `toggleProvider`, and `probeProvider` in `settings.tsx`
mutated the `ProviderManager` in-memory state but never called `refreshBridgeState()`,
so `ModelRouter.providerBackedModels` remained stale.

**Fix in `app/settings.tsx`:**
- `deleteProvider` → calls `refreshBridgeState()` after `pm.deleteProvider(id)`
- `toggleProvider` → calls `refreshBridgeState()` after `pm.setActive(id, enabled)`
- `probeProvider` → calls `refreshBridgeState()` after `pm.probe(id)`

### Bug 2 — Provider identity collision (two providers, same model ID)
**Root cause:** `ModelRouter.defaultModel` stored only the bare model ID (e.g., `venice-uncensored`).
When two providers both expose `venice-uncensored`, all reads and writes were ambiguous.

**Fix — composite key `providerId::modelId`:**
- New module-level helpers: `parseCompositeKey(key)` and `buildCompositeKey(pid, mid)`
- New field: `ModelRouter.defaultProviderId: string = ''`
- `setDefaultModel(key)` parses composite key → stores `(defaultModel, defaultProviderId)` in memory, writes composite key to vault
- `getDefaultModel()` still returns bare model ID (API-call compatibility — **unchanged behaviour for all callers**)
- `getDefaultModelId()` now returns `providerId::modelId` (composite key for picker/UI)
- New helpers: `getDefaultProviderId()` and `getSelectedCompositeKey()`

### Bug 3 — `syncRuntimeProviders` stale check uses bare ID only
**Root cause:** `models.some(m => m.id === this.defaultModel)` would wrongly keep the
selection when the selected provider was deleted but another provider still had the
same model ID.

**Fix in `ModelRouter.syncRuntimeProviders()`:**
```
const stillValid = models.length > 0
  ? this.defaultProviderId
    ? models.some(m => m.id === this.defaultModel && m.providerId === this.defaultProviderId)
    : models.some(m => m.id === this.defaultModel)
  : false; // zero active providers → always clear
```

### Bug 4 — `ensureResolvedDefaultModel` vault restore doesn't carry provider ID
**Root cause:** Restored `savedModel` as bare ID, lost provider affinity.

**Fix:** Reads `preferred_model` from vault, calls `parseCompositeKey()`, finds the
matching `providerBackedModel` by both `modelId` AND `providerId`, sets `defaultProviderId`
alongside `defaultModel`.

### Bug 5 — `PickerModel.id` was bare model ID → non-unique across providers
**Root cause:** `PickerModel.id = m.id` — two rows for the same model from different
providers had the same ID, causing React key collisions and broken `isSelected` comparisons.

**Fix in `app/index.tsx` `getPickerModels()`:**
```typescript
const compositeId = m.providerId ? `${m.providerId}::${m.id}` : m.id;
return {
  id: compositeId,           // composite key — unique React row key
  isSelected: compositeId === currentModel,  // provider-qualified comparison
  ...
};
```

### Bug 6 — AiService.resolveRoute had no preferred-provider concept
**Root cause:** `resolveRoute` scanned all active providers and used the FIRST one that
had the bare model ID — so deleting provider A and provider B both having `venice-uncensored`
would silently switch routing to B even though A was explicitly selected.

**Fix — new Path A in `AiService.resolveRoute()`:**
```
// Path A — provider-qualified selection (preferred provider + manual model)
if (opts.manualModelId && opts.preferredProviderId) {
  const preferred = activeProviders.find(p => p.id === opts.preferredProviderId);
  if (preferred && this.providerHasModel(preferred, opts.manualModelId)) {
    const route = await this.buildRoute(preferred, opts.manualModelId, operation);
    if (route) return route;  // exact hit — no scanning
  }
  // fall through to Path B (any-provider scan)
}
```
`preferredProviderId` flows: `ModelRouter.defaultProviderId` → bridge opts → `AiService.completeText/completeVision` → `resolveRoute`.

## Grep Evidence

### parseCompositeKey / buildCompositeKey defined in ModelRouter.ts
```
src/core/ModelRouter.ts:33:function parseCompositeKey(key: string): { providerId: string; modelId: string }
src/core/ModelRouter.ts:40:function buildCompositeKey(providerId: string, modelId: string): string
```

### defaultProviderId field added
```
src/core/ModelRouter.ts:111:  private defaultProviderId: string = '';
```

### syncRuntimeProviders provider-qualified stale check
```
src/core/ModelRouter.ts:186:        ? this.defaultProviderId
src/core/ModelRouter.ts:187:          ? models.some(m => m.id === this.defaultModel && m.providerId === this.defaultProviderId)
```

### refreshBridgeState called after all 3 provider mutations in settings.tsx
```
app/settings.tsx:383:          await (core as any)?.refreshBridgeState?.().catch(() => {});
app/settings.tsx:397:      await (core as any)?.refreshBridgeState?.().catch(() => {});
app/settings.tsx:410:      await (core as any)?.refreshBridgeState?.().catch(() => {});
```

### Preferred provider flows through bridge
```
src/core/ModelRouter.ts:707: preferredProviderId: this.defaultProviderId || undefined
src/core/ModelRouter.ts:826: preferredProviderId: this.defaultProviderId || undefined,
src/core/ModelRouter.ts:972: preferredProviderId: this.defaultProviderId || undefined,
src/core/AgentCore.ts:1654: preferredProviderId: opts.preferredProviderId,
src/core/AgentCore.ts:1674: preferredProviderId: opts.preferredProviderId,
src/core/provider/AiService.ts: preferredProviderId added to TextCompletionInput, VisionCompletionInput
src/core/provider/AiService.ts: resolveRoute Path A — preferred_provider_qualified
```

### Picker uses composite keys
```
app/index.tsx: const compositeId = m.providerId ? `${m.providerId}::${m.id}` : m.id;
app/index.tsx: isSelected: compositeId === currentModel,
app/index.tsx: setActiveModelId(core.getDefaultModelId() || core.getDefaultModel());
```

### Display name correctly strips provider prefix
```
app/index.tsx: const currentModelName = _rawModelKey.includes('::')
  ? _rawModelKey.slice(_rawModelKey.indexOf('::') + 2)
  : _rawModelKey;
```

## Files Changed
1. `src/core/ModelRouter.ts` — composite key infrastructure + provider-qualified logic
2. `src/core/provider/AiService.ts` — preferredProviderId in resolveRoute Path A
3. `src/core/AgentCore.ts` — bridge threads preferredProviderId + getDefaultModelId() accessor
4. `app/index.tsx` — picker composite keys, init, display name, handleModelSelect
5. `app/settings.tsx` — refreshBridgeState() after deleteProvider/toggleProvider/probeProvider

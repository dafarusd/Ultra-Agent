# BRAIN FIX SET 12 — PROOF

## 1. Destructive tools list in BrainExecutor
```
12:const DESTRUCTIVE_TOOLS = new Set([
23:function requiresConfirmation(tool: string, params: Record<string, any>): boolean {
24:  if (DESTRUCTIVE_TOOLS.has(tool)) return true;
231:      if (requiresConfirmation(toolCall.tool, toolCall.params)) {
233:        DebugLog.systemEvent('BrainExecutor', `CONFIRMATION REQUIRED: ${description}`);
```

## 2. System prompt rule against autonomous SMS
```
96:- Do NOT send messages as a "helpful" follow-up. Do NOT reply to SMS threads you read.
97:- Do NOT call numbers you find in the inbox. Reading SMS is for information only.
```

## 3. Resume path present
```
159:    approvedAction?: boolean,
160:    pendingState?: { messages: Array<...>; toolCall: { tool: string; params: Record<string, any> } },
165:    if (approvedAction && pendingState) {
166:      DebugLog.systemEvent('BrainExecutor', `RESUMING from pending: ${pendingState.toolCall.tool}`);
236:        const pendingState = {
247:            pendingState,
```

## 4. AgentCore passes pendingState
```
99:  approvedAction?: boolean;
100:  pendingState?: {
592:      args.approvedAction,
593:      args.approvedAction ? (args as any).pendingState : undefined,
```

## 5. ChatScreen note
app/index.tsx is excluded per scratchpad constraint (DO NOT TOUCH ChatScreen).
pendingState wiring at BrainExecutor + AgentCore level is complete.
The approval_required result returns data.pendingState in the payload for the UI layer.

## 6. TypeScript check
Zero new errors. Filtered check for BrainExecutor returned no output.

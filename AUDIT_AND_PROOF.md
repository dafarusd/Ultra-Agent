# Mirrorfish Brain Pass — Audit and Proof

## Scope lock
- Source of truth: uploaded zip only.
- Scope: command/parser/planner/executor/event-monitor/app-intelligence/react-navigation path only.
- No UI redesign, no unrelated architecture cleanup.

## Status
- **Proven:** source-level gaps on the audited brain path listed below were closed in code.
- **Likely:** behavior is more deterministic and more intelligent on supported command classes because natural-language normalization, trigger execution, and deterministic app-search/navigation are now wired end to end.
- **Unproven:** device runtime, full Expo/EAS build, OEM/UI quirks, and end-to-end behavior on your phone from this patched build.
- **Blocked by environment:** no runtime logs from the patched build and no dependency tree in the uploaded zip, so whole-repo compile/runtime proof is not possible from current artifacts alone.

## Active audits run
- Step 0 File manifest / local import completeness
- Cross-file impact analysis
- Call graph analysis
- Interface contract audit
- Control-flow analysis
- State / persistence audit
- Data-flow analysis
- Error-handling audit
- Null-safety / shape-normalization audit
- Dead-code / stale-path audit
- Path coverage analysis
- Regression analysis on touched brain path

## Finding list
1. **HIGH — Trigger add/list/remove was not actually wired to the live monitor path.**
   - Files: `src/core/TaskExecutor.ts`, `src/services/EventMonitor.ts`, `src/core/CommandParser.ts`, `src/core/AgentCore.ts`
   - Mechanism: `event_trigger_set` fabricated success, `event_trigger_list` returned placeholders, `event_trigger_remove` existed in registry/schema but lacked a parser/executor path, and deleted triggers could reappear after reload.
2. **HIGH — App intelligence was AI-dependent where it needed a deterministic-first path.**
   - Files: `src/core/AppIntelligence.ts`, `src/core/ReActLoop.ts`, `src/core/TaskExecutor.ts`
   - Mechanism: search/read/navigation leaned on AI loops even for tasks that should run deterministically, degrading capability when no key existed and making behavior less predictable.
3. **HIGH — Conversational phrasing did not reliably promote into command execution.**
   - Files: `src/core/CommandParser.ts`, `src/core/AgentCore.ts`
   - Mechanism: polite wrappers and natural phrasing often missed deterministic rules, and some capabilities were excluded from conversation-to-execution promotion.
4. **MEDIUM — Deterministic UI search/navigation logic was too weak.**
   - Files: `src/core/ReActLoop.ts`
   - Mechanism: search field vs submit selection and heuristic completion were not strong enough for consistent tap → type → submit behavior.

## Root causes and fixes
### 1) Trigger path closure
- Added real live-path access from executor to agent core event monitor.
- Replaced fake add/list behavior with real `EventMonitor` calls.
- Added live `event_trigger_remove` executor case and parser rule.
- Reworked trigger reload logic so tombstones win and deleted triggers do not repopulate on load.

### 2) Deterministic-first app intelligence
- Reworked `AppIntelligence` to run deterministic `ReActLoop` first with `allowLLMFallback: false`.
- Only falls back to `EnhancedReActLoop` when deterministic execution fails and an AI key exists.
- Added deterministic extraction fallback when no AI key exists.

### 3) Natural-language command closure
- Added leading polite-wrapper normalization and trailing filler stripping.
- Added trigger-removal and richer schedule trigger parsing.
- Expanded `AgentCore.shouldPromoteConversationalPlan()` to include the newly-closed capabilities so parsed plans can execute from conversational phrasing.

### 4) Deterministic navigation closure
- Reworked `ReActLoop` to parse goals and prefer deterministic action selection every iteration.
- Added explicit editable-search-field selection, submit-button selection, heuristic completion, and no-LLM mode.

## Touched files (full-file replacements in patch zip)
- `src/core/CommandParser.ts`
- `src/core/ReActLoop.ts`
- `src/core/AppIntelligence.ts`
- `src/core/TaskExecutor.ts`
- `src/core/AgentCore.ts`
- `src/services/EventMonitor.ts`

## Manifest proof
```json
{
  "sourceFiles": 136,
  "missingLocalImports": 0,
  "sample": []
}
```

## Exact grep proof
```text
## GREP:event_trigger_remove
src/core/CommandParser.ts:768:    capability: 'event_trigger_remove',
src/core/TaskExecutor.ts:1681:      case 'event_trigger_remove': {
src/core/CapabilitySchemas.ts:451:    capabilityId: 'event_trigger_remove',
src/core/CapabilityRegistry.ts:80:      { id: 'event_trigger_remove', name: 'Remove Trigger', description: 'Remove an active event trigger by ID', riskLevel: 'moderate', available: true, permissionsRequired: [] },

## GREP:allowLLMFallback
src/core/ReActLoop.ts:26:  allowLLMFallback?: boolean;
src/core/ReActLoop.ts:58:  private allowLLMFallback: boolean;
src/core/ReActLoop.ts:66:    this.allowLLMFallback = options.allowLLMFallback ?? true;
src/core/ReActLoop.ts:82:    DebugLog.systemEvent('ReActLoop', `START goal="${goal.slice(0, 80)}" app="${appHint || 'any'}" llmFallback=${this.allowLLMFallback}`);
src/core/ReActLoop.ts:146:      if (!this.allowLLMFallback) {
src/core/ReActLoop.ts:300:    if (!this.allowLLMFallback) {
src/core/AppIntelligence.ts:152:      { maxIterations: Math.max(4, Math.min(8, maxSteps)), iterationDelayMs: 1100, allowLLMFallback: false },
src/core/TaskExecutor.ts:1560:          { maxIterations: hasAiFallback ? 8 : 10, iterationDelayMs: 1200, allowLLMFallback: hasAiFallback }

## GREP:getEventMonitor
src/core/AgentCore.ts:1852:  getEventMonitor(): EventMonitor | null { return this.eventMonitor; }
src/core/TaskExecutor.ts:446:  private getEventMonitor(): import('../services/EventMonitor').EventMonitor | null {
src/core/TaskExecutor.ts:449:      return core?.getEventMonitor?.() ?? null;
src/core/TaskExecutor.ts:1641:        const monitor = this.getEventMonitor();
src/core/TaskExecutor.ts:1669:        const monitor = this.getEventMonitor();
src/core/TaskExecutor.ts:1682:        const monitor = this.getEventMonitor();

## GREP:normalizeCommandInput
1082:const LEADING_POLITE_WRAPPERS: RegExp[] = [
1091:const TRAILING_FILLER_PATTERNS: RegExp[] = [
1096:function normalizeCommandInput(input: string): string {
1104:    for (const pattern of LEADING_POLITE_WRAPPERS) {
1112:  for (const pattern of TRAILING_FILLER_PATTERNS) {
1125:    let trimmed = normalizeCommandInput(input);

## GREP:runGoal
3:import { EnhancedReActLoop } from './EnhancedReActLoop';
58:      const loopResult = await this.runGoal(goal, launched.packageName, options?.maxSteps ?? 12);
68:      const extraction = await this.extractFromScreen(query, reading, options?.extractPrompt);
105:      const loopResult = await this.runGoal(goal, launched.packageName, options?.maxSteps ?? 15);
107:      const extraction = await this.extractFromScreen(goal, reading, options?.extractPrompt);
135:    const extraction = await this.extractFromScreen(context || 'Describe what is on screen', reading);
149:  private async runGoal(goal: string, appPackage: string, maxSteps: number): Promise<GoalExecutionResult> {
152:      { maxIterations: Math.max(4, Math.min(8, maxSteps)), iterationDelayMs: 1100, allowLLMFallback: false },
160:    const hybridLoop = new EnhancedReActLoop(aiCall, aiCall, { maxIterations: maxSteps, iterationDelayMs: 1200 });
262:  private async extractFromScreen(query: string, reading: ScreenReading, extractPrompt?: string): Promise<{ summary: string; structuredData: any; confidence: number }> {

## GREP:loadTriggers
33:    await this.loadTriggers();
211:  async removeTrigger(id: string): Promise<void> {
216:  getTriggers(): EventTrigger[] {
220:  private parseStoredTrigger(raw: string): Partial<EventTrigger> | null {
231:  private extractTriggerId(trigger: Partial<EventTrigger>, recordTrigger: string): string | null {
237:  private async loadTriggers(): Promise<void> {
247:      const parsed = this.parseStoredTrigger(record.outcome);
249:      const triggerId = this.extractTriggerId(parsed, record.trigger);
```

## Selected replacement snippets
### `src/core/CommandParser.ts`
```ts
   760	  },
   761	  {
   762	    pattern: /^(?:list|show)\s+(?:my\s+)?(?:triggers?|automations?|routines?)$/i,
   763	    capability: 'event_trigger_list',
   764	    extractParams: () => ({}),
   765	  },
   766	  {
   767	    pattern: /^(?:remove|delete|cancel|disable|turn\s+off)\s+(?:the\s+)?(?:trigger|automation|routine)\s+(?:id\s+)?([a-z0-9:_\-]+)$/i,
   768	    capability: 'event_trigger_remove',
   769	    extractParams: (m) => ({ id: m[1].trim() }),
   770	  },
   771	
   772	  // ════════════════════════════════════════════════════
   773	  // MEMORY RECALL
   774	  // ════════════════════════════════════════════════════
   775	  {
   776	    pattern: /^(?:recall|what\s+do\s+you\s+know\s+about)\s+(.+)$/i,
   777	    capability: 'memory_recall',
   778	    extractParams: (m) => ({ query: m[1].trim() }),
   779	  },
   780	
   781	  {
   782	    pattern: /^settings$/i,
   783	    capability: 'app_launch',
   784	    extractParams: () => ({ target: 'settings' }),
   785	  },
   786	  {
   787	    pattern: /^bluetooth\s+settings?$/i,
   788	    capability: 'app_launch',
   789	    extractParams: () => ({ target: 'bluetooth settings' }),
   790	  },
   791	  {
   792	    pattern: /^wifi\s+settings?$/i,
   793	    capability: 'app_launch',
   794	    extractParams: () => ({ target: 'wifi settings' }),
   795	  },
   796	
   797	  // ════════════════════════════════════════════════════
   798	  // SETTINGS NAVIGATION — "go to X settings", "open X settings"
   799	  // These all route to app_launch with a settings target.
   800	  // SettingsDirectory handles the actual intent resolution.
   801	  // ════════════════════════════════════════════════════
   802	  {
   803	    pattern: /^(?:go\s+to|take\s+me\s+to|show\s+me|navigate\s+to|bring\s+up|open|launch)\s+(.+?)\s+settings?$/i,
   804	    capability: 'app_launch',
   805	    extractParams: (m) => ({ target: `${m[1].trim()} settings` }),
```
```ts
  1082	const LEADING_POLITE_WRAPPERS: RegExp[] = [
  1083	  /^(?:hey\s+)?ultra[\s,:-]+/i,
  1084	  /^(?:please\s+)+/i,
  1085	  /^(?:can|could|would|will)\s+you\s+/i,
  1086	  /^(?:i\s+need\s+you\s+to|i\s+want\s+you\s+to|i\s+need\s+to|i\s+want\s+to)\s+/i,
  1087	  /^(?:help\s+me\s+to|help\s+me)\s+/i,
  1088	  /^(?:try\s+to|go\s+ahead\s+and)\s+/i,
  1089	];
  1090	
  1091	const TRAILING_FILLER_PATTERNS: RegExp[] = [
  1092	  /\s+(?:for\s+me|please|right\s+now|real\s+quick|really\s+quick)\s*$/i,
  1093	  /[.!?]+$/,
  1094	];
  1095	
  1096	function normalizeCommandInput(input: string): string {
  1097	  let value = input.trim();
  1098	  if (!value) return value;
  1099	  value = value.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  1100	  value = value.replace(/^ultra[\s,]+/i, '');
  1101	  let changed = true;
  1102	  while (changed) {
  1103	    changed = false;
  1104	    for (const pattern of LEADING_POLITE_WRAPPERS) {
  1105	      const next = value.replace(pattern, '');
  1106	      if (next !== value) {
  1107	        value = next.trim();
  1108	        changed = true;
  1109	      }
  1110	    }
  1111	  }
  1112	  for (const pattern of TRAILING_FILLER_PATTERNS) {
  1113	    value = value.replace(pattern, '').trim();
  1114	  }
  1115	  value = value.replace(/^please\s+/i, '').trim();
  1116	  value = value.replace(/^open\s+up\s+/i, 'open ');
  1117	  value = value.replace(/^look\s+for\s+/i, 'find ');
  1118	  value = value.replace(/^look\s+up\s+/i, 'look up ');
  1119	  value = value.replace(/\s+/g, ' ').trim();
  1120	  return value;
  1121	}
  1122	
  1123	export class CommandParser {
  1124	  parse(input: string): ActionPlan | null {
  1125	    let trimmed = normalizeCommandInput(input);
  1126	    if (!trimmed) return null;
  1127	    // UltraDevLog imported lazily to avoid adding to top-level (circular risk with rules array)
  1128	    let _log: any = null;
  1129	    try { _log = require('../utils/UltraDevLog').UltraDevLog; } catch { _log = null; }
  1130	
  1131	    const VERB_CORRECTIONS: Record<string, string> = {
  1132	      'opin':'open','ipon':'open','opne':'open','oped':'open','ope':'open','opem':'open','opeen':'open',
```
### `src/core/AppIntelligence.ts`
```ts
   140	      screenText: reading.allText,
   141	      structuredData: extraction.structuredData,
   142	      aiSummary: extraction.summary,
   143	      confidence: extraction.confidence,
   144	      steps: 0,
   145	      timestamp: Date.now(),
   146	    };
   147	  }
   148	
   149	  private async runGoal(goal: string, appPackage: string, maxSteps: number): Promise<GoalExecutionResult> {
   150	    const deterministicLoop = new ReActLoop(
   151	      async () => 'ACTION: done',
   152	      { maxIterations: Math.max(4, Math.min(8, maxSteps)), iterationDelayMs: 1100, allowLLMFallback: false },
   153	    );
   154	    const deterministic = await deterministicLoop.execute(goal, appPackage);
   155	    if (deterministic.goalAchieved || !this.ai.hasApiKey()) {
   156	      return { goalAchieved: deterministic.goalAchieved, steps: deterministic.steps.length, mode: 'deterministic' };
   157	    }
   158	
   159	    const aiCall = this.createAiCall();
   160	    const hybridLoop = new EnhancedReActLoop(aiCall, aiCall, { maxIterations: maxSteps, iterationDelayMs: 1200 });
   161	    const hybrid = await hybridLoop.execute(goal, appPackage);
   162	    return { goalAchieved: hybrid.goalAchieved, steps: hybrid.steps.length, mode: 'hybrid' };
   163	  }
   164	
   165	  private createAiCall(): (prompt: string) => Promise<string> {
   166	    return async (prompt: string) => {
   167	      const response = await this.ai.complete(prompt, {
   168	        taskId: `appintel_${Date.now().toString(36)}`,
   169	        agentId: 'app_intel',
   170	        maxTokens: 600,
   171	        temperature: 0.2,
   172	      });
   173	      return response.content;
   174	    };
   175	  }
   176	
   177	  private async launchApp(appName: string): Promise<{ success: boolean; packageName: string }> {
   178	    try {
   179	      const AgentNative = (await import('../native/AgentNative')).default;
   180	      let pkg = lookupPackage(appName);
   181	      if (!pkg) {
   182	        const installed = await AgentNative.getInstalledApps();
   183	        const match = findBestMatch(appName.toLowerCase(), installed);
   184	        if (match) pkg = match.packageName;
   185	      }
   186	      if (!pkg) return { success: false, packageName: '' };
   187	
   188	      const result = await AgentNative.launchApp(pkg);
   189	      if (!result.success) return { success: false, packageName: pkg };
   190	      await new Promise((resolve) => setTimeout(resolve, 2500));
   191	      await AppController.allowPackage(pkg);
   192	      await AppController.allowPackage('com.android.systemui');
   193	      try {
   194	        const fg = await AppController.getActivePackage();
   195	        if (fg && fg !== pkg) await AppController.allowPackage(fg);
   196	      } catch {
   197	        // ignore foreground allow failures
   198	      }
   199	
   200	      try {
   201	        const { AuthGate } = await import('./AuthGate');
   202	        const authDetection = await AuthGate.detect();
   203	        if (authDetection.detected) {
   204	          DebugLog.push('APP_INTEL_LAUNCH' as any, { event: 'auth_wall', app: appName, authType: authDetection.authType });
   205	          const userPresent = true;
   206	          let credentialVault: any = undefined;
   207	          try {
   208	            const core = (await import('./AgentCore')).getAgentCoreInstance();
   209	            const cv = core?.getCredentialVault?.();
   210	            if (cv && cv.isEnabled()) {
   211	              credentialVault = {
   212	                hasCredentials: (app: string) => cv.hasCredentials(app),
   213	                autoFill: (app: string, authType: any) => cv.autoFill(app, authType),
   214	              };
   215	            }
   216	          } catch {
   217	            // ignore vault lookup failures
   218	          }
   219	          const authResult = await AuthGate.handle(authDetection, { userPresent, credentialVault });
   220	          if (!authResult.success) return { success: false, packageName: pkg };
```
### `src/core/ReActLoop.ts`
```ts
    60	  constructor(
    61	    private aiCall: (prompt: string) => Promise<string>,
    62	    options: ReActOptions = {}
    63	  ) {
    64	    this.maxIterations = options.maxIterations ?? 8;
    65	    this.iterationDelayMs = options.iterationDelayMs ?? 1200;
    66	    this.allowLLMFallback = options.allowLLMFallback ?? true;
    67	  }
    68	
    69	  async execute(goal: string, appHint?: string): Promise<ReActResult> {
    70	    const steps: ReActStep[] = [];
    71	
    72	    if (Platform.OS !== 'android') {
    73	      return { success: false, steps, finalObservation: 'ReAct requires Android', goalAchieved: false, error: 'platform' };
    74	    }
    75	
    76	    const serviceEnabled = await AppController.isServiceEnabled().catch(() => false);
    77	    if (!serviceEnabled) {
    78	      const msg = 'Accessibility service not enabled. Go to Settings > Accessibility > Agent Ultra and enable it.';
    79	      return { success: false, steps, finalObservation: msg, goalAchieved: false, error: 'no_service' };
    80	    }
    81	
    82	    DebugLog.systemEvent('ReActLoop', `START goal="${goal.slice(0, 80)}" app="${appHint || 'any'}" llmFallback=${this.allowLLMFallback}`);
    83	
    84	    let observation = await this.observe();
    85	    if (observation === 'Screen: empty or inaccessible' || observation === 'Screen: observation failed') {
    86	      await this.sleep(1500);
    87	      observation = await this.observe();
    88	      if (observation === 'Screen: empty or inaccessible' || observation === 'Screen: observation failed') {
    89	        await this.sleep(1500);
    90	        observation = await this.observe();
    91	      }
    92	    }
    93	
    94	    const parsedGoal = this.parseGoal(goal);
    95	    let stuckCount = 0;
    96	    let lastTreePrefix = '';
    97	    let deterministicFailCount = 0;
    98	
    99	    for (let iteration = 1; iteration <= this.maxIterations; iteration++) {
   100	      try {
   101	        const currentPkg = await AppController.getActivePackage();
   102	        if (currentPkg === 'com.agent.ultra') {
   103	          DebugLog.error('ReActLoop', `SAFETY STOP at iter ${iteration}: foreground package is Agent Ultra — aborting to prevent self-interaction`);
   104	          return { success: false, steps, finalObservation: 'ReActLoop detected self-interaction — stopped for safety', goalAchieved: false, error: 'self_interaction' };
   105	        }
   106	        if (currentPkg) await AppController.allowPackage(currentPkg);
   107	      } catch (e: any) {
   108	        DebugLog.error('ReActLoop', `Safety check failed at iter ${iteration}: ${e?.message}`);
   109	      }
   110	
   111	      const nodes = await this.getNodes();
   112	      const deterministicAction = nodes.length > 0 ? this.executeDeterministic(parsedGoal, nodes, steps) : null;
   113	
   114	      if (deterministicAction) {
   115	        DebugLog.systemEvent('ReActLoop', `STEP ${iteration}: DETERMINISTIC action="${deterministicAction}"`);
   116	        if (/^done$/i.test(deterministicAction.trim())) {
   117	          steps.push({ iteration, observation, reasoning: 'deterministic:done', action: deterministicAction, actionResult: true, uiChanged: false });
   118	          return { success: true, steps, finalObservation: observation, goalAchieved: true };
   119	        }
   120	
   121	        const beforeObs = observation;
   122	        const actionResult = await this.executeAction(deterministicAction);
   123	        await this.waitAfterAction();
   124	        const newObservation = await this.observe();
   125	        const uiChanged = newObservation !== beforeObs;
   126	        steps.push({ iteration, observation, reasoning: 'deterministic', action: deterministicAction, actionResult, uiChanged });
   127	        DebugLog.systemEvent('ReActLoop', `STEP ${iteration}: det="${deterministicAction}" result=${actionResult} uiChanged=${uiChanged}`);
   128	
   129	        const treePrefix = newObservation.slice(0, 80);
   130	        if (treePrefix === lastTreePrefix) {
   131	          stuckCount++;
   132	          if (stuckCount >= 2) {
   133	            await AppController.performScroll('down');
   134	            await this.sleep(600);
   135	            stuckCount = 0;
   136	          }
   137	        } else {
   138	          stuckCount = 0;
   139	        }
   140	        lastTreePrefix = treePrefix;
   141	        observation = newObservation;
   142	        continue;
   143	      }
   144	
   145	      deterministicFailCount++;
   146	      if (!this.allowLLMFallback) {
   147	        DebugLog.systemEvent('ReActLoop', `STEP ${iteration}: deterministic exhausted with no LLM fallback`);
   148	        break;
   149	      }
   150	
   151	      DebugLog.systemEvent('ReActLoop', `STEP ${iteration}: Falling back to LLM (deterministic failed ${deterministicFailCount}x)`);
   152	
   153	      const systemPrompt = 'You control an Android screen. You see UI elements and choose one action. Respond ONLY: ACTION: tap_index(N), tap(x,y), type("text"), scroll(up|down), back(), done. No explanation.';
   154	      const userMessage = `GOAL: ${goal}\n\nSCREEN:\n${observation.slice(0, 2000)}\n\nACTION:`;
   155	      let reasoning: string;
   156	      try {
   157	        reasoning = await this.aiCall(`${systemPrompt}\n\n${userMessage}`);
   158	      } catch (err: any) {
   159	        DebugLog.error('ReActLoop', `AI failed at step ${iteration}: ${err.message}`);
   160	        break;
   161	      }
   162	
   163	      const action = this.extractAction(reasoning);
   164	      if (!action) {
   165	        DebugLog.error('ReActLoop', `No action extracted at step ${iteration}`);
```
```ts
   320	    }
   321	    if (parsedGoal.action === 'tap') {
   322	      return !!this.findNodeByText(nodes, parsedGoal.target, { clickableOnly: false, preferNonEditable: false });
   323	    }
   324	    return false;
   325	  }
   326	
   327	  private async waitAfterAction(): Promise<void> {
   328	    try {
   329	      await waitForUiChange(Math.min(1800, this.iterationDelayMs + 400));
   330	    } catch {
   331	      // ignore and rely on fixed delay
   332	    }
   333	    await this.sleep(Math.max(250, Math.min(900, this.iterationDelayMs)));
   334	  }
   335	
   336	  private sleep(ms: number): Promise<void> {
   337	    return new Promise((resolve) => setTimeout(resolve, ms));
   338	  }
   339	
   340	  private async getNodes(): Promise<FlatNode[]> {
   341	    try {
   342	      const flat = await getScreenContentFlat();
   343	      const parsed = JSON.parse(flat) as FlatNode[];
   344	      return Array.isArray(parsed) ? parsed : [];
   345	    } catch {
   346	      return [];
   347	    }
   348	  }
   349	
   350	  private parseGoal(goal: string): ParsedGoal {
   351	    const raw = goal.trim();
   352	    const g = raw.toLowerCase();
   353	
   354	    const searchMatch = raw.match(/(?:search|find|look\s*up|browse|google)\s+(?:for\s+)?["']?(.+?)["']?(?:\s+(?:in|on|using|within).*)?$/i);
   355	    if (searchMatch) {
   356	      return { action: 'search', target: 'search_field', value: searchMatch[1].trim() };
   357	    }
   358	
   359	    const tapMatch = raw.match(/^(?:tap|click|press|select|choose)\s+(?:the\s+)?["']?(.+?)["']?(?:\s+button)?$/i);
   360	    if (tapMatch) {
   361	      return { action: 'tap', target: tapMatch[1].trim(), value: '' };
   362	    }
   363	
   364	    const typeMatch = raw.match(/^(?:type|enter|input|fill\s+in)\s+["']?(.+?)["']?(?:\s+(?:in|into|to)\s+(.+))?$/i);
   365	    if (typeMatch) {
   366	      return { action: 'type', target: typeMatch[2]?.trim() || 'input_field', value: typeMatch[1].trim() };
   367	    }
   368	
   369	    const scrollMatch = raw.match(/^scroll\s+(up|down)$/i);
   370	    if (scrollMatch) {
   371	      return { action: 'scroll', target: scrollMatch[1].toLowerCase(), value: '' };
   372	    }
   373	
   374	    return { action: 'tap', target: g.slice(0, 40), value: '' };
   375	  }
   376	
   377	  private normalizeText(value: string): string {
   378	    return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
   379	  }
   380	
   381	  private escapeForAction(value: string): string {
   382	    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
   383	  }
   384	
   385	  private scoreTextMatch(label: string, target: string): number {
   386	    const normalizedLabel = this.normalizeText(label);
   387	    const normalizedTarget = this.normalizeText(target);
   388	    if (!normalizedLabel || !normalizedTarget) return 0;
   389	    if (normalizedLabel === normalizedTarget) return 100;
   390	    if (normalizedLabel.startsWith(normalizedTarget)) return 85;
   391	    if (normalizedLabel.includes(normalizedTarget)) return 75;
   392	
   393	    let score = 0;
   394	    const targetWords = normalizedTarget.split(' ').filter((word) => word.length > 2);
   395	    for (const word of targetWords) {
   396	      if (normalizedLabel === word) score += 30;
   397	      else if (normalizedLabel.startsWith(word)) score += 22;
   398	      else if (normalizedLabel.includes(word)) score += 16;
   399	    }
   400	    return score;
   401	  }
   402	
   403	  private findNodeByText(nodes: FlatNode[], text: string, options: TextMatchOptions = {}): FlatNode | null {
   404	    const matches = nodes
   405	      .filter((node) => !options.clickableOnly || node.c)
   406	      .map((node) => {
   407	        const label = `${node.t || ''} ${node.d || ''}`.trim();
   408	        let score = this.scoreTextMatch(label, text);
   409	        if (options.preferNonEditable && node.e) score -= 15;
   410	        if (!node.c && options.clickableOnly) score = 0;
   411	        return { node, score };
   412	      })
   413	      .filter((entry) => entry.score > 0)
   414	      .sort((a, b) => b.score - a.score || Number(a.node.e) - Number(b.node.e));
   415	
   416	    return matches.length > 0 ? matches[0].node : null;
   417	  }
   418	
   419	  private findSearchField(nodes: FlatNode[]): FlatNode | null {
   420	    const editable = nodes.filter((node) => node.e);
   421	    if (editable.length === 0) return null;
   422	
   423	    const scored = editable
   424	      .map((node) => {
   425	        const label = `${node.t || ''} ${node.d || ''}`.trim();
   426	        let score = SEARCH_FIELD_HINT.test(label) ? 100 : 10;
   427	        if (node.c) score += 5;
   428	        return { node, score };
   429	      })
   430	      .sort((a, b) => b.score - a.score);
```
### `src/core/TaskExecutor.ts`
```ts
   440	      };
   441	    } catch (err: any) {
   442	      return { success: false, summary: `UI automation error: ${err.message}`, steps: 0 };
   443	    }
   444	  }
   445	
   446	  private getEventMonitor(): import('../services/EventMonitor').EventMonitor | null {
   447	    try {
   448	      const core = require('./AgentCore').getAgentCoreInstance?.();
   449	      return core?.getEventMonitor?.() ?? null;
   450	    } catch {
   451	      return null;
   452	    }
   453	  }
   454	
   455	  private inferTriggerType(condition: string): 'schedule' | 'battery_level' | 'notification' | 'sms_content' {
   456	    const normalized = condition.toLowerCase();
   457	    if (/battery|charge/.test(normalized)) return 'battery_level';
   458	    if (/notification|alert|from\s+app|app\s+opens?/.test(normalized)) return 'notification';
   459	    if (/sms|text\s+message|message\s+contains|texts?\s+from/.test(normalized)) return 'sms_content';
   460	    return 'schedule';
   461	  }
   462	
   463	  private summarizeTriggers(triggers: Array<{ id: string; type: string; condition: string; action: string; enabled: boolean }>): string {
   464	    if (triggers.length === 0) return 'No active triggers.';
   465	    return triggers
   466	      .map((trigger) => `• ${trigger.id} [${trigger.type}] ${trigger.enabled ? 'enabled' : 'disabled'} — when ${trigger.condition}, do ${trigger.action}`)
   467	      .join('\n');
   468	  }
   469	
   470	  private async execWithParams(capId: string, params: Record<string, any>, request: string, taskId: string): Promise<any> {
   471	    switch (capId) {
   472	      case 'file_read': {
   473	        if (!isNative) return { error: 'File operations require Android device' };
   474	        const path = params.path || this.docDir;
   475	        const targetPath = path.startsWith('/') ? path : this.docDir + path;
   476	        try {
   477	          const info = await FileSystem.getInfoAsync(targetPath);
   478	          if (!info.exists) return { error: `Path not found: ${path}` };
   479	          if (info.isDirectory) {
   480	            const files = await FileSystem.readDirectoryAsync(targetPath);
   481	            return { directory: targetPath, files, count: files.length };
   482	          }
   483	          const content = await FileSystem.readAsStringAsync(targetPath);
   484	          return { path: targetPath, content: content.substring(0, 5000), size: content.length };
   485	        } catch (e: any) {
```
```ts
  1545	        await AppController.allowPackage('com.android.systemui');
  1546	
  1547	        const hasAiFallback = this.ai.hasApiKey();
  1548	        const { ReActLoop } = await import('./ReActLoop');
  1549	        const reactLoop = new ReActLoop(
  1550	          async (prompt: string) => {
  1551	            if (!hasAiFallback) return 'ACTION: done';
  1552	            const aiResult = await this.ai.complete(prompt, {
  1553	              taskId,
  1554	              agentId: 'react',
  1555	              maxTokens: 600,
  1556	              temperature: 0.2,
  1557	            });
  1558	            return aiResult.content;
  1559	          },
  1560	          { maxIterations: hasAiFallback ? 8 : 10, iterationDelayMs: 1200, allowLLMFallback: hasAiFallback }
  1561	        );
  1562	        const reactResult = await reactLoop.execute(goal, appHint);
  1563	        DebugLog.executorExit(taskId, 'react_navigate', reactResult.goalAchieved, `steps=${reactResult.steps.length} llmFallback=${hasAiFallback}`);
  1564	        return {
  1565	          success: reactResult.goalAchieved,
  1566	          summary: reactResult.goalAchieved
  1567	            ? `Completed: ${goal} in ${reactResult.steps.length} steps`
  1568	            : `Could not complete: ${goal} after ${reactResult.steps.length} steps`,
  1569	          data: {
  1570	            steps: reactResult.steps.length,
  1571	            goalAchieved: reactResult.goalAchieved,
  1572	            finalObservation: reactResult.finalObservation.slice(0, 300),
  1573	            llmFallbackUsed: hasAiFallback,
  1574	          },
  1575	        };
  1576	      }
  1577	
  1578	      case 'multi_step': {
  1579	        const rawSteps = Array.isArray(params.steps) ? params.steps : [];
  1580	        if (rawSteps.length === 0) return { success: false, summary: 'No steps provided for multi-step task.' };
  1581	        const { CommandParser } = await import('./CommandParser');
  1582	        const { AIIntentParser } = await import('./AIIntentParser');
  1583	        const parser = new CommandParser();
  1584	        const aiIntent = new AIIntentParser(this.ai, this.caps);
  1585	        const summaries: string[] = [];
  1586	        let allSucceeded = true;
  1587	
  1588	        for (let idx = 0; idx < rawSteps.length; idx++) {
  1589	          const rawStep = rawSteps[idx];
  1590	          let stepPlan: ActionPlan | null = null;
  1591	          let stepLabel = '';
  1592	
  1593	          if (typeof rawStep === 'string') {
  1594	            stepLabel = rawStep.trim();
  1595	            stepPlan = parser.parse(stepLabel);
  1596	            if (!stepPlan && this.ai.hasApiKey()) {
  1597	              try { stepPlan = await aiIntent.parse(stepLabel); } catch {}
  1598	            }
  1599	          } else if (rawStep && typeof rawStep === 'object') {
  1600	            const candidate = rawStep as Record<string, any>;
  1601	            if (typeof candidate.capability === 'string') {
  1602	              stepPlan = {
  1603	                capability: candidate.capability,
  1604	                params: (candidate.params && typeof candidate.params === 'object') ? candidate.params : {},
  1605	                reason: candidate.reason || 'Nested multi-step capability',
  1606	              };
  1607	              stepLabel = candidate.reason || candidate.capability;
  1608	            } else if (typeof candidate.input === 'string' || typeof candidate.request === 'string' || typeof candidate.query === 'string') {
  1609	              stepLabel = String(candidate.input || candidate.request || candidate.query).trim();
  1610	              stepPlan = parser.parse(stepLabel);
  1611	              if (!stepPlan && this.ai.hasApiKey()) {
  1612	                try { stepPlan = await aiIntent.parse(stepLabel); } catch {}
  1613	              }
  1614	            }
  1615	          }
  1616	
  1617	          if (!stepPlan) {
  1618	            summaries.push(`Step ${idx + 1}: could not parse`);
  1619	            allSucceeded = false;
  1620	            continue;
  1621	          }
  1622	          if (stepPlan.capability === 'multi_step') {
  1623	            summaries.push(`Step ${idx + 1}: nested multi_step is not allowed`);
  1624	            allSucceeded = false;
  1625	            continue;
  1626	          }
  1627	
  1628	          const stepResult = await this.runWithPlan(stepPlan, `${taskId}_ms${idx + 1}`);
  1629	          summaries.push(stepResult.summary || `${stepLabel || stepPlan.capability}: ${stepResult.success ? 'ok' : 'failed'}`);
  1630	          if (!stepResult.success) allSucceeded = false;
  1631	        }
  1632	
  1633	        return {
  1634	          success: allSucceeded,
  1635	          summary: summaries.join(' → '),
  1636	          stepsRun: rawSteps.length,
  1637	        };
  1638	      }
  1639	
  1640	      case 'event_trigger_set': {
  1641	        const monitor = this.getEventMonitor();
  1642	        if (!monitor) {
  1643	          return { success: false, summary: 'Event monitor is not running yet.' };
  1644	        }
  1645	        const condition = typeof params.condition === 'string' ? params.condition.trim() : '';
  1646	        const action = typeof params.action === 'string' ? params.action.trim() : '';
  1647	        if (!condition || !action) {
  1648	          return { success: false, summary: 'Trigger requires both a condition and an action.' };
  1649	        }
  1650	        const triggerType = typeof params.type === 'string' && params.type.trim()
  1651	          ? params.type.trim()
  1652	          : this.inferTriggerType(condition);
  1653	        const triggerId = await monitor.addTrigger({
  1654	          type: triggerType as any,
  1655	          condition,
  1656	          action,
  1657	          enabled: true,
  1658	        });
  1659	        const triggers = monitor.getTriggers();
  1660	        DebugLog.systemEvent('event_trigger_set', `Trigger stored: ${triggerId} type=${triggerType} condition="${condition.slice(0, 80)}"`);
  1661	        return {
  1662	          success: true,
  1663	          summary: `Trigger set: when ${condition}, will ${action}. ID: ${triggerId}`,
  1664	          data: { id: triggerId, type: triggerType, totalTriggers: triggers.length },
  1665	        };
  1666	      }
  1667	
  1668	      case 'event_trigger_list': {
  1669	        const monitor = this.getEventMonitor();
  1670	        if (!monitor) {
  1671	          return { success: false, summary: 'Event monitor is not running yet.' };
  1672	        }
  1673	        const triggers = monitor.getTriggers();
  1674	        return {
  1675	          success: true,
  1676	          summary: this.summarizeTriggers(triggers),
  1677	          data: { triggers, count: triggers.length },
  1678	        };
  1679	      }
  1680	
  1681	      case 'event_trigger_remove': {
  1682	        const monitor = this.getEventMonitor();
  1683	        if (!monitor) {
  1684	          return { success: false, summary: 'Event monitor is not running yet.' };
  1685	        }
  1686	        const id = typeof params.id === 'string' ? params.id.trim() : '';
  1687	        if (!id) {
  1688	          return { success: false, summary: 'Which trigger ID should I remove?' };
  1689	        }
  1690	        const existing = monitor.getTriggers().find((trigger) => trigger.id === id);
  1691	        if (!existing) {
  1692	          return { success: false, summary: `No active trigger found with ID ${id}` };
  1693	        }
  1694	        await monitor.removeTrigger(id);
  1695	        return {
  1696	          success: true,
  1697	          summary: `Removed trigger ${id}`,
  1698	          data: { id },
```
### `src/core/AgentCore.ts`
```ts
   316	  private shouldPromoteConversationalPlan(plan: ActionPlan | null): boolean {
   317	    if (!plan?.capability) return false;
   318	    return [
   319	      'app_launch', 'open_url', 'media_access', 'device_location', 'contacts_read',
   320	      'sms_read', 'sms_conversation', 'sms_send', 'camera_capture', 'flashlight_toggle',
   321	      'alarm_set', 'timer_set', 'reminder_create', 'clipboard_read', 'clipboard_write',
   322	      'wifi_toggle', 'bluetooth_toggle', 'do_not_disturb', 'battery_status', 'system_info',
   323	      'device_info', 'app_share', 'web_research', 'vision_read', 'react_navigate',
   324	      'event_trigger_set', 'event_trigger_list', 'event_trigger_remove', 'note_create',
   325	      'calendar_create', 'app_info', 'notification_read', 'volume_set', 'brightness_set'
   326	    ].includes(plan.capability);
   327	  }
   328	
   329	
   330	  async refreshSystemContext(): Promise<void> {
```
```ts
  1848	  getTierService(): TierService { return this.tierService; }
  1849	  getCortex(): Cortex { return this.cortex; }
  1850	  getProactiveEngine(): ProactiveEngine | null { return this.proactive; }
  1851	  getBackgroundOrchestrator(): BackgroundOrchestrator | null { return this.background; }
  1852	  getEventMonitor(): EventMonitor | null { return this.eventMonitor; }
  1853	  getKnowledgeGraph(): KnowledgeGraph { return this.cortex.getKnowledgeGraph(); }
  1854	  getDeviceSignals(): DeviceSignals { return this.deviceSignals; }
  1855	  getCostSummary() { return this.costTracker.getSummary(); }
```
### `src/services/EventMonitor.ts`
```ts
   204	    const id = `trigger_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
   205	    const full: EventTrigger = { ...trigger, id, createdAt: Date.now() };
   206	    this.triggers.push(full);
   207	    await this.memory.storeLongterm(`trigger:${id}`, 'event_trigger', JSON.stringify(full));
   208	    return id;
   209	  }
   210	
   211	  async removeTrigger(id: string): Promise<void> {
   212	    this.triggers = this.triggers.filter(t => t.id !== id);
   213	    await this.memory.storeLongterm(`trigger:${id}`, 'event_trigger', JSON.stringify({ deleted: true, id, timestamp: Date.now() }));
   214	  }
   215	
   216	  getTriggers(): EventTrigger[] {
   217	    return [...this.triggers].sort((a, b) => a.createdAt - b.createdAt);
   218	  }
   219	
   220	  private parseStoredTrigger(raw: string): Partial<EventTrigger> | null {
   221	    try {
   222	      const parsed = JSON.parse(raw) as Partial<EventTrigger> & { deleted?: boolean };
   223	      if (!parsed || typeof parsed !== 'object') return null;
   224	      return parsed;
   225	    } catch (e) {
   226	      DebugLog.error('EventMonitor', `Failed to parse trigger: ${e instanceof Error ? e.message : 'unknown error'}`);
   227	      return null;
   228	    }
   229	  }
   230	
   231	  private extractTriggerId(trigger: Partial<EventTrigger>, recordTrigger: string): string | null {
   232	    if (trigger.id && typeof trigger.id === 'string') return trigger.id;
   233	    const match = recordTrigger.match(/trigger:([A-Za-z0-9:_-]+)/);
   234	    return match ? match[1] : null;
   235	  }
   236	
   237	  private async loadTriggers(): Promise<void> {
   238	    this.triggers = [];
   239	    const stored = await this.memory.retrieveRelevant('trigger', 200);
   240	    const byId = new Map<string, EventTrigger>();
   241	    const tombstones = new Set<string>();
   242	    const ordered = [...stored]
   243	      .filter(record => record.capability === 'event_trigger')
   244	      .sort((a, b) => a.timestamp - b.timestamp);
   245	
   246	    for (const record of ordered) {
   247	      const parsed = this.parseStoredTrigger(record.outcome);
   248	      if (!parsed) continue;
   249	      const triggerId = this.extractTriggerId(parsed, record.trigger);
   250	      if (!triggerId) continue;
   251	      if ((parsed as any).deleted) {
   252	        tombstones.add(triggerId);
   253	        byId.delete(triggerId);
   254	        continue;
   255	      }
   256	      if (!parsed.type || !parsed.action) continue;
   257	      byId.set(triggerId, {
   258	        id: triggerId,
   259	        type: parsed.type as EventTrigger['type'],
   260	        condition: typeof parsed.condition === 'string' ? parsed.condition : '',
   261	        action: typeof parsed.action === 'string' ? parsed.action : '',
   262	        enabled: parsed.enabled !== false,
   263	        createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : record.timestamp,
   264	        lastFired: typeof parsed.lastFired === 'number' ? parsed.lastFired : undefined,
   265	        metadata: parsed.metadata && typeof parsed.metadata === 'object' ? parsed.metadata : undefined,
   266	      });
   267	    }
   268	
   269	    this.triggers = [...byId.values()]
   270	      .filter(trigger => !tombstones.has(trigger.id))
   271	      .sort((a, b) => a.createdAt - b.createdAt);
   272	  }
   273	}
```

## Targeted parser behavior proof
```text
{
  "input": "please open spotify for me",
  "out": {
    "capability": "app_launch",
    "params": {
      "target": "spotify"
    },
    "reason": "Matched by deterministic command parser"
  }
}
{
  "input": "can you search for dog food on amazon",
  "out": {
    "capability": "react_navigate",
    "params": {
      "goal": "Search for \"dog food\" using the search function",
      "appHint": "amazon"
    },
    "reason": "Matched by deterministic command parser"
  }
}
{
  "input": "every weekday at 7am, remind me to stretch",
  "out": {
    "capability": "event_trigger_set",
    "params": {
      "type": "schedule",
      "condition": "every weekday at 7am",
      "action": "remind me to stretch"
    },
    "reason": "Matched by deterministic command parser"
  }
}
{
  "input": "remove trigger trigger_1234",
  "out": {
    "capability": "event_trigger_remove",
    "params": {
      "id": "trigger_1234"
    },
    "reason": "Matched by deterministic command parser"
  }
}
{
  "input": "could you google best pizza near me",
  "out": {
    "capability": "react_navigate",
    "params": {
      "goal": "Search for \"best pizza near me\"",
      "appHint": "browser"
    },
    "reason": "Matched by deterministic command parser"
  }
}
{
  "input": "open up chrome and search for weather",
  "out": {
    "capability": "react_navigate",
    "params": {
      "goal": "search for weather",
      "appHint": "chrome"
    },
    "reason": "Matched by deterministic command parser"
  }
}
```

## Honesty / closure statement
- **Proven closed from source:** the audited command → parser → promotion → executor → trigger monitor → deterministic app-intelligence path listed above.
- **Not proven closed:** the entire codebase, device runtime, or full build pipeline.
- **Do not label this runtime-proven until the exact patched build is run and raw logs from that run are reviewed.**

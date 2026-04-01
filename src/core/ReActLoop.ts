import { Platform } from 'react-native';
import AppController from '../native/AppController';
import { performTap, performSwipe, getScreenContentFlat, waitForUiChange } from '../native/AppController';
import { UltraDevLog as DebugLog } from '../utils/UltraDevLog';

export interface ReActStep {
  iteration: number;
  observation: string;
  reasoning: string;
  action: string;
  actionResult: boolean;
  uiChanged: boolean;
}

export interface ReActResult {
  success: boolean;
  steps: ReActStep[];
  finalObservation: string;
  goalAchieved: boolean;
  error?: string;
}

export interface ReActOptions {
  maxIterations?: number;
  iterationDelayMs?: number;
  allowLLMFallback?: boolean;
  visionSparseThreshold?: number;
}

interface FlatNode {
  i: number;
  t: string;
  d: string;
  c: boolean;
  e: boolean;
  s: boolean;
  x: number;
  y: number;
}

interface ParsedGoal {
  action: 'search' | 'tap' | 'type' | 'scroll';
  target: string;
  value: string;
}

interface TextMatchOptions {
  clickableOnly?: boolean;
  preferNonEditable?: boolean;
}

const SEARCH_FIELD_HINT = /(search|find|query|lookup)/i;
const SEARCH_BUTTON_HINT = /^(search|go|enter|submit|done|ok|apply)$/i;
const RESULT_TEXT_HINT = /(result|results|price|rating|reviews?|buy|shop|watch|play|open|visit)/i;

const VISION_SPARSE_THRESHOLD = 8;

export class ReActLoop {
  private maxIterations: number;
  private iterationDelayMs: number;
  private allowLLMFallback: boolean;
  private visionSparseThreshold: number;

  constructor(
    private aiCall: (prompt: string) => Promise<string>,
    options: ReActOptions = {}
  ) {
    this.maxIterations = options.maxIterations ?? 8;
    this.iterationDelayMs = options.iterationDelayMs ?? 1200;
    this.allowLLMFallback = options.allowLLMFallback ?? true;
    this.visionSparseThreshold = options.visionSparseThreshold ?? VISION_SPARSE_THRESHOLD;
  }

  private async tryGetVisionContext(): Promise<string | null> {
    try {
      const { getAgentCoreInstance } = await import('./AgentCore');
      const core = getAgentCoreInstance();
      const vision = core?.getCortex()?.getVisionPipeline();
      if (!vision) return null;
      const u = await vision.understand();
      if (!u || !u.description) return null;
      // confidence < 0.2 means even the a11y tree was empty — nothing useful to offer
      if (u.confidence < 0.2) return null;
      // confidence === 0.2 means AI vision failed but we have a tree-based fallback.
      // Always use [VISUAL] as the outer tag for downstream consistency; append
      // [TREE_FALLBACK] to signal that no image-model analysis was performed.
      const tag = u.confidence <= 0.2 ? '[VISUAL][TREE_FALLBACK]' : '[VISUAL]';
      return `${tag} ${u.description}${u.textContent.length > 0 ? '\nText visible: ' + u.textContent.slice(0, 5).join(' | ') : ''}`;
    } catch {
      return null;
    }
  }

  async execute(goal: string, appHint?: string): Promise<ReActResult> {
    const steps: ReActStep[] = [];

    if (Platform.OS !== 'android') {
      return { success: false, steps, finalObservation: 'ReAct requires Android', goalAchieved: false, error: 'platform' };
    }

    const serviceEnabled = await AppController.isServiceEnabled().catch(() => false);
    if (!serviceEnabled) {
      const msg = 'Accessibility service not enabled. Go to Settings > Accessibility > Agent Ultra and enable it.';
      return { success: false, steps, finalObservation: msg, goalAchieved: false, error: 'no_service' };
    }

    DebugLog.systemEvent('ReActLoop', `START goal="${goal.slice(0, 80)}" app="${appHint || 'any'}" llmFallback=${this.allowLLMFallback}`);

    let observation = await this.observe();
    if (observation === 'Screen: empty or inaccessible' || observation === 'Screen: observation failed') {
      await this.sleep(1500);
      observation = await this.observe();
      if (observation === 'Screen: empty or inaccessible' || observation === 'Screen: observation failed') {
        await this.sleep(1500);
        observation = await this.observe();
      }
    }

    const parsedGoal = this.parseGoal(goal);
    let stuckCount = 0;
    let lastTreePrefix = '';
    let deterministicFailCount = 0;

    for (let iteration = 1; iteration <= this.maxIterations; iteration++) {
      try {
        const currentPkg = await AppController.getActivePackage();
        // Skip self-check for first 3 iterations when we have an appHint —
        // the app needs time to launch and the user may briefly see Ultra
        const skipSelfCheck = iteration <= 3 && !!appHint;
        if (!skipSelfCheck && currentPkg === 'com.agent.ultra') {
          DebugLog.error('ReActLoop', `SAFETY STOP at iter ${iteration}: foreground package is Agent Ultra — aborting to prevent self-interaction`);
          return { success: false, steps, finalObservation: 'ReActLoop detected self-interaction — stopped for safety', goalAchieved: false, error: 'self_interaction' };
        }
        if (currentPkg) await AppController.allowPackage(currentPkg);
      } catch (e: any) {
        DebugLog.error('ReActLoop', `Safety check failed at iter ${iteration}: ${e?.message}`);
      }

      const nodes = await this.getNodes();
      const deterministicAction = nodes.length > 0 ? this.executeDeterministic(parsedGoal, nodes, steps) : null;

      if (deterministicAction) {
        DebugLog.systemEvent('ReActLoop', `STEP ${iteration}: DETERMINISTIC action="${deterministicAction}"`);
        if (/^done$/i.test(deterministicAction.trim())) {
          steps.push({ iteration, observation, reasoning: 'deterministic:done', action: deterministicAction, actionResult: true, uiChanged: false });
          return { success: true, steps, finalObservation: observation, goalAchieved: true };
        }

        const beforeObs = observation;
        const actionResult = await this.executeAction(deterministicAction);
        await this.waitAfterAction();
        const newObservation = await this.observe();
        const uiChanged = newObservation !== beforeObs;
        steps.push({ iteration, observation, reasoning: 'deterministic', action: deterministicAction, actionResult, uiChanged });
        DebugLog.systemEvent('ReActLoop', `STEP ${iteration}: det="${deterministicAction}" result=${actionResult} uiChanged=${uiChanged}`);

        const treePrefix = newObservation.slice(0, 80);
        if (treePrefix === lastTreePrefix) {
          stuckCount++;
          if (stuckCount >= 2) {
            await AppController.performScroll('down');
            await this.sleep(600);
            stuckCount = 0;
          }
        } else {
          stuckCount = 0;
        }
        lastTreePrefix = treePrefix;
        observation = newObservation;
        continue;
      }

      deterministicFailCount++;
      if (!this.allowLLMFallback) {
        DebugLog.systemEvent('ReActLoop', `STEP ${iteration}: deterministic exhausted with no LLM fallback`);
        break;
      }

      DebugLog.systemEvent('ReActLoop', `STEP ${iteration}: Falling back to LLM (deterministic failed ${deterministicFailCount}x)`);

      let enhancedObservation = observation;
      if (nodes.length < this.visionSparseThreshold && this.allowLLMFallback) {
        const visionCtx = await this.tryGetVisionContext();
        if (visionCtx) {
          enhancedObservation = `${visionCtx}\n\n${observation}`;
          DebugLog.systemEvent('ReActLoop', `STEP ${iteration}: sparse screen (${nodes.length} nodes), vision context prepended`);
        }
      }

      const systemPrompt = `You control an Android phone. Choose ONE action to make progress toward the goal.
ACTIONS YOU CAN USE:
- tap_index(N)   tap element by its index number
- tap(N)         same as tap_index(N)
- type("text")   type text into focused field
- scroll(down)   scroll the screen down
- scroll(up)     scroll the screen up
- back()         press the back button
- done           goal is complete

Respond with ONLY the action. No explanation. No prefix. Just the action.`;

      // Build step history for context (last 4 steps)
      const recentSteps = steps.slice(-4).map(s =>
        `  ${s.action} → ${s.uiChanged ? 'screen changed' : s.actionResult ? 'no visual change' : 'FAILED'}`
      ).join('\n');
      const historyLine = recentSteps ? `\nRECENT ACTIONS:\n${recentSteps}\n` : '';

      const userMessage = `GOAL: ${goal}${historyLine}\n\nSCREEN:\n${enhancedObservation.slice(0, 1500)}\n\nACTION:`;
      let reasoning: string;
      try {
        reasoning = await this.aiCall(`${systemPrompt}\n\n${userMessage}`);
      } catch (err: any) {
        DebugLog.error('ReActLoop', `AI failed at step ${iteration}: ${err.message}`);
        break;
      }

      const action = this.extractAction(reasoning);
      if (!action) {
        DebugLog.error('ReActLoop', `No action extracted at step ${iteration}`);
        break;
      }

      if (/^done$/i.test(action.trim())) {
        steps.push({ iteration, observation, reasoning, action, actionResult: true, uiChanged: false });
        DebugLog.systemEvent('ReActLoop', `DONE at step ${iteration}`);
        return { success: true, steps, finalObservation: observation, goalAchieved: true };
      }

      const beforeObservation = observation;
      const actionResult = await this.executeAction(action);
      await this.waitAfterAction();
      const newObservation = await this.observe();
      const uiChanged = newObservation !== beforeObservation;

      steps.push({ iteration, observation, reasoning, action, actionResult, uiChanged });
      DebugLog.systemEvent('ReActLoop', `STEP ${iteration}: "${action}" result=${actionResult} uiChanged=${uiChanged}`);

      const treePrefix = newObservation.slice(0, 80);
      if (treePrefix === lastTreePrefix) {
        stuckCount++;
        if (stuckCount >= 2) {
          await AppController.performScroll('down');
          await this.sleep(600);
          stuckCount = 0;
        }
      } else {
        stuckCount = 0;
      }
      lastTreePrefix = treePrefix;
      observation = newObservation;
    }

    const goalAchieved = await this.checkCompletion(parsedGoal, observation);
    DebugLog.systemEvent('ReActLoop', `COMPLETE goalAchieved=${goalAchieved} steps=${steps.length}`);
    return { success: goalAchieved, steps, finalObservation: observation, goalAchieved };
  }

  private async observe(): Promise<string> {
    try {
      const flat = await getScreenContentFlat();
      const nodes = JSON.parse(flat) as FlatNode[];
      if (!Array.isArray(nodes) || nodes.length === 0) return 'Screen: empty or inaccessible';

      // Only show interactive nodes — skip empty labels and view-only noise
      const tappable: string[] = [];
      const typeable: string[] = [];
      const scrollable: string[] = [];

      for (const n of nodes) {
        const label = (n.t || n.d || '').trim().slice(0, 50);
        if (!label) continue; // skip blank nodes
        if (n.e) typeable.push(`  [${n.i}] ${label}`);
        else if (n.c) tappable.push(`  [${n.i}] ${label}`);
        else if (n.s && !tappable.length) scrollable.push(`  [${n.i}] ${label}`);
      }

      const parts: string[] = [];
      if (tappable.length) parts.push(`TAPPABLE:\n${tappable.slice(0, 20).join('\n')}`);
      if (typeable.length) parts.push(`TYPEABLE:\n${typeable.slice(0, 5).join('\n')}`);
      if (scrollable.length) parts.push(`SCROLLABLE:\n${scrollable.slice(0, 3).join('\n')}`);
      if (!parts.length) parts.push('Screen has no interactive elements — try scroll(down) or back()');

      return parts.join('\n\n');
    } catch {
      try {
        const tree = await AppController.getScreenContent();
        const serialized = typeof (tree as any) === 'string' ? String(tree) : JSON.stringify(tree);
        return serialized.slice(0, 1500);
      } catch {
        return 'Screen: observation failed';
      }
    }
  }

  private extractAction(text: string): string | null {
    const t = text.trim();

    // 1. Strict prefix match: "ACTION: tap_index(5)"
    const strict = t.match(/^ACTION:\s*(.+)$/im);
    if (strict) return strict[1].trim();

    // 2. Bare action on its own line or as the whole response
    const bare = t.match(/^(tap_index\(\s*\d+\s*\)|tap\(\s*\d+(?:\s*,\s*\d+)?\s*\)|type\(["']?[^)]+["']?\)|scroll\((?:up|down|forward|backward)\)|swipe\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)|back\(\)|home\(\)|done)$/i);
    if (bare) return bare[1].trim();

    // 3. Action embedded anywhere in text — extract first match
    const patterns = [
      /\b(tap_index\(\s*\d+\s*\))/i,
      /\b(tap\(\s*\d+\s*,\s*\d+\s*\))/i,
      /\b(tap\(\s*\d+\s*\))/i,             // single-arg tap = tap by index
      /\b(type\(["']?[^)]{1,100}["']?\))/i,
      /\b(scroll\((?:up|down|forward|backward)\))/i,
      /\b(swipe\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\))/i,
      /\b(back\(\))/i,
      /\b(home\(\))/i,
    ];
    for (const p of patterns) {
      const m = t.match(p);
      if (m) return m[1].trim();
    }

    // 4. Keyword fallback for simple prose responses
    const lower = t.toLowerCase();
    if (/\bdone\b/.test(lower) && t.length < 60) return 'done';
    if (/\bscroll down\b/.test(lower)) return 'scroll(down)';
    if (/\bscroll up\b/.test(lower)) return 'scroll(up)';
    if (/\bgo back\b|\bpress back\b/.test(lower)) return 'back()';

    return null;
  }

  private async executeAction(action: string): Promise<boolean> {
    const a = action.trim();
    try {
      if (/^back\(\)$/i.test(a) || /^back$/i.test(a)) return await AppController.performBack();
      if (/^home\(\)$/i.test(a) || /^home$/i.test(a)) return await AppController.performHome();

      const scrollMatch = a.match(/^scroll\((up|down|forward|backward)\)$/i);
      if (scrollMatch) {
        const dir = scrollMatch[1].toLowerCase();
        return await AppController.performScroll(dir === 'up' || dir === 'backward' ? 'up' : 'down');
      }

      const tapMatch = a.match(/^tap\(\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
      if (tapMatch) return await performTap(parseInt(tapMatch[1], 10), parseInt(tapMatch[2], 10));

      // tap(N) with single arg = tap by node index (alias for tap_index(N))
      const tapSingleMatch = a.match(/^tap\(\s*(\d+)\s*\)$/i);
      if (tapSingleMatch) {
        const idx = parseInt(tapSingleMatch[1], 10);
        const flat = await getScreenContentFlat();
        const nodes = JSON.parse(flat) as FlatNode[];
        const node = Array.isArray(nodes) ? nodes.find((n) => n.i === idx) : null;
        if (node) return await performTap(node.x, node.y);
        return false;
      }

      const tapIdxMatch = a.match(/^tap_index\(\s*(\d+)\s*\)$/i);
      if (tapIdxMatch) {
        const idx = parseInt(tapIdxMatch[1], 10);
        const flat = await getScreenContentFlat();
        const nodes = JSON.parse(flat) as FlatNode[];
        const node = Array.isArray(nodes) ? nodes.find((n) => n.i === idx) : null;
        if (node) return await performTap(node.x, node.y);
        return false;
      }

      const typeMatch = a.match(/^type\(\s*["']?(.+?)["']?\s*\)$/i);
      if (typeMatch) return await AppController.performText('', typeMatch[1]);

      const swipeMatch = a.match(/^swipe\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
      if (swipeMatch) {
        return await performSwipe(
          parseInt(swipeMatch[1], 10),
          parseInt(swipeMatch[2], 10),
          parseInt(swipeMatch[3], 10),
          parseInt(swipeMatch[4], 10),
          350,
        );
      }

      DebugLog.error('ReActLoop', `Unknown action: ${a}`);
      return false;
    } catch (err: any) {
      DebugLog.error('ReActLoop', `Action error: ${err.message}`);
      return false;
    }
  }

  private async checkCompletion(parsedGoal: ParsedGoal, observation: string): Promise<boolean> {
    if (!this.allowLLMFallback) {
      const nodes = await this.getNodes();
      return this.heuristicCompletion(parsedGoal, nodes, observation);
    }

    try {
      const prompt = `Goal: "${parsedGoal.action} ${parsedGoal.target} ${parsedGoal.value}"\nCurrent screen:\n${observation.slice(0, 800)}\n\nIs the goal fully achieved? Reply YES or NO only.`;
      const response = await this.aiCall(prompt);
      return /^yes/i.test(response.trim());
    } catch {
      const nodes = await this.getNodes();
      return this.heuristicCompletion(parsedGoal, nodes, observation);
    }
  }

  private heuristicCompletion(parsedGoal: ParsedGoal, nodes: FlatNode[], observation: string): boolean {
    if (parsedGoal.action === 'search') {
      const queryVisible = this.isQueryVisible(nodes, parsedGoal.value || parsedGoal.target);
      const likelyResultsVisible = this.looksLikeSearchResults(nodes, parsedGoal.value || parsedGoal.target);
      return queryVisible && (likelyResultsVisible || observation.toLowerCase().includes((parsedGoal.value || parsedGoal.target).toLowerCase()));
    }
    if (parsedGoal.action === 'tap') {
      return !!this.findNodeByText(nodes, parsedGoal.target, { clickableOnly: false, preferNonEditable: false });
    }
    return false;
  }

  private async waitAfterAction(): Promise<void> {
    try {
      await waitForUiChange(Math.min(1800, this.iterationDelayMs + 400));
    } catch {
      // ignore and rely on fixed delay
    }
    await this.sleep(Math.max(250, Math.min(900, this.iterationDelayMs)));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async getNodes(): Promise<FlatNode[]> {
    try {
      const flat = await getScreenContentFlat();
      const parsed = JSON.parse(flat) as FlatNode[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private parseGoal(goal: string): ParsedGoal {
    const raw = goal.trim();
    const g = raw.toLowerCase();

    const searchMatch = raw.match(/(?:search|find|look\s*up|browse|google)\s+(?:for\s+)?["']?(.+?)["']?(?:\s+(?:in|on|using|within).*)?$/i);
    if (searchMatch) {
      return { action: 'search', target: 'search_field', value: searchMatch[1].trim() };
    }

    const tapMatch = raw.match(/^(?:tap|click|press|select|choose)\s+(?:the\s+)?["']?(.+?)["']?(?:\s+button)?$/i);
    if (tapMatch) {
      return { action: 'tap', target: tapMatch[1].trim(), value: '' };
    }

    const typeMatch = raw.match(/^(?:type|enter|input|fill\s+in)\s+["']?(.+?)["']?(?:\s+(?:in|into|to)\s+(.+))?$/i);
    if (typeMatch) {
      return { action: 'type', target: typeMatch[2]?.trim() || 'input_field', value: typeMatch[1].trim() };
    }

    const scrollMatch = raw.match(/^scroll\s+(up|down)$/i);
    if (scrollMatch) {
      return { action: 'scroll', target: scrollMatch[1].toLowerCase(), value: '' };
    }

    return { action: 'tap', target: g.slice(0, 40), value: '' };
  }

  private normalizeText(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private escapeForAction(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  private scoreTextMatch(label: string, target: string): number {
    const normalizedLabel = this.normalizeText(label);
    const normalizedTarget = this.normalizeText(target);
    if (!normalizedLabel || !normalizedTarget) return 0;
    if (normalizedLabel === normalizedTarget) return 100;
    if (normalizedLabel.startsWith(normalizedTarget)) return 85;
    if (normalizedLabel.includes(normalizedTarget)) return 75;

    let score = 0;
    const targetWords = normalizedTarget.split(' ').filter((word) => word.length > 2);
    for (const word of targetWords) {
      if (normalizedLabel === word) score += 30;
      else if (normalizedLabel.startsWith(word)) score += 22;
      else if (normalizedLabel.includes(word)) score += 16;
    }
    return score;
  }

  private findNodeByText(nodes: FlatNode[], text: string, options: TextMatchOptions = {}): FlatNode | null {
    const matches = nodes
      .filter((node) => !options.clickableOnly || node.c)
      .map((node) => {
        const label = `${node.t || ''} ${node.d || ''}`.trim();
        let score = this.scoreTextMatch(label, text);
        if (options.preferNonEditable && node.e) score -= 15;
        if (!node.c && options.clickableOnly) score = 0;
        return { node, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || Number(a.node.e) - Number(b.node.e));

    return matches.length > 0 ? matches[0].node : null;
  }

  private findSearchField(nodes: FlatNode[]): FlatNode | null {
    const editable = nodes.filter((node) => node.e);
    if (editable.length === 0) return null;

    const scored = editable
      .map((node) => {
        const label = `${node.t || ''} ${node.d || ''}`.trim();
        let score = SEARCH_FIELD_HINT.test(label) ? 100 : 10;
        if (node.c) score += 5;
        return { node, score };
      })
      .sort((a, b) => b.score - a.score);

    return scored[0]?.node ?? null;
  }

  private findSearchSubmit(nodes: FlatNode[]): FlatNode | null {
    const candidates = nodes
      .filter((node) => node.c && !node.e)
      .map((node) => {
        const label = `${node.t || ''} ${node.d || ''}`.trim();
        let score = SEARCH_BUTTON_HINT.test(this.normalizeText(label)) ? 100 : 0;
        if (!score && /search/i.test(label)) score = 85;
        if (!score && /go|submit|done|apply|enter/i.test(label)) score = 75;
        return { node, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    return candidates[0]?.node ?? null;
  }

  private isQueryVisible(nodes: FlatNode[], query: string): boolean {
    const normalizedQuery = this.normalizeText(query);
    if (!normalizedQuery) return false;
    return nodes.some((node) => this.scoreTextMatch(`${node.t || ''} ${node.d || ''}`.trim(), normalizedQuery) >= 60);
  }

  private looksLikeSearchResults(nodes: FlatNode[], query: string): boolean {
    const normalizedQuery = this.normalizeText(query);
    let nonInputMatches = 0;
    for (const node of nodes) {
      if (node.e) continue;
      const label = `${node.t || ''} ${node.d || ''}`.trim();
      const normalizedLabel = this.normalizeText(label);
      if (!normalizedLabel) continue;
      if (normalizedLabel.includes(normalizedQuery) || RESULT_TEXT_HINT.test(label)) {
        nonInputMatches++;
      }
      if (nonInputMatches >= 2) return true;
    }
    return false;
  }

  private executeDeterministic(parsed: ParsedGoal, nodes: FlatNode[], steps: ReActStep[]): string | null {
    const lastAction = steps.length > 0 ? steps[steps.length - 1].action.trim().toLowerCase() : '';

    if (parsed.action === 'search') {
      const query = parsed.value || parsed.target;
      const queryVisible = this.isQueryVisible(nodes, query);
      const resultsVisible = this.looksLikeSearchResults(nodes, query);
      const searchField = this.findSearchField(nodes);
      const searchSubmit = this.findSearchSubmit(nodes);

      if (!lastAction && searchField) {
        return `tap_index(${searchField.i})`;
      }

      if (lastAction.startsWith('type(')) {
        if (searchSubmit) return `tap_index(${searchSubmit.i})`;
        if (queryVisible && resultsVisible) return 'done';
        return null;
      }

      if (queryVisible && resultsVisible) return 'done';

      if (lastAction.startsWith('tap_index(') || lastAction.startsWith('tap(')) {
        if (searchField) return `type("${this.escapeForAction(query)}")`;
      }

      if (searchField && !queryVisible) {
        return `tap_index(${searchField.i})`;
      }

      if (searchSubmit && queryVisible) {
        return `tap_index(${searchSubmit.i})`;
      }

      if (queryVisible) return 'done';
      return null;
    }

    if (parsed.action === 'tap') {
      const node = this.findNodeByText(nodes, parsed.target, { clickableOnly: true, preferNonEditable: true });
      if (node) return `tap_index(${node.i})`;
      return null;
    }

    if (parsed.action === 'type') {
      const field = parsed.target !== 'input_field'
        ? this.findNodeByText(nodes, parsed.target, { clickableOnly: true, preferNonEditable: false }) || this.findSearchField(nodes)
        : this.findSearchField(nodes);
      if (lastAction.startsWith('tap_index(') || lastAction.startsWith('tap(')) {
        return `type("${this.escapeForAction(parsed.value)}")`;
      }
      if (field) return `tap_index(${field.i})`;
      return null;
    }

    if (parsed.action === 'scroll') {
      return `scroll(${parsed.target})`;
    }

    return null;
  }
}

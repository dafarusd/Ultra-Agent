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
}

export class ReActLoop {
  private maxIterations: number;
  private iterationDelayMs: number;

  constructor(
    private aiCall: (prompt: string) => Promise<string>,
    options: ReActOptions = {}
  ) {
    this.maxIterations = options.maxIterations ?? 8;
    this.iterationDelayMs = options.iterationDelayMs ?? 1200;
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

    DebugLog.systemEvent('ReActLoop', `START goal="${goal.slice(0, 80)}" app="${appHint || 'any'}"`);

    let observation = await this.observe();
    let stuckCount = 0;
    let lastTreePrefix = '';

    for (let iteration = 1; iteration <= this.maxIterations; iteration++) {
      const prompt = this.buildPrompt(goal, observation, steps);
      let reasoning: string;
      try {
        reasoning = await this.aiCall(prompt);
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
      await this.sleep(this.iterationDelayMs);
      const newObservation = await this.observe();
      const uiChanged = newObservation !== beforeObservation;

      steps.push({ iteration, observation, reasoning, action, actionResult, uiChanged });
      DebugLog.systemEvent('ReActLoop', `STEP ${iteration}: "${action}" result=${actionResult} uiChanged=${uiChanged}`);

      const treePrefix = newObservation.slice(0, 80);
      if (treePrefix === lastTreePrefix) {
        stuckCount++;
        if (stuckCount >= 2) {
          await AppController.performScroll('forward' as any);
          await this.sleep(600);
          stuckCount = 0;
        }
      } else {
        stuckCount = 0;
      }
      lastTreePrefix = treePrefix;
      observation = newObservation;
    }

    const goalAchieved = await this.checkCompletion(goal, observation);
    DebugLog.systemEvent('ReActLoop', `COMPLETE goalAchieved=${goalAchieved} steps=${steps.length}`);
    return { success: goalAchieved, steps, finalObservation: observation, goalAchieved };
  }

  private async observe(): Promise<string> {
    try {
      const flat = await getScreenContentFlat();
      const nodes = JSON.parse(flat) as Array<{
        i: number; t: string; d: string;
        c: boolean; e: boolean; s: boolean;
        x: number; y: number;
      }>;
      if (nodes.length === 0) return 'Screen: empty or inaccessible';
      return nodes.map(n => {
        const label = (n.t || n.d || '').slice(0, 60);
        const flags: string[] = [];
        if (n.c) flags.push('tap');
        if (n.e) flags.push('type');
        if (n.s) flags.push('scroll');
        return `[${n.i}] "${label}" [${flags.join(',') || 'view'}] @(${n.x},${n.y})`;
      }).join('\n');
    } catch {
      try {
        const tree = await AppController.getScreenContent();
        return typeof tree === 'string' ? (tree as string).slice(0, 1500) : JSON.stringify(tree).slice(0, 1500);
      } catch {
        return 'Screen: observation failed';
      }
    }
  }

  private buildPrompt(goal: string, observation: string, history: ReActStep[]): string {
    const recentHistory = history.slice(-3).map(s =>
      `Step ${s.iteration}: ${s.action} -> ${s.actionResult ? 'ok' : 'fail'}${s.uiChanged ? ' (screen changed)' : ' (no change)'}`
    ).join('\n') || 'None';

    return `You are controlling an Android phone. Analyze the screen and choose ONE action.

GOAL: ${goal}

CURRENT SCREEN (index, label, capabilities, coordinates):
${observation.slice(0, 2500)}

RECENT ACTIONS:
${recentHistory}

AVAILABLE ACTIONS:
- tap(x,y) - tap screen coordinates
- tap_index(N) - tap element by index [N]
- type("text") - type into focused field
- scroll(down) or scroll(up)
- swipe(x1,y1,x2,y2)
- back()
- home()
- done - goal is achieved

RULES:
1. Identify elements by label and index number.
2. Choose the single most direct action toward the goal.
3. If goal achieved: ACTION: done
4. Never repeat an action that had no effect.
5. If element not visible, scroll first.
6. Prefer tap_index(N) over coordinates when possible.

RESPOND WITH:
REASONING: <brief analysis>
ACTION: <single action command>`;
  }

  private extractAction(text: string): string | null {
    const match = text.match(/^ACTION:\s*(.+)$/im);
    return match ? match[1].trim() : null;
  }

  private async executeAction(action: string): Promise<boolean> {
    const a = action.trim();
    try {
      if (/^back\(\)$/i.test(a) || /^back$/i.test(a)) return await AppController.performBack();
      if (/^home\(\)$/i.test(a) || /^home$/i.test(a)) return await AppController.performHome();

      const scrollMatch = a.match(/^scroll\((up|down|forward|backward)\)$/i);
      if (scrollMatch) {
        const dir = scrollMatch[1].toLowerCase();
        return await AppController.performScroll(dir === 'up' ? 'backward' as any : 'forward' as any);
      }

      const tapMatch = a.match(/^tap\(\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
      if (tapMatch) return await performTap(parseInt(tapMatch[1]), parseInt(tapMatch[2]));

      const tapIdxMatch = a.match(/^tap_index\(\s*(\d+)\s*\)$/i);
      if (tapIdxMatch) {
        const idx = parseInt(tapIdxMatch[1]);
        const flat = await getScreenContentFlat();
        const nodes = JSON.parse(flat) as Array<{ i: number; x: number; y: number }>;
        const node = nodes.find(n => n.i === idx);
        if (node) return await performTap(node.x, node.y);
        return false;
      }

      const typeMatch = a.match(/^type\(\s*["']?(.+?)["']?\s*\)$/i);
      if (typeMatch) return await AppController.performText('', typeMatch[1]);

      const swipeMatch = a.match(/^swipe\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
      if (swipeMatch) {
        return await performSwipe(
          parseInt(swipeMatch[1]), parseInt(swipeMatch[2]),
          parseInt(swipeMatch[3]), parseInt(swipeMatch[4]),
          350
        );
      }

      DebugLog.error('ReActLoop', `Unknown action: ${a}`);
      return false;
    } catch (err: any) {
      DebugLog.error('ReActLoop', `Action error: ${err.message}`);
      return false;
    }
  }

  private async checkCompletion(goal: string, observation: string): Promise<boolean> {
    try {
      const prompt = `Goal: "${goal}"\nCurrent screen:\n${observation.slice(0, 800)}\n\nIs the goal fully achieved? Reply YES or NO only.`;
      const response = await this.aiCall(prompt);
      return /^yes/i.test(response.trim());
    } catch {
      return false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
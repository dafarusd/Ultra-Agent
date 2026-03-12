import { Platform } from 'react-native';
import type { AppControllerInterface, UINode } from '../native/AppController';
import type { TaskChallenge, ChallengeResult, ChallengeStep, SuccessCriterion, OverallEvaluation } from './TaskChallenges';

const isNative = Platform.OS !== 'web';

interface InstallerInterface {
  installApk: (path: string) => Promise<void>;
}

type ProgressCallback = (phase: string, message: string) => void;

function uiNodeToText(node: UINode): string {
  const parts: string[] = [];
  if (node.text) parts.push(node.text);
  if (node.contentDescription) parts.push(node.contentDescription);
  for (const child of node.children) {
    parts.push(uiNodeToText(child));
  }
  return parts.join(' ');
}

export class TaskEvaluator {
  private appController: AppControllerInterface | null = null;
  private installer: InstallerInterface | null = null;

  constructor(
    appController?: AppControllerInterface,
    installer?: InstallerInterface
  ) {
    this.appController = appController || null;
    this.installer = installer || null;
  }

  async evaluateOffspring(
    packageName: string,
    apkPath: string,
    challenges: TaskChallenge[],
    onProgress?: ProgressCallback
  ): Promise<OverallEvaluation> {
    if (!isNative || !this.appController) {
      return this.createWebFallbackResult(challenges);
    }

    onProgress?.('installing', 'Installing offspring APK...');
    try {
      if (this.installer) {
        await this.installer.installApk(apkPath);
        await this.delay(3000);
      }
    } catch (e) {
      return this.createFailedResult(challenges, `Install failed: ${(e as Error).message}`);
    }

    await this.appController.allowPackage(packageName);

    const results: ChallengeResult[] = [];
    let totalCrashes = 0;
    const overallStart = Date.now();

    for (let i = 0; i < challenges.length; i++) {
      const challenge = challenges[i];
      onProgress?.('testing', `Challenge ${i + 1}/${challenges.length}: ${challenge.name}`);

      const result = await this.runChallenge(packageName, challenge);
      results.push(result);
      totalCrashes += result.crashCount;

      if (result.crashCount > 2) {
        onProgress?.('testing', `Too many crashes on ${challenge.name}, skipping remaining`);
        for (let j = i + 1; j < challenges.length; j++) {
          results.push(this.createSkippedResult(challenges[j], 'Skipped due to excessive crashes'));
        }
        break;
      }
    }

    const totalTimeMs = Date.now() - overallStart;
    const totalWeight = results.reduce((sum, _r, i) => sum + (challenges[i]?.weight ?? 1), 0);
    const weightedScore = results.reduce((sum, r, i) => {
      const weight = challenges[i]?.weight ?? 1;
      return sum + r.partialScore * (weight / totalWeight);
    }, 0);

    const passedCount = results.filter(r => r.passed).length;

    return {
      results,
      overallPassRate: passedCount / Math.max(results.length, 1),
      weightedScore,
      totalCrashes,
      totalTimeMs,
    };
  }

  private async runChallenge(
    packageName: string,
    challenge: TaskChallenge
  ): Promise<ChallengeResult> {
    const startTime = Date.now();
    const screenCaptures: string[] = [];
    let crashCount = 0;
    const criteriaResults: Array<{ criterion: string; passed: boolean }> = [];

    const abortController = new AbortController();
    const { signal } = abortController;

    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      const t = setTimeout(() => resolve('timeout'), challenge.timeoutMs);
      signal.addEventListener('abort', () => clearTimeout(t));
    });

    const runPromise = (async (): Promise<'done'> => {
      for (const step of challenge.steps) {
        if (signal.aborted) break;
        try {
          await this.executeStep(packageName, step);
        } catch (e) {
          crashCount++;
        }

        if (signal.aborted) break;
        if (step.action === 'verify' || step.action === 'wait') {
          try {
            const isForeground = await this.checkForeground(packageName);
            if (!isForeground) {
              crashCount++;
              break;
            }
            const screen = await this.captureScreen();
            if (screen) screenCaptures.push(screen);
          } catch {
            crashCount++;
          }
        }
      }
      return 'done';
    })();

    const raceResult = await Promise.race([runPromise, timeoutPromise]);
    if (raceResult === 'timeout') {
      abortController.abort();
      crashCount++;
    }

    for (const criterion of challenge.successCriteria) {
      try {
        const met = await this.checkCriterion(packageName, criterion, screenCaptures, crashCount);
        criteriaResults.push({ criterion: criterion.description, passed: met });
      } catch {
        criteriaResults.push({ criterion: criterion.description, passed: false });
      }
    }

    const criterionPassRate = criteriaResults.filter(c => c.passed).length / Math.max(criteriaResults.length, 1);
    const passed = criteriaResults.every(c => c.passed) && crashCount === 0;

    let partialScore = criterionPassRate;
    if (crashCount > 0) partialScore *= Math.max(0, 1 - crashCount * 0.3);
    if (raceResult === 'timeout') partialScore *= 0.5;

    return {
      challengeId: challenge.id,
      passed,
      partialScore: Math.max(0, Math.min(1, partialScore)),
      executionTimeMs: Date.now() - startTime,
      crashCount,
      screenCaptures,
      criteriaResults,
    };
  }

  private async executeStep(packageName: string, step: ChallengeStep): Promise<void> {
    if (!this.appController) return;

    switch (step.action) {
      case 'launch': {
        const IntentLauncher = await import('expo-intent-launcher');
        await IntentLauncher.startActivityAsync('android.intent.action.MAIN', {
          packageName,
        });
        await this.delay(1000);
        break;
      }
      case 'click':
        if (step.selector) {
          await this.appController.performClick(step.selector);
        }
        break;
      case 'type':
        if (step.selector && step.text) {
          await this.appController.performText(step.selector, step.text);
        }
        break;
      case 'scroll':
        await this.appController.performScroll(step.direction || 'down');
        break;
      case 'back':
        await this.appController.performBack();
        break;
      case 'home':
        await this.appController.performHome();
        break;
      case 'wait':
        await this.delay(step.waitMs || 1000);
        break;
      case 'verify':
        break;
    }
  }

  private async checkCriterion(
    packageName: string,
    criterion: SuccessCriterion,
    screenCaptures: string[],
    crashCount: number
  ): Promise<boolean> {
    switch (criterion.type) {
      case 'app_foreground': {
        try {
          if (this.appController) {
            const active = await this.appController.getActivePackage();
            return active === (criterion.value || packageName);
          }
        } catch {}
        return screenCaptures.length > 0;
      }
      case 'no_crash':
        return crashCount === 0;
      case 'screen_contains': {
        if (!criterion.value) return true;
        const target = criterion.value.toLowerCase();
        return screenCaptures.some(s => s.toLowerCase().includes(target));
      }
      case 'screen_not_contains': {
        if (!criterion.value) return true;
        const target = criterion.value.toLowerCase();
        return !screenCaptures.some(s => s.toLowerCase().includes(target));
      }
      default:
        return false;
    }
  }

  private async checkForeground(packageName: string): Promise<boolean> {
    if (!this.appController) return false;
    try {
      const active = await this.appController.getActivePackage();
      return active === packageName;
    } catch {
      return false;
    }
  }

  private async captureScreen(): Promise<string | null> {
    if (!this.appController) return null;
    try {
      const uiNode = await this.appController.getScreenContent();
      return uiNodeToText(uiNode);
    } catch {
      return null;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private createWebFallbackResult(challenges: TaskChallenge[]): OverallEvaluation {
    const results: ChallengeResult[] = challenges.map(c => ({
      challengeId: c.id,
      passed: false,
      partialScore: 0,
      executionTimeMs: 0,
      crashCount: 0,
      screenCaptures: [],
      error: 'Task evaluation requires Android device',
      criteriaResults: c.successCriteria.map(cr => ({ criterion: cr.description, passed: false })),
    }));
    return { results, overallPassRate: 0, weightedScore: 0, totalCrashes: 0, totalTimeMs: 0 };
  }

  private createFailedResult(challenges: TaskChallenge[], error: string): OverallEvaluation {
    const results: ChallengeResult[] = challenges.map(c => ({
      challengeId: c.id,
      passed: false,
      partialScore: 0,
      executionTimeMs: 0,
      crashCount: 1,
      screenCaptures: [],
      error,
      criteriaResults: c.successCriteria.map(cr => ({ criterion: cr.description, passed: false })),
    }));
    return { results, overallPassRate: 0, weightedScore: 0, totalCrashes: challenges.length, totalTimeMs: 0 };
  }

  private createSkippedResult(challenge: TaskChallenge, error: string): ChallengeResult {
    return {
      challengeId: challenge.id,
      passed: false,
      partialScore: 0,
      executionTimeMs: 0,
      crashCount: 0,
      screenCaptures: [],
      error,
      criteriaResults: challenge.successCriteria.map(cr => ({ criterion: cr.description, passed: false })),
    };
  }
}

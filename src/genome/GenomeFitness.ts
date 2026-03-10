import type { Genome, FitnessMetrics, TaskPerformance } from './types';
import type { OverallEvaluation } from './TaskChallenges';

export class GenomeFitness {
  async evaluate(
    genome: Genome,
    buildResult: {
      success: boolean;
      compilationTimeMs: number;
      apkPath?: string;
      apkSizeBytes?: number;
      errors: string[];
    },
    testResults?: {
      installSuccess: boolean;
      launchSuccess: boolean;
      testsPassed: number;
      testsTotal: number;
      runtimeCrashes: number;
    }
  ): Promise<FitnessMetrics> {
    const metrics: FitnessMetrics = {
      buildSuccess: buildResult.success,
      compilationTimeMs: buildResult.compilationTimeMs,
      apkSizeBytes: buildResult.apkSizeBytes || 0,
      installSuccess: testResults?.installSuccess ?? false,
      launchSuccess: testResults?.launchSuccess ?? false,
      testsPassed: testResults?.testsPassed ?? 0,
      testsTotal: testResults?.testsTotal ?? 0,
      runtimeCrashes: testResults?.runtimeCrashes ?? 0,
      capabilityScore: this.computeCapabilityScore(genome, testResults),
      overallScore: 0,
      evaluatedAt: Date.now(),
      taskPerformance: null,
    };

    metrics.overallScore = this.computeOverallScore(metrics);
    return metrics;
  }

  async evaluateWithTasks(
    genome: Genome,
    buildResult: {
      success: boolean;
      compilationTimeMs: number;
      apkPath?: string;
      apkSizeBytes?: number;
      errors: string[];
    },
    taskEvaluation: OverallEvaluation
  ): Promise<FitnessMetrics> {
    const failedChallenges = taskEvaluation.results
      .filter(r => !r.passed)
      .map(r => r.challengeId);

    const totalTime = taskEvaluation.results.reduce((s, r) => s + r.executionTimeMs, 0);
    const avgTime = taskEvaluation.results.length > 0 ? totalTime / taskEvaluation.results.length : 0;

    const taskPerf: TaskPerformance = {
      challengesPassed: taskEvaluation.results.filter(r => r.passed).length,
      challengesTotal: taskEvaluation.results.length,
      weightedScore: taskEvaluation.weightedScore,
      failedChallenges,
      averageTimeMs: avgTime,
    };

    const launchResult = taskEvaluation.results.find(r => r.challengeId === 'ch_launch_verify');
    const anyRealTest = taskEvaluation.results.some(r => !r.error?.includes('requires Android device'));
    const installSuccess = anyRealTest && taskEvaluation.totalCrashes < taskEvaluation.results.length;
    const launchSuccess = anyRealTest && (launchResult ? launchResult.passed : taskEvaluation.overallPassRate > 0);

    const metrics: FitnessMetrics = {
      buildSuccess: buildResult.success,
      compilationTimeMs: buildResult.compilationTimeMs,
      apkSizeBytes: buildResult.apkSizeBytes || 0,
      installSuccess,
      launchSuccess,
      testsPassed: taskPerf.challengesPassed,
      testsTotal: taskPerf.challengesTotal,
      runtimeCrashes: taskEvaluation.totalCrashes,
      capabilityScore: this.computeCapabilityScore(genome),
      overallScore: 0,
      evaluatedAt: Date.now(),
      taskPerformance: taskPerf,
    };

    metrics.overallScore = this.computeTaskAwareScore(metrics, taskEvaluation);
    return metrics;
  }

  private computeCapabilityScore(
    genome: Genome,
    testResults?: { testsPassed: number; testsTotal: number }
  ): number {
    if (testResults && testResults.testsTotal > 0) {
      return testResults.testsPassed / testResults.testsTotal;
    }
    const essential = genome.capabilities.filter(c => c.essential);
    const present = essential.filter(c => c.sources.some(s => s.content || s.generatedBy === 'fixed'));
    return present.length / Math.max(essential.length, 1);
  }

  private computeOverallScore(m: FitnessMetrics): number {
    let score = 0;

    if (!m.buildSuccess) return 5;

    score += 30;

    if (m.installSuccess) score += 15;

    if (m.launchSuccess) score += 15;

    if (m.testsTotal > 0) {
      score += 25 * (m.testsPassed / m.testsTotal);
    } else {
      score += 10;
    }

    score += 10 * m.capabilityScore;

    if (m.runtimeCrashes > 0) score -= Math.min(15, m.runtimeCrashes * 5);

    if (m.compilationTimeMs > 30000) score -= 2;
    if (m.compilationTimeMs > 60000) score -= 3;

    if (m.apkSizeBytes > 10 * 1024 * 1024) score -= 2;

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  private computeTaskAwareScore(m: FitnessMetrics, taskEval: OverallEvaluation): number {
    let score = 0;

    if (!m.buildSuccess) return 5;

    score += 15;

    if (m.installSuccess) score += 10;

    if (m.launchSuccess) score += 10;

    score += 35 * taskEval.overallPassRate;

    score += 15 * taskEval.weightedScore;

    score += 10 * m.capabilityScore;

    if (m.runtimeCrashes > 0) score -= Math.min(20, m.runtimeCrashes * 4);

    if (m.compilationTimeMs > 30000) score -= 2;
    if (m.compilationTimeMs > 60000) score -= 3;

    if (m.apkSizeBytes > 10 * 1024 * 1024) score -= 2;

    if (taskEval.totalTimeMs > 120000) score -= 3;

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  compare(a: FitnessMetrics, b: FitnessMetrics): number {
    return b.overallScore - a.overallScore;
  }

  compareGenerations(
    parent: FitnessMetrics,
    offspring: FitnessMetrics
  ): {
    improved: boolean;
    delta: number;
    breakdown: Array<{ metric: string; parent: number; offspring: number; change: number }>;
  } {
    const delta = offspring.overallScore - parent.overallScore;
    const breakdown: Array<{ metric: string; parent: number; offspring: number; change: number }> = [];

    const addMetric = (name: string, pVal: number, oVal: number) => {
      breakdown.push({ metric: name, parent: pVal, offspring: oVal, change: oVal - pVal });
    };

    addMetric('overallScore', parent.overallScore, offspring.overallScore);
    addMetric('testsPassed', parent.testsPassed, offspring.testsPassed);
    addMetric('runtimeCrashes', parent.runtimeCrashes, offspring.runtimeCrashes);
    addMetric('capabilityScore', parent.capabilityScore, offspring.capabilityScore);

    if (parent.taskPerformance && offspring.taskPerformance) {
      addMetric('taskPassRate',
        parent.taskPerformance.challengesPassed / Math.max(parent.taskPerformance.challengesTotal, 1),
        offspring.taskPerformance.challengesPassed / Math.max(offspring.taskPerformance.challengesTotal, 1)
      );
      addMetric('taskWeightedScore', parent.taskPerformance.weightedScore, offspring.taskPerformance.weightedScore);
    }

    return { improved: delta > 0, delta, breakdown };
  }
}

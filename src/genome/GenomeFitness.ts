import type { Genome, FitnessMetrics } from './types';

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
    };

    metrics.overallScore = this.computeOverallScore(metrics);
    return metrics;
  }

  private computeCapabilityScore(
    genome: Genome,
    testResults?: { testsPassed: number; testsTotal: number }
  ): number {
    if (!testResults || testResults.testsTotal === 0) {
      const essential = genome.capabilities.filter(c => c.essential);
      const present = essential.filter(c => c.sources.some(s => s.content || s.generatedBy === 'fixed'));
      return present.length / Math.max(essential.length, 1);
    }
    return testResults.testsPassed / testResults.testsTotal;
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

  compare(a: FitnessMetrics, b: FitnessMetrics): number {
    return b.overallScore - a.overallScore;
  }
}

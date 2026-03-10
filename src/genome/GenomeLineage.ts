import type { Genome, MutationRecord, FitnessMetrics, TaskPerformance } from './types';
import { createHash } from '../utils/crypto';

export interface LineageNode {
  genomeId: string;
  generation: number;
  parentId: string | null;
  lineageHash: string;
  createdAt: number;
  mutationCount: number;
  fitness: FitnessMetrics | null;
  mutations: MutationRecord[];
  taskPerformance: TaskPerformance | null;
}

export class GenomeLineage {
  private nodes: Map<string, LineageNode> = new Map();

  record(genome: Genome): void {
    this.nodes.set(genome.id, {
      genomeId: genome.id,
      generation: genome.generation,
      parentId: genome.parentId,
      lineageHash: genome.lineageHash,
      createdAt: genome.createdAt,
      mutationCount: genome.mutations.length,
      fitness: genome.fitness,
      mutations: genome.mutations,
      taskPerformance: genome.fitness?.taskPerformance ?? null,
    });
  }

  getAncestry(genomeId: string): LineageNode[] {
    const chain: LineageNode[] = [];
    let current = this.nodes.get(genomeId);
    while (current) {
      chain.unshift(current);
      current = current.parentId ? this.nodes.get(current.parentId) : undefined;
    }
    return chain;
  }

  verifyChain(genomeId: string): { valid: boolean; brokenAt?: string } {
    const chain = this.getAncestry(genomeId);
    for (let i = 1; i < chain.length; i++) {
      const parent = chain[i - 1];
      const child = chain[i];
      if (child.parentId !== parent.genomeId) {
        return { valid: false, brokenAt: child.genomeId };
      }
    }
    return { valid: true };
  }

  getFitnessTrajectory(genomeId: string): Array<{ generation: number; score: number }> {
    return this.getAncestry(genomeId)
      .filter(n => n.fitness !== null)
      .map(n => ({
        generation: n.generation,
        score: n.fitness!.overallScore,
      }));
  }

  getTaskPerformanceTrajectory(genomeId: string): Array<{
    generation: number;
    passRate: number;
    weightedScore: number;
    challengesPassed: number;
    challengesTotal: number;
  }> {
    return this.getAncestry(genomeId)
      .filter(n => n.taskPerformance !== null)
      .map(n => {
        const tp = n.taskPerformance!;
        return {
          generation: n.generation,
          passRate: tp.challengesTotal > 0 ? tp.challengesPassed / tp.challengesTotal : 0,
          weightedScore: tp.weightedScore,
          challengesPassed: tp.challengesPassed,
          challengesTotal: tp.challengesTotal,
        };
      });
  }

  getCapabilityGrowth(genomeId: string): Array<{
    generation: number;
    newlyPassed: string[];
    newlyFailed: string[];
    totalPassed: number;
  }> {
    const ancestry = this.getAncestry(genomeId).filter(n => n.taskPerformance !== null);
    const growth: Array<{
      generation: number;
      newlyPassed: string[];
      newlyFailed: string[];
      totalPassed: number;
    }> = [];

    let previousFailed = new Set<string>();
    let previousAllChallenges = new Set<string>();

    for (const node of ancestry) {
      const tp = node.taskPerformance!;
      const currentFailed = new Set(tp.failedChallenges);
      const currentAll = new Set([...tp.failedChallenges]);

      const newlyPassed: string[] = [];
      const newlyFailed: string[] = [];

      for (const prev of previousFailed) {
        if (!currentFailed.has(prev)) {
          newlyPassed.push(prev);
        }
      }

      for (const curr of currentFailed) {
        if (!previousFailed.has(curr) && previousAllChallenges.size > 0) {
          newlyFailed.push(curr);
        }
      }

      growth.push({
        generation: node.generation,
        newlyPassed,
        newlyFailed,
        totalPassed: tp.challengesPassed,
      });

      previousFailed = currentFailed;
      previousAllChallenges = currentAll;
    }

    return growth;
  }

  getFailurePatterns(): Array<{
    challengeId: string;
    failureCount: number;
    totalGenerations: number;
    failureRate: number;
  }> {
    const failureCounts = new Map<string, number>();
    let generationsWithTasks = 0;

    for (const node of this.nodes.values()) {
      if (!node.taskPerformance) continue;
      generationsWithTasks++;
      for (const failedId of node.taskPerformance.failedChallenges) {
        failureCounts.set(failedId, (failureCounts.get(failedId) || 0) + 1);
      }
    }

    const patterns: Array<{
      challengeId: string;
      failureCount: number;
      totalGenerations: number;
      failureRate: number;
    }> = [];

    for (const [challengeId, count] of failureCounts) {
      patterns.push({
        challengeId,
        failureCount: count,
        totalGenerations: generationsWithTasks,
        failureRate: count / Math.max(generationsWithTasks, 1),
      });
    }

    return patterns.sort((a, b) => b.failureRate - a.failureRate);
  }

  getBestGeneration(): LineageNode | null {
    let best: LineageNode | null = null;
    let bestScore = -1;

    for (const node of this.nodes.values()) {
      if (node.fitness && node.fitness.overallScore > bestScore) {
        bestScore = node.fitness.overallScore;
        best = node;
      }
    }

    return best;
  }

  getBeneficialMutations(): MutationRecord[] {
    const all: MutationRecord[] = [];
    for (const node of this.nodes.values()) {
      for (const mut of node.mutations) {
        if (mut.fitnessImpact !== null && mut.fitnessImpact > 0) {
          all.push(mut);
        }
      }
    }
    return all.sort((a, b) => (b.fitnessImpact || 0) - (a.fitnessImpact || 0));
  }

  serialize(): string {
    const entries: LineageNode[] = [];
    this.nodes.forEach(n => entries.push(n));
    return JSON.stringify(entries);
  }

  deserialize(json: string): void {
    const entries = JSON.parse(json) as LineageNode[];
    this.nodes.clear();
    for (const e of entries) this.nodes.set(e.genomeId, e);
  }
}

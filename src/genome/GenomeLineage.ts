import type { Genome, MutationRecord, FitnessMetrics } from './types';
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

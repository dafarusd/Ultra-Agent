import type {
  Genome, MutationRequest, MutationResult, MutationRecord, Capability,
} from './types';
import { GenomeValidator } from './GenomeValidator';
import { createHash } from '../utils/crypto';

interface AiClient {
  chat: (args: { model: string; messages: Array<{ role: string; content: string }>; max_tokens: number }) => Promise<string>;
}

export class GenomeMutator {
  private validator: GenomeValidator;

  constructor(
    private ai: AiClient,
    private getModel: () => Promise<string>
  ) {
    this.validator = new GenomeValidator();
  }

  async proposeMutations(genome: Genome, userGoal?: string): Promise<MutationRequest[]> {
    const model = await this.getModel();
    const capSummary = genome.capabilities
      .map(c => `- ${c.id} (${c.category}, mutable=${c.mutable}): ${c.name}`)
      .join('\n');

    const prompt = userGoal
      ? `The user wants: ${userGoal}\n\nAnalyze the genome and propose mutations to achieve this goal.`
      : `Analyze this genome for improvement opportunities. Consider: missing capabilities, configuration improvements, behavioral enhancements.`;

    const response = await this.ai.chat({
      model,
      messages: [
        {
          role: 'system',
          content: `You are a genome engineer for a self-improving Android agent. You analyze agent genomes and propose structured mutations.

RULES:
- NEVER propose removing or modifying capabilities where mutable=false
- NEVER propose removing safety invariants
- NEVER propose removing capabilities where essential=true
- Mutations must be specific and actionable
- Each mutation must have a clear reason

Valid operations: add_capability, remove_capability, modify_capability, update_config, add_permission, remove_permission, add_behavior, modify_behavior, update_ai_config, update_safety

Respond with a JSON array of mutation requests:
[{"operation": "...", "target": "...", "payload": {...}, "reason": "..."}]
No markdown. No explanation. Just the JSON array.`,
        },
        {
          role: 'user',
          content: `${prompt}

Current genome capabilities:
${capSummary}

Current fitness: ${genome.fitness ? JSON.stringify(genome.fitness) : 'Not evaluated'}
Generation: ${genome.generation}
Mutation history length: ${genome.mutations.length}`,
        },
      ],
      max_tokens: 2000,
    });

    try {
      let cleaned = response.trim();
      const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenced) cleaned = fenced[1].trim();
      const requests = JSON.parse(cleaned) as MutationRequest[];

      const immutableIds = new Set(
        genome.capabilities.filter(c => !c.mutable).map(c => c.id)
      );

      return requests.filter(r => {
        if (r.operation === 'remove_capability' && immutableIds.has(r.target)) return false;
        if (r.operation === 'modify_capability' && immutableIds.has(r.target)) return false;
        return true;
      });
    } catch {
      return [];
    }
  }

  apply(genome: Genome, request: MutationRequest): MutationResult {
    const mutated: Genome = JSON.parse(JSON.stringify(genome));
    const parentHash = genome.lineageHash;

    try {
      switch (request.operation) {
        case 'add_capability':
          return this.addCapability(genome, mutated, request, parentHash);
        case 'remove_capability':
          return this.removeCapability(genome, mutated, request, parentHash);
        case 'modify_capability':
          return this.modifyCapability(genome, mutated, request, parentHash);
        case 'update_config':
          return this.updateConfig(genome, mutated, request, parentHash);
        case 'add_permission':
          return this.addPermission(genome, mutated, request, parentHash);
        case 'remove_permission':
          return this.removePermission(genome, mutated, request, parentHash);
        case 'add_behavior':
          return this.addBehavior(genome, mutated, request, parentHash);
        case 'modify_behavior':
          return this.modifyBehavior(genome, mutated, request, parentHash);
        case 'update_ai_config':
          return this.updateAiConfig(genome, mutated, request, parentHash);
        case 'update_safety':
          return this.updateSafety(genome, mutated, request, parentHash);
        default:
          return { success: false, genome: null, violations: [`Unknown operation: ${request.operation}`], warnings: [] };
      }
    } catch (e) {
      return { success: false, genome: null, violations: [(e as Error).message], warnings: [] };
    }
  }

  applyAll(genome: Genome, requests: MutationRequest[]): MutationResult {
    let current = genome;
    const allWarnings: string[] = [];

    for (const req of requests) {
      const result = this.apply(current, req);
      if (!result.success) return result;
      allWarnings.push(...result.warnings);
      current = result.genome!;
    }

    return { success: true, genome: current, violations: [], warnings: allWarnings };
  }

  private addCapability(original: Genome, mutated: Genome, req: MutationRequest, parentHash: string): MutationResult {
    const cap = req.payload as Capability;
    if (mutated.capabilities.some(c => c.id === cap.id)) {
      return { success: false, genome: null, violations: [`Capability ${cap.id} already exists`], warnings: [] };
    }
    mutated.capabilities.push(cap);
    return this.finalizeMutation(original, mutated, req, parentHash);
  }

  private removeCapability(original: Genome, mutated: Genome, req: MutationRequest, parentHash: string): MutationResult {
    const target = req.target;
    const cap = mutated.capabilities.find(c => c.id === target);
    if (!cap) return { success: false, genome: null, violations: [`Capability ${target} not found`], warnings: [] };
    if (!cap.mutable) return { success: false, genome: null, violations: [`Capability ${target} is immutable`], warnings: [] };
    if (cap.essential) return { success: false, genome: null, violations: [`Capability ${target} is essential`], warnings: [] };
    mutated.capabilities = mutated.capabilities.filter(c => c.id !== target);
    return this.finalizeMutation(original, mutated, req, parentHash);
  }

  private modifyCapability(original: Genome, mutated: Genome, req: MutationRequest, parentHash: string): MutationResult {
    const idx = mutated.capabilities.findIndex(c => c.id === req.target);
    if (idx === -1) return { success: false, genome: null, violations: [`Capability ${req.target} not found`], warnings: [] };
    if (!mutated.capabilities[idx].mutable) {
      return { success: false, genome: null, violations: [`Capability ${req.target} is immutable`], warnings: [] };
    }
    mutated.capabilities[idx] = { ...mutated.capabilities[idx], ...req.payload };
    mutated.capabilities[idx].id = req.target;
    return this.finalizeMutation(original, mutated, req, parentHash);
  }

  private updateConfig(original: Genome, mutated: Genome, req: MutationRequest, parentHash: string): MutationResult {
    const { capabilityId, key, value } = req.payload;
    const cap = mutated.capabilities.find(c => c.id === capabilityId);
    if (!cap) return { success: false, genome: null, violations: [`Capability ${capabilityId} not found`], warnings: [] };
    if (!cap.config[key]?.mutable) {
      return { success: false, genome: null, violations: [`Config "${key}" on ${capabilityId} is not mutable`], warnings: [] };
    }
    cap.config[key] = { ...cap.config[key], value };
    return this.finalizeMutation(original, mutated, req, parentHash);
  }

  private addPermission(original: Genome, mutated: Genome, req: MutationRequest, parentHash: string): MutationResult {
    const perm = req.payload as string;
    if (!mutated.manifest.permissions.includes(perm)) {
      mutated.manifest.permissions.push(perm);
    }
    return this.finalizeMutation(original, mutated, req, parentHash);
  }

  private removePermission(original: Genome, mutated: Genome, req: MutationRequest, parentHash: string): MutationResult {
    const perm = req.payload as string;
    for (const cap of mutated.capabilities) {
      if (cap.permissions.includes(perm)) {
        return { success: false, genome: null, violations: [`Permission ${perm} required by capability ${cap.id}`], warnings: [] };
      }
    }
    mutated.manifest.permissions = mutated.manifest.permissions.filter(p => p !== perm);
    return this.finalizeMutation(original, mutated, req, parentHash);
  }

  private addBehavior(original: Genome, mutated: Genome, req: MutationRequest, parentHash: string): MutationResult {
    mutated.behaviorSpecs.push(req.payload as any);
    return this.finalizeMutation(original, mutated, req, parentHash);
  }

  private modifyBehavior(original: Genome, mutated: Genome, req: MutationRequest, parentHash: string): MutationResult {
    const idx = mutated.behaviorSpecs.findIndex(b => b.id === req.target);
    if (idx === -1) return { success: false, genome: null, violations: [`Behavior ${req.target} not found`], warnings: [] };
    mutated.behaviorSpecs[idx] = { ...mutated.behaviorSpecs[idx], ...req.payload };
    return this.finalizeMutation(original, mutated, req, parentHash);
  }

  private updateAiConfig(original: Genome, mutated: Genome, req: MutationRequest, parentHash: string): MutationResult {
    mutated.ai = { ...mutated.ai, ...req.payload };
    return this.finalizeMutation(original, mutated, req, parentHash);
  }

  private updateSafety(original: Genome, mutated: Genome, req: MutationRequest, parentHash: string): MutationResult {
    const payload = req.payload as Partial<Genome['safety']>;
    if (payload.approvalRequired) {
      for (const item of payload.approvalRequired) {
        if (!mutated.safety.approvalRequired.includes(item)) {
          mutated.safety.approvalRequired.push(item);
        }
      }
    }
    if (payload.blocked) {
      for (const item of payload.blocked) {
        if (!mutated.safety.blocked.includes(item)) {
          mutated.safety.blocked.push(item);
        }
      }
    }
    if (payload.invariants) {
      for (const inv of payload.invariants) {
        if (!mutated.safety.invariants.some(i => i.id === inv.id)) {
          mutated.safety.invariants.push(inv);
        }
      }
    }
    return this.finalizeMutation(original, mutated, req, parentHash);
  }

  private finalizeMutation(original: Genome, mutated: Genome, req: MutationRequest, parentHash: string): MutationResult {
    const record: MutationRecord = {
      id: `mut_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      operation: req.operation,
      target: req.target,
      description: req.reason,
      diff: this.computeDiff(original, mutated),
      parentGenomeHash: parentHash,
      resultGenomeHash: '',
      fitnessImpact: null,
    };
    mutated.mutations.push(record);
    mutated.lineageHash = createHash(parentHash + JSON.stringify(mutated));
    record.resultGenomeHash = mutated.lineageHash;

    return this.validator.validateMutation(original, mutated);
  }

  private computeDiff(a: Genome, b: Genome): string {
    const changes: string[] = [];
    if (a.capabilities.length !== b.capabilities.length) {
      changes.push(`capabilities: ${a.capabilities.length} -> ${b.capabilities.length}`);
    }
    if (a.manifest.permissions.length !== b.manifest.permissions.length) {
      changes.push(`permissions: ${a.manifest.permissions.length} -> ${b.manifest.permissions.length}`);
    }
    if (a.behaviorSpecs.length !== b.behaviorSpecs.length) {
      changes.push(`behaviorSpecs: ${a.behaviorSpecs.length} -> ${b.behaviorSpecs.length}`);
    }
    if (JSON.stringify(a.ai) !== JSON.stringify(b.ai)) {
      changes.push('ai config changed');
    }
    if (JSON.stringify(a.safety) !== JSON.stringify(b.safety)) {
      changes.push('safety config changed');
    }
    return changes.join('; ') || 'no structural changes';
  }
}

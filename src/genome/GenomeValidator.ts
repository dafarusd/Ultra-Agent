import type { Genome, MutationResult } from './types';

export class GenomeValidator {
  validate(genome: Genome): { violations: string[]; warnings: string[] } {
    const violations: string[] = [];
    const warnings: string[] = [];

    for (const inv of genome.safety.invariants) {
      const holds = this.checkPredicate(inv.predicate, genome);
      if (!holds) {
        const msg = `Invariant "${inv.id}" violated: ${inv.description}`;
        if (inv.enforcement === 'reject') violations.push(msg);
        else warnings.push(msg);
      }
    }

    const capIds = new Set(genome.capabilities.map(c => c.id));
    for (const cap of genome.capabilities) {
      for (const req of cap.requires) {
        if (!capIds.has(req)) {
          violations.push(`Capability "${cap.id}" requires "${req}" which is missing`);
        }
      }
      for (const conflict of cap.conflicts) {
        if (capIds.has(conflict)) {
          violations.push(`Capability "${cap.id}" conflicts with "${conflict}" which is present`);
        }
      }
    }

    const provided = new Map<string, string>();
    const required: Array<{ capId: string; iface: string }> = [];
    for (const cap of genome.capabilities) {
      for (const contract of cap.interfaces) {
        if (contract.direction === 'provides') {
          provided.set(contract.name, cap.id);
        } else {
          required.push({ capId: cap.id, iface: contract.name });
        }
      }
    }
    for (const req of required) {
      if (!provided.has(req.iface)) {
        violations.push(`Capability "${req.capId}" requires interface "${req.iface}" but no capability provides it`);
      }
    }

    for (const cap of genome.capabilities) {
      if (cap.essential && !capIds.has(cap.id)) {
        violations.push(`Essential capability "${cap.id}" is missing`);
      }
    }

    if (!genome.capabilities.some(c => c.category === 'ui')) {
      violations.push('Genome must have at least one UI capability');
    }

    if (!genome.capabilities.some(c => c.id === 'cap.network.ai')) {
      violations.push('Genome must have AI client capability');
    }

    return { violations, warnings };
  }

  validateMutation(original: Genome, mutated: Genome): MutationResult {
    const { violations, warnings } = this.validate(mutated);

    const immutableCaps = original.capabilities.filter(c => !c.mutable);
    for (const ic of immutableCaps) {
      const inMutated = mutated.capabilities.find(c => c.id === ic.id);
      if (!inMutated) {
        violations.push(`Immutable capability "${ic.id}" was removed`);
      } else {
        if (JSON.stringify(ic.sources) !== JSON.stringify(inMutated.sources)) {
          violations.push(`Immutable capability "${ic.id}" had its sources modified`);
        }
        if (ic.mutable !== inMutated.mutable) {
          violations.push(`Immutable capability "${ic.id}" had its mutability changed`);
        }
      }
    }

    const originalInvIds = new Set(original.safety.invariants.map(i => i.id));
    const mutatedInvIds = new Set(mutated.safety.invariants.map(i => i.id));
    for (const id of originalInvIds) {
      if (!mutatedInvIds.has(id)) {
        violations.push(`Safety invariant "${id}" was removed`);
      }
    }

    return {
      success: violations.length === 0,
      genome: violations.length === 0 ? mutated : null,
      violations,
      warnings,
    };
  }

  private checkPredicate(predicate: string, genome: Genome): boolean {
    const [op, ...rest] = predicate.split(':');
    const args = rest.join(':');

    switch (op) {
      case 'exists': return this.checkExists(args, genome);
      case 'eq': return this.checkEq(args, genome);
      case 'gte': return this.checkGte(args, genome);
      case 'contains': return this.checkContains(args, genome);
      case 'nonempty': return this.checkNonempty(args, genome);
      default:
        console.warn(`Unknown predicate operator: ${op}`);
        return true;
    }
  }

  private checkExists(path: string, genome: Genome): boolean {
    const arrayMatch = path.match(/^(\w+)\[(\w+)=([^\]]+)\]$/);
    if (arrayMatch) {
      const [, arrayName, key, value] = arrayMatch;
      const arr = (genome as any)[arrayName];
      if (!Array.isArray(arr)) return false;
      return arr.some((item: any) => item[key] === value);
    }
    return this.resolvePath(path, genome) !== undefined;
  }

  private checkEq(args: string, genome: Genome): boolean {
    const lastColon = args.lastIndexOf(':');
    const path = args.slice(0, lastColon);
    const expected = args.slice(lastColon + 1);
    const actual = this.resolveComplexPath(path, genome);
    return String(actual) === expected;
  }

  private checkGte(args: string, genome: Genome): boolean {
    const lastColon = args.lastIndexOf(':');
    const path = args.slice(0, lastColon);
    const threshold = parseInt(args.slice(lastColon + 1), 10);
    const actual = this.resolveComplexPath(path, genome);
    return typeof actual === 'number' && actual >= threshold;
  }

  private checkContains(args: string, genome: Genome): boolean {
    const firstColon = args.indexOf(':');
    const path = args.slice(0, firstColon);
    const value = args.slice(firstColon + 1);
    const arr = this.resolvePath(path, genome);
    return Array.isArray(arr) && arr.includes(value);
  }

  private checkNonempty(path: string, genome: Genome): boolean {
    const val = this.resolvePath(path, genome);
    if (Array.isArray(val)) return val.length > 0;
    if (typeof val === 'string') return val.length > 0;
    return val != null;
  }

  private resolvePath(path: string, obj: any): any {
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
      if (current == null) return undefined;
      current = current[part];
    }
    return current;
  }

  private resolveComplexPath(path: string, genome: Genome): any {
    const arrayMatch = path.match(/^(\w+)\[(\w+)=([^\]]+)\]\.(.+)$/);
    if (arrayMatch) {
      const [, arrayName, key, value, rest] = arrayMatch;
      const arr = (genome as any)[arrayName];
      if (!Array.isArray(arr)) return undefined;
      const item = arr.find((i: any) => i[key] === value);
      if (!item) return undefined;
      return this.resolvePath(rest, item);
    }
    return this.resolvePath(path, genome);
  }
}

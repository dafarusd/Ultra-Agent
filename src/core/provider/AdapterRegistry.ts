// Adapter registry — maps adapter IDs to implementations

import { ALL_ADAPTERS, type CapabilityAdapter } from './CapabilityAdapters';
import type { AllowedOperation } from '../../types/provider';

export class AdapterRegistry {
  private adapters: Map<string, CapabilityAdapter> = new Map();

  constructor() {
    for (const adapter of ALL_ADAPTERS) {
      this.adapters.set(adapter.id, adapter);
    }
  }

  register(adapter: CapabilityAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): CapabilityAdapter | null {
    return this.adapters.get(id) ?? null;
  }

  getForOperation(adapterIds: string[], operation: AllowedOperation): CapabilityAdapter | null {
    for (const id of adapterIds) {
      const adapter = this.adapters.get(id);
      if (adapter && adapter.supportsOperation(operation)) return adapter;
    }
    return null;
  }

  listAll(): CapabilityAdapter[] {
    return Array.from(this.adapters.values());
  }

  listIds(): string[] {
    return Array.from(this.adapters.keys());
  }
}

let _instance: AdapterRegistry | null = null;
export function getAdapterRegistry(): AdapterRegistry {
  if (!_instance) _instance = new AdapterRegistry();
  return _instance;
}

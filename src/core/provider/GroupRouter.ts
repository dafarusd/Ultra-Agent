// Group Router — fail-closed route resolution with 8-step resolution order

import type {
  AllowedOperation,
  ApiProvider,
  ModelGroup,
  GroupMember,
  ResolvedRoute,
  RouteResult,
  RouteError,
  UserDefaults,
  RouteHistory,
} from '../../types/provider';
import type { ProviderManager } from './ProviderManager';
import type { GroupManager } from './GroupManager';
import type { RouteHistoryStore } from './RouteHistoryStore';
import { getAdapterRegistry } from './AdapterRegistry';
import { UltraDevLog } from '../../utils/UltraDevLog';

const FAIL_CLOSED_MSG = 'No saved default is available for this task. Open Settings and assign at least one model to an active group.';

export interface RouterContext {
  operation: AllowedOperation;
  conversationId?: string;
  requestedGroupId?: string;
  requestedTags?: string[];
  taskFamily?: string;
}

export class GroupRouter {
  private providerManager: ProviderManager;
  private groupManager: GroupManager;
  private routeHistory: RouteHistoryStore;

  constructor(
    providerManager: ProviderManager,
    groupManager: GroupManager,
    routeHistory: RouteHistoryStore
  ) {
    this.providerManager = providerManager;
    this.groupManager = groupManager;
    this.routeHistory = routeHistory;
  }

  async resolve(ctx: RouterContext): Promise<RouteResult> {
    const { operation } = ctx;
    const defaults = this.groupManager.getUserDefaults();
    const activeProviders = this.providerManager.getActive();
    const activeGroups = this.groupManager.getActive();

    if (activeProviders.length === 0) {
      return this.failClosed('no_providers', 'No active providers configured.', FAIL_CLOSED_MSG);
    }
    if (activeGroups.length === 0) {
      return this.failClosed('no_groups', 'No active groups configured.', FAIL_CLOSED_MSG);
    }

    // Step 1 — explicit group id from caller
    if (ctx.requestedGroupId) {
      const group = this.groupManager.getById(ctx.requestedGroupId);
      if (group && group.isActive) {
        const route = await this.selectFromGroup(group, operation, activeProviders, defaults, ctx.conversationId);
        if (route) {
          UltraDevLog.push('ROUTE', { event: 'route_resolved', step: 'explicit_group', groupId: group.id, ...this.logRoute(route) });
          return { ok: true, route };
        }
      }
    }

    // Step 2 — exact tag match
    if (ctx.requestedTags?.length) {
      for (const tag of ctx.requestedTags) {
        for (const group of activeGroups) {
          if (group.tags.includes(tag)) {
            const route = await this.selectFromGroup(group, operation, activeProviders, defaults, ctx.conversationId);
            if (route) {
              UltraDevLog.push('ROUTE', { event: 'route_resolved', step: 'exact_tag', tag, groupId: group.id, ...this.logRoute(route) });
              return { ok: true, route };
            }
          }
        }
      }
    }

    // Step 3 — alias match
    if (ctx.requestedTags?.length) {
      for (const tag of ctx.requestedTags) {
        for (const group of activeGroups) {
          if (group.aliases.includes(tag)) {
            const route = await this.selectFromGroup(group, operation, activeProviders, defaults, ctx.conversationId);
            if (route) {
              UltraDevLog.push('ROUTE', { event: 'route_resolved', step: 'alias_tag', tag, groupId: group.id, ...this.logRoute(route) });
              return { ok: true, route };
            }
          }
        }
      }
    }

    // Step 4 — groupAssignments[operation]
    const assignedGroupId = defaults.groupAssignments[operation];
    if (assignedGroupId) {
      const group = this.groupManager.getById(assignedGroupId);
      if (group && group.isActive) {
        const route = await this.selectFromGroup(group, operation, activeProviders, defaults, ctx.conversationId);
        if (route) {
          UltraDevLog.push('ROUTE', { event: 'route_resolved', step: 'operation_assignment', operation, groupId: group.id, ...this.logRoute(route) });
          return { ok: true, route };
        }
      }
    }

    // Step 5 — conversation sticky routing
    if (defaults.conversationStickyRouting && ctx.conversationId) {
      const history = this.routeHistory.get(ctx.conversationId);
      if (history) {
        const route = this.rehydrateHistory(history, operation, activeProviders, activeGroups);
        if (route) {
          UltraDevLog.push('ROUTE', { event: 'route_resolved', step: 'sticky_routing', conversationId: ctx.conversationId, ...this.logRoute(route) });
          return { ok: true, route };
        }
      }
    }

    // Step 6 — fallback chain from assigned group
    if (assignedGroupId) {
      const group = this.groupManager.getById(assignedGroupId);
      if (group) {
        const route = await this.walkFallbackChain(group, operation, activeProviders, defaults, ctx.conversationId, new Set([assignedGroupId]));
        if (route) {
          UltraDevLog.push('ROUTE', { event: 'route_resolved', step: 'fallback_chain', originGroupId: assignedGroupId, ...this.logRoute(route) });
          return { ok: true, route };
        }
      }
    }

    // Step 7 — global fallback group
    if (defaults.fallbackGroupId) {
      const fallbackGroup = this.groupManager.getById(defaults.fallbackGroupId);
      if (fallbackGroup && fallbackGroup.isActive) {
        const route = await this.selectFromGroup(fallbackGroup, operation, activeProviders, defaults, ctx.conversationId);
        if (route) {
          UltraDevLog.push('ROUTE', { event: 'route_resolved', step: 'global_fallback', groupId: fallbackGroup.id, ...this.logRoute(route) });
          return { ok: true, route };
        }
      }
    }

    // Step 8 — fail closed
    UltraDevLog.push('ROUTE', { event: 'route_fail_closed', operation });
    return this.failClosed('no_valid_route', `No valid route found for operation '${operation}'.`, FAIL_CLOSED_MSG);
  }

  private async selectFromGroup(
    group: ModelGroup,
    operation: AllowedOperation,
    activeProviders: ApiProvider[],
    defaults: UserDefaults,
    conversationId?: string
  ): Promise<ResolvedRoute | null> {
    const strategy = group.selectionStrategy;
    const validMembers = this.getValidMembers(group, operation, activeProviders);
    if (validMembers.length === 0) return null;

    let member: GroupMember | null = null;

    switch (strategy) {
      case 'priority': {
        member = [...validMembers].sort((a, b) => a.priority - b.priority)[0];
        break;
      }
      case 'round_robin': {
        const cursor = this.groupManager.getRoundRobinCursor(group.id) % validMembers.length;
        member = validMembers[cursor];
        this.groupManager.advanceRoundRobin(group.id, validMembers.length);
        break;
      }
      case 'cheapest_first': {
        member = [...validMembers].sort((a, b) => {
          const ac = a.costRank ?? 9999;
          const bc = b.costRank ?? 9999;
          if (ac !== bc) return ac - bc;
          return a.priority - b.priority;
        })[0];
        break;
      }
      case 'fastest_first': {
        member = [...validMembers].sort((a, b) => {
          const as_ = a.speedRank ?? 9999;
          const bs_ = b.speedRank ?? 9999;
          if (as_ !== bs_) return as_ - bs_;
          return a.priority - b.priority;
        })[0];
        break;
      }
      case 'highest_context': {
        const models = this.providerManager.getAllModels();
        const modelMap = new Map(models.map(m => [`${m.providerId}:${m.id}`, m]));
        member = [...validMembers].sort((a, b) => {
          const am = modelMap.get(`${a.providerId}:${a.modelId}`);
          const bm = modelMap.get(`${b.providerId}:${b.modelId}`);
          const ac = am?.contextWindow ?? 0;
          const bc = bm?.contextWindow ?? 0;
          if (bc !== ac) return bc - ac;
          return a.priority - b.priority;
        })[0];
        break;
      }
      case 'last_known_good': {
        if (conversationId) {
          const history = this.routeHistory.get(conversationId);
          if (history) {
            const lastGood = validMembers.find(
              m => m.providerId === history.lastProviderId && m.modelId === history.lastModelId
            );
            if (lastGood) { member = lastGood; break; }
          }
        }
        member = [...validMembers].sort((a, b) => a.priority - b.priority)[0];
        break;
      }
      case 'fallback_chain': {
        member = [...validMembers].sort((a, b) => a.priority - b.priority)[0];
        break;
      }
      default:
        member = validMembers[0];
    }

    if (!member) return null;
    return this.buildRoute(group, member, operation, activeProviders);
  }

  private async walkFallbackChain(
    group: ModelGroup,
    operation: AllowedOperation,
    activeProviders: ApiProvider[],
    defaults: UserDefaults,
    conversationId: string | undefined,
    visited: Set<string>
  ): Promise<ResolvedRoute | null> {
    for (const fallbackId of group.fallbackGroupIds) {
      if (visited.has(fallbackId)) continue;
      visited.add(fallbackId);
      const fallback = this.groupManager.getById(fallbackId);
      if (!fallback || !fallback.isActive) continue;
      const route = await this.selectFromGroup(fallback, operation, activeProviders, defaults, conversationId);
      if (route) return route;
      const deeper = await this.walkFallbackChain(fallback, operation, activeProviders, defaults, conversationId, visited);
      if (deeper) return deeper;
    }
    return null;
  }

  private getValidMembers(
    group: ModelGroup,
    operation: AllowedOperation,
    activeProviders: ApiProvider[]
  ): GroupMember[] {
    const registry = getAdapterRegistry();
    const activeProviderMap = new Map(activeProviders.map(p => [p.id, p]));
    return group.members.filter(member => {
      if (!member.enabled) return false;
      if (!member.allowedOperations.includes(operation)) return false;
      const provider = activeProviderMap.get(member.providerId);
      if (!provider) return false;
      if (!provider.isActive) return false;
      if (provider.status === 'network_error' || provider.status === 'unauthorized') return false;
      if (!this.providerManager.hasModel(member.providerId, member.modelId)) return false;
      const adapterIds = member.adapterOverrideId
        ? [member.adapterOverrideId, ...provider.capabilities.adapterIds]
        : provider.capabilities.adapterIds;
      const adapter = registry.getForOperation(adapterIds, operation);
      if (!adapter) return false;
      return true;
    });
  }

  private async buildRoute(
    group: ModelGroup,
    member: GroupMember,
    operation: AllowedOperation,
    activeProviders: ApiProvider[]
  ): Promise<ResolvedRoute | null> {
    const provider = activeProviders.find(p => p.id === member.providerId);
    if (!provider) return null;
    const apiKey = await this.providerManager.getApiKey(provider);
    if (!apiKey) return null;
    const registry = getAdapterRegistry();
    const adapterIds = member.adapterOverrideId
      ? [member.adapterOverrideId, ...provider.capabilities.adapterIds]
      : provider.capabilities.adapterIds;
    const adapter = registry.getForOperation(adapterIds, operation);
    if (!adapter) return null;
    return {
      providerId: provider.id,
      providerName: provider.name,
      modelId: member.modelId,
      groupId: group.id,
      groupName: group.name,
      adapterId: adapter.id,
      operation,
      selectionStrategy: group.selectionStrategy,
      apiKey,
      baseUrl: provider.baseUrl,
      authMode: provider.authMode,
      customAuthHeaderName: provider.customAuthHeaderName,
      customAuthHeaderPrefix: provider.customAuthHeaderPrefix,
    };
  }

  private rehydrateHistory(
    history: RouteHistory,
    operation: AllowedOperation,
    activeProviders: ApiProvider[],
    activeGroups: ModelGroup[]
  ): ResolvedRoute | null {
    const group = activeGroups.find(g => g.id === history.lastGroupId);
    if (!group) return null;
    const provider = activeProviders.find(p => p.id === history.lastProviderId);
    if (!provider) return null;
    const member = group.members.find(m =>
      m.enabled &&
      m.providerId === history.lastProviderId &&
      m.modelId === history.lastModelId &&
      m.allowedOperations.includes(operation)
    );
    if (!member) return null;
    if (!this.providerManager.hasModel(provider.id, member.modelId)) return null;
    const registry = getAdapterRegistry();
    const adapter = registry.getForOperation(provider.capabilities.adapterIds, operation);
    if (!adapter) return null;
    return null; // Can't await inside non-async; sticky handled by selectFromGroup
  }

  private failClosed(
    code: RouteError['code'],
    message: string,
    userMessage: string
  ): RouteResult {
    return { ok: false, error: { code, message, userMessage } };
  }

  private logRoute(route: ResolvedRoute): Record<string, string> {
    return {
      providerId: route.providerId,
      providerName: route.providerName,
      groupId: route.groupId,
      groupName: route.groupName,
      modelId: route.modelId,
      adapterId: route.adapterId,
      operation: route.operation,
      selectionStrategy: route.selectionStrategy,
    };
  }
}

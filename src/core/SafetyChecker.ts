import type { ActionPlan, SafetyCheckResult } from '../types/ultra';

const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+-rf\b/i,
  /\bformat\b/i,
  /\bdrop\s+table\b/i,
  /\bdelete\s+\*\b/i,
  /\bwipe\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bsu\b/i,
  /\broot\b/i,
  /\bfork\s*bomb\b/i,
  /\bwhile\s*\(\s*true\s*\)/i,
];

const SCOPE_MAP: Record<string, string[]> = {
  app_launch: ['open', 'launch', 'start', 'run'],
  sms_send: ['send text', 'sms', 'message', 'text'],
  file_read: ['read', 'show', 'open file', 'list files', 'show files'],
  file_delete: ['delete', 'remove'],
  file_write: ['write', 'create file', 'save'],
  file_organize: ['organize', 'move', 'sort'],
  contacts_read: ['contacts', 'contact'],
  camera_capture: ['photo', 'camera', 'picture', 'take a photo'],
  media_access: ['photos', 'gallery', 'media'],
  app_share: ['share'],
  code_generate: ['code', 'generate', 'write code'],
  app_build: ['build', 'compile'],
  app_install: ['install'],
  network_request: ['fetch', 'request', 'download', 'http', 'api'],
  ai_query: ['ask', 'query', 'ai'],
  dependency_resolve: ['resolve', 'dependency', 'dependencies', 'maven', 'download library', 'jar'],
  app_control: ['control', 'interact', 'tap', 'click', 'scroll', 'type into', 'automate'],
  app_test: ['test', 'run tests', 'verify', 'check app', 'e2e'],
  self_modify: ['improve', 'evolve', 'mutate', 'self-improve', 'upgrade yourself', 'self improve'],
  self_replicate: ['replicate', 'reproduce', 'clone', 'spawn', 'offspring', 'self-replicate', 'self replicate'],
};

const ALWAYS_APPROVE_CAPABILITIES = [
  'app_control',
  'self_modify',
  'self_replicate',
];

const MODERATE_CAPABILITIES = [
  'file_delete',
  'file_write',
  'sms_send',
  'network_request',
  'app_install',
];

export class SafetyChecker {
  check(userRequest: string, plan: ActionPlan): SafetyCheckResult {
    const reasons: string[] = [];
    const blob = `${plan.capability} ${JSON.stringify(plan.params || {})} ${plan.raw || ''}`;

    for (const p of DANGEROUS_PATTERNS) {
      if (p.test(blob)) {
        reasons.push(`Matched dangerous pattern: ${p}`);
      }
    }

    const scopeOk = this.scopeMatches(userRequest, plan.capability);
    if (!scopeOk) {
      reasons.push(`Scope mismatch: requested "${userRequest}" but planned "${plan.capability}"`);
    }

    if (reasons.length > 0) {
      const blocked = reasons.some(r => r.includes('Scope mismatch'));
      return {
        allowed: !blocked,
        risk: blocked ? 'blocked' : 'dangerous',
        requiresApproval: true,
        reasons,
      };
    }

    if (ALWAYS_APPROVE_CAPABILITIES.includes(plan.capability)) {
      return {
        allowed: true,
        risk: 'dangerous',
        requiresApproval: true,
        reasons: ['Dangerous capability always requires explicit user approval.'],
      };
    }

    const moderate = MODERATE_CAPABILITIES.includes(plan.capability);
    return {
      allowed: true,
      risk: moderate ? 'moderate' : 'safe',
      requiresApproval: moderate,
      reasons: moderate
        ? ['Moderate-risk capability requires explicit execution log and confirmation policy.']
        : [],
    };
  }

  verifyResult(
    plan: ActionPlan,
    result: any
  ): { verified: boolean; issues: string[] } {
    const issues: string[] = [];

    if (result === null || result === undefined) {
      issues.push('Result is null or undefined');
      return { verified: false, issues };
    }

    if (typeof result === 'object' && 'success' in result && result.success === false) {
      issues.push(`Capability returned failure: ${result.error || result.message || 'unknown error'}`);
    }

    if (typeof result === 'object' && 'success' in result && result.success === true) {
      if ('data' in result && result.data === undefined) {
        issues.push('Capability returned success but data is undefined');
      }
    }

    if (typeof result === 'string' && result.trim() === '') {
      issues.push('Result is an empty string');
    }

    if (Array.isArray(result) && result.length === 0) {
      issues.push('Result is an empty array — expected data may be missing');
    }

    return { verified: issues.length === 0, issues };
  }

  private scopeMatches(userRequest: string, capability: string): boolean {
    const t = userRequest.toLowerCase();
    const verbs = SCOPE_MAP[capability];
    if (!verbs) return true;
    return verbs.some(v => t.includes(v));
  }
}

import { ActionPlan } from '../types/ultra';
import { validatePlan } from './CapabilitySchemas';

interface ParseRule {
  pattern: RegExp;
  capability: string | null;
  extractParams: (match: RegExpMatchArray) => Record<string, any> | null;
}

const rules: ParseRule[] = [
  {
    pattern: /^open\s+(.+)/i,
    capability: 'app_launch',
    extractParams: (m) => ({ target: m[1].trim() }),
  },
  {
    pattern: /^launch\s+(.+)/i,
    capability: 'app_launch',
    extractParams: (m) => ({ target: m[1].trim() }),
  },
  {
    pattern: /^send\s+(?:a\s+)?(?:text|sms|message)\s+to\s+(.+?)\s+saying\s+(.+)/i,
    capability: 'sms_send',
    extractParams: (m) => ({ to: m[1].trim(), message: m[2].trim() }),
  },
  {
    pattern: /^send\s+(?:a\s+)?(?:text|sms|message)\s+to\s+(.+)/i,
    capability: 'sms_send',
    extractParams: (m) => ({ to: m[1].trim() }),
  },
  {
    pattern: /^read\s+(?:my\s+)?contacts/i,
    capability: 'contacts_read',
    extractParams: () => ({}),
  },
  {
    pattern: /^(?:show|list)\s+(?:my\s+)?contacts/i,
    capability: 'contacts_read',
    extractParams: () => ({}),
  },
  {
    pattern: /^take\s+a?\s*photo/i,
    capability: 'camera_capture',
    extractParams: () => ({}),
  },
  {
    pattern: /^(?:show|list)\s+(?:my\s+)?photos/i,
    capability: 'media_access',
    extractParams: () => ({}),
  },
  {
    pattern: /^(?:show|list)\s+(?:my\s+)?files/i,
    capability: 'file_read',
    extractParams: () => ({}),
  },
  {
    pattern: /^delete\s+(?:file\s+)?(.+)/i,
    capability: 'file_delete',
    extractParams: (m) => ({ filename: m[1].trim() }),
  },
  {
    pattern: /^(?:write|create|save)\s+(?:file\s+)?(.+)/i,
    capability: null,
    extractParams: () => null,
  },
  {
    pattern: /^(?:read|open|show)\s+(?:file\s+)?(.+)/i,
    capability: 'file_read',
    extractParams: (m) => ({ path: m[1].trim() }),
  },
  {
    pattern: /^(?:control|interact\s+with)\s+(.+)/i,
    capability: 'app_control',
    extractParams: (m) => ({ targetPackage: m[1].trim(), action: 'read' }),
  },
  {
    pattern: /^(?:test|run\s+tests?\s+(?:on|for))\s+(.+)/i,
    capability: 'app_test',
    extractParams: (m) => ({ description: m[1].trim() }),
  },
  {
    pattern: /^(?:resolve\s+dependenc(?:y|ies)|download\s+librar(?:y|ies))\s*(.*)$/i,
    capability: 'dependency_resolve',
    extractParams: (m) => {
      const raw = m[1]?.trim();
      if (!raw) return null;
      return { coordinates: raw.split(/[,\s]+/).filter(Boolean) };
    },
  },
  {
    pattern: /^build\s+(?:me\s+)?(?:a\s+)?(?:an?\s+)?(.+?)(?:\s+app)?$/i,
    capability: 'app_build',
    extractParams: (m) => ({ description: m[1].trim() }),
  },
];

export class CommandParser {
  parse(input: string): ActionPlan | null {
    const trimmed = input.trim();
    if (!trimmed) return null;

    for (const rule of rules) {
      const match = trimmed.match(rule.pattern);
      if (!match) continue;

      if (!rule.capability) return null;

      const params = rule.extractParams(match);
      if (params === null) return null;

      const plan: ActionPlan = {
        capability: rule.capability,
        params,
        reason: 'Matched by deterministic command parser',
      };

      const validation = validatePlan(plan);
      if (!validation.valid) {
        return null;
      }

      return plan;
    }

    return null;
  }
}

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
    pattern: /^take\s+a?\s*(?:photo|picture|selfie)/i,
    capability: 'camera_capture',
    extractParams: () => ({}),
  },
  {
    pattern: /^(?:pick|choose|select)\s+(?:a\s+)?(?:photo|image|picture)/i,
    capability: 'media_access',
    extractParams: () => ({ action: 'pick' }),
  },
  {
    pattern: /^(?:show|list)\s+(?:my\s+)?(?:photos|images|pictures|gallery)/i,
    capability: 'media_access',
    extractParams: () => ({}),
  },
  {
    pattern: /^share\s+(.+)/i,
    capability: 'app_share',
    extractParams: (m) => ({ content: m[1].trim() }),
  },
  {
    pattern: /^(?:where\s+am\s+i|get\s+(?:my\s+)?location|my\s+(?:location|coordinates|gps)|gps)/i,
    capability: 'device_location',
    extractParams: () => ({}),
  },
  {
    pattern: /^(?:find|show)\s+(?:my\s+)?(?:location|position|coordinates)/i,
    capability: 'device_location',
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
    pattern: /^(?:write|create|save)\s+(?:a\s+)?file\s+(.+)/i,
    capability: null,
    extractParams: () => null,
  },
  {
    pattern: /^(?:build|create|make)\s+(?:me\s+)?(?:a\s+)?(?:an?\s+)?app\s+(?:that|which|to)\s+(.+)$/i,
    capability: 'app_build',
    extractParams: (m) => ({ description: m[1].trim() }),
  },
  {
    pattern: /^build\s+(?:me\s+)?(?:a\s+)?(?:an?\s+)?(.+?)(?:\s+app)?$/i,
    capability: 'app_build',
    extractParams: (m) => ({ description: m[1].trim() }),
  },
  {
    pattern: /^(?:create|make)\s+(?:me\s+)?(?:a\s+)?(?:an?\s+)?(.+\s+app)$/i,
    capability: 'app_build',
    extractParams: (m) => ({ description: m[1].trim() }),
  },
  {
    pattern: /^(?:improve\s+yourself|self[\s-]?improve|evolve|mutate|upgrade\s+yourself)(?:\s+(.+))?$/i,
    capability: 'self_modify',
    extractParams: (m) => (m[1] ? { goal: m[1].trim() } : {}),
  },
  {
    pattern: /^(?:replicate|self[\s-]?replicate|reproduce|clone\s+yourself|spawn\s+offspring)(?:\s+(.+))?$/i,
    capability: 'self_replicate',
    extractParams: (m) => (m[1] ? { goal: m[1].trim() } : {}),
  },
];

export class CommandParser {
  parse(input: string): ActionPlan | null {
    let trimmed = input.trim();
    if (!trimmed) return null;
    trimmed = trimmed.replace(/^ultra[\s,]+/i, '');

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

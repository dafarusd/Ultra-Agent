import { ActionPlan } from '../types/ultra';
import { validatePlan } from './CapabilitySchemas';
import { resolveIntent } from './IntentResolver';
import { lookupPackage } from './AppDirectory';

interface ParseRule {
  pattern: RegExp;
  capability: string | null;
  extractParams: (match: RegExpMatchArray) => Record<string, any> | null;
}

const rules: ParseRule[] = [
  // ════════════════════════════════════════════════════
  // RICH INTENT PATTERNS (must come before simple app_launch)
  // These generate app_launch plans with action/data/extras
  // so TaskExecutor uses startActivityAsync instead of openApplication
  // ════════════════════════════════════════════════════

  // ── MUSIC PLAYBACK ─────────────────────────────────

  // "play Bad to the Bone on Spotify"
  {
    pattern: /^play\s+(.+?)\s+(?:on|in|with|using)\s+(.+)$/i,
    capability: 'app_launch',
    extractParams: (m) => {
      const query = m[1].trim();
      const appName = m[2].trim();
      const pkg = lookupPackage(appName);
      return {
        target: appName,
        action: 'android.media.action.MEDIA_PLAY_FROM_SEARCH',
        extras: {
          'android.intent.extra.focus': 'vnd.android.cursor.item/audio',
          'query': query,
        },
        packageName: pkg || undefined,
      };
    },
  },
  // "play music by George Thorogood"
  {
    pattern: /^play\s+(?:some\s+)?(?:music\s+)?by\s+(.+)$/i,
    capability: 'app_launch',
    extractParams: (m) => {
      const artist = m[1].trim();
      return {
        target: artist,
        action: 'android.media.action.MEDIA_PLAY_FROM_SEARCH',
        extras: {
          'android.intent.extra.focus': 'vnd.android.cursor.item/artist',
          'android.intent.extra.artist': artist,
          'query': artist,
        },
      };
    },
  },
  // "play the album Appetite for Destruction"
  {
    pattern: /^play\s+(?:the\s+)?album\s+(.+)$/i,
    capability: 'app_launch',
    extractParams: (m) => {
      const album = m[1].trim();
      return {
        target: album,
        action: 'android.media.action.MEDIA_PLAY_FROM_SEARCH',
        extras: {
          'android.intent.extra.focus': 'vnd.android.cursor.item/album',
          'android.intent.extra.album': album,
          'query': album,
        },
      };
    },
  },
  // "play some jazz" / "play Bad to the Bone" (generic music)
  {
    pattern: /^play\s+(.+)$/i,
    capability: 'app_launch',
    extractParams: (m) => {
      const query = m[1].trim();
      // Don't match Google Play Store / Play Games etc — let those fall through to simple launch
      if (/^(store|games?|services|protect|console|books|movies|newsstand)$/i.test(query)) {
        return { target: `play ${query}` };
      }
      return {
        target: query,
        action: 'android.media.action.MEDIA_PLAY_FROM_SEARCH',
        extras: {
          'android.intent.extra.focus': 'vnd.android.cursor.item/*',
          'query': query,
        },
      };
    },
  },

  // ── PHONE CALLS ────────────────────────────────────

  // "call 555-123-4567" (direct phone number)
  {
    pattern: /^call\s+([\d\s\-\+\(\)]{7,})$/i,
    capability: 'app_launch',
    extractParams: (m) => ({
      target: 'phone',
      action: 'android.intent.action.DIAL',
      data: `tel:${m[1].replace(/\s/g, '')}`,
    }),
  },
  // "call Mom" / "call John Smith" (contact name — executor resolves to tel: URI)
  {
    pattern: /^call\s+(.+)$/i,
    capability: 'app_launch',
    extractParams: (m) => {
      const contact = m[1].trim();
      // If it looks like a known app name, don't treat as a phone call
      if (lookupPackage(contact)) return null;
      return {
        target: 'phone',
        action: 'android.intent.action.DIAL',
        extras: { _contactName: contact },
      };
    },
  },
  // "dial 555-1234"
  {
    pattern: /^dial\s+([\d\s\-\+\(\)]+)$/i,
    capability: 'app_launch',
    extractParams: (m) => ({
      target: 'phone',
      action: 'android.intent.action.DIAL',
      data: `tel:${m[1].replace(/\s/g, '')}`,
    }),
  },

  // ── NAVIGATION ─────────────────────────────────────

  // "navigate to Times Square" / "directions to 123 Main St" / "take me to the airport"
  {
    pattern: /^(?:navigate|directions?|take\s+me|drive)\s+to\s+(.+)$/i,
    capability: 'app_launch',
    extractParams: (m) => ({
      target: 'maps',
      action: 'android.intent.action.VIEW',
      data: `google.navigation:q=${encodeURIComponent(m[1].trim())}`,
    }),
  },
  // "show Times Square on the map" / "find coffee shops on map"
  {
    pattern: /^(?:show|find|locate)\s+(.+?)\s+(?:on\s+)?(?:the\s+)?map(?:s)?$/i,
    capability: 'app_launch',
    extractParams: (m) => ({
      target: 'maps',
      action: 'android.intent.action.VIEW',
      data: `geo:0,0?q=${encodeURIComponent(m[1].trim())}`,
    }),
  },
  // "map of downtown Chicago"
  {
    pattern: /^map\s+(?:of\s+)?(.+)$/i,
    capability: 'app_launch',
    extractParams: (m) => ({
      target: 'maps',
      action: 'android.intent.action.VIEW',
      data: `geo:0,0?q=${encodeURIComponent(m[1].trim())}`,
    }),
  },

  // ── WEB SEARCH ─────────────────────────────────────

  // "search for best restaurants near me" / "google quantum computing"
  {
    pattern: /^(?:search|google|look\s+up)\s+(?:for\s+)?(.+)$/i,
    capability: 'app_launch',
    extractParams: (m) => ({
      target: 'browser',
      action: 'android.intent.action.WEB_SEARCH',
      extras: { query: m[1].trim() },
    }),
  },

  // ── ALARMS ─────────────────────────────────────────

  // "set alarm for 7:30 am" / "set an alarm for 2 pm" / "set alarm for 14:00"
  {
    pattern: /^set\s+(?:an?\s+)?alarm\s+(?:for\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i,
    capability: 'app_launch',
    extractParams: (m) => {
      let hour = parseInt(m[1], 10);
      const minutes = m[2] ? parseInt(m[2], 10) : 0;
      const ampm = m[3]?.toLowerCase();
      if (ampm === 'pm' && hour < 12) hour += 12;
      if (ampm === 'am' && hour === 12) hour = 0;
      return {
        target: 'clock',
        action: 'android.intent.action.SET_ALARM',
        extras: {
          'android.intent.extra.alarm.HOUR': hour,
          'android.intent.extra.alarm.MINUTES': minutes,
        },
      };
    },
  },

  // ── TIMERS ─────────────────────────────────────────

  // "set timer for 5 minutes" / "set a timer 30 seconds" / "timer for 2 hours"
  {
    pattern: /^(?:set\s+(?:a\s+)?)?timer\s+(?:for\s+)?(\d+)\s*(seconds?|minutes?|hours?|mins?|hrs?|secs?)$/i,
    capability: 'app_launch',
    extractParams: (m) => {
      const value = parseInt(m[1], 10);
      const unit = m[2].toLowerCase();
      let seconds = value;
      if (unit.startsWith('min')) seconds = value * 60;
      else if (unit.startsWith('hr') || unit.startsWith('hour')) seconds = value * 3600;
      return {
        target: 'clock',
        action: 'android.intent.action.SET_TIMER',
        extras: {
          'android.intent.extra.alarm.LENGTH': seconds,
        },
      };
    },
  },

  // ── EMAIL ──────────────────────────────────────────

  // "email john@example.com about the meeting" / "email john@example.com hi"
  {
    pattern: /^(?:email|mail|e-mail)\s+(\S+@\S+)\s+(?:about|regarding|re)\s+(.+)$/i,
    capability: 'app_launch',
    extractParams: (m) => ({
      target: 'email',
      action: 'android.intent.action.SENDTO',
      data: `mailto:${m[1].trim()}`,
      extras: { 'android.intent.extra.SUBJECT': m[2].trim() },
    }),
  },
  // "email john@example.com saying hello" / "email john@example.com hello"
  {
    pattern: /^(?:email|mail|e-mail)\s+(\S+@\S+)\s+(?:saying\s+)?(.+)$/i,
    capability: 'app_launch',
    extractParams: (m) => ({
      target: 'email',
      action: 'android.intent.action.SENDTO',
      data: `mailto:${m[1].trim()}`,
      extras: { 'android.intent.extra.TEXT': m[2].trim() },
    }),
  },
  // "email john@example.com"
  {
    pattern: /^(?:email|mail|e-mail)\s+(\S+@\S+)$/i,
    capability: 'app_launch',
    extractParams: (m) => ({
      target: 'email',
      action: 'android.intent.action.SENDTO',
      data: `mailto:${m[1].trim()}`,
    }),
  },

  // ── CALENDAR / SCHEDULING ─────────────────────────

  // "schedule a dentist appointment for tomorrow at 3pm"
  {
    pattern: /^(?:schedule|add\s+(?:a\s+)?(?:calendar\s+)?event|create\s+(?:a\s+)?(?:calendar\s+)?event|add\s+to\s+calendar)\s+(.+)$/i,
    capability: 'app_launch',
    extractParams: (m) => ({
      target: 'calendar',
      action: 'android.intent.action.INSERT',
      data: 'content://com.android.calendar/events',
      extras: { 'title': m[1].trim() },
    }),
  },

  // ── URL WITH BROWSER TARGET ────────────────────────

  // "open https://google.com in chrome"
  {
    pattern: /^(?:open|go\s+to|visit|browse)\s+(https?:\/\/\S+)\s+(?:in|with|using)\s+(.+)$/i,
    capability: 'app_launch',
    extractParams: (m) => {
      const pkg = lookupPackage(m[2].trim());
      return {
        target: m[2].trim(),
        action: 'android.intent.action.VIEW',
        data: m[1].trim(),
        packageName: pkg || undefined,
      };
    },
  },
  // "open https://google.com" (URL without browser specified)
  {
    pattern: /^(?:open|go\s+to|visit|browse)\s+(https?:\/\/\S+)$/i,
    capability: 'app_launch',
    extractParams: (m) => ({
      target: 'browser',
      action: 'android.intent.action.VIEW',
      data: m[1].trim(),
    }),
  },
  // "open google.com" (domain without scheme — add https)
  {
    pattern: /^(?:open|go\s+to|visit|browse)\s+(\w[\w-]*\.\w{2,}(?:\.\w{2,})?(?:\/\S*)?)$/i,
    capability: 'app_launch',
    extractParams: (m) => {
      const domain = m[1].trim();
      // Verify it looks like a domain (has a dot, no spaces)
      if (!domain.includes('.') || domain.includes(' ')) return null;
      // Don't match things like "open file.txt" — those go to file_read
      if (/\.(txt|json|md|csv|log|xml|html|js|ts|java|py)$/i.test(domain)) return null;
      return {
        target: 'browser',
        action: 'android.intent.action.VIEW',
        data: `https://${domain}`,
      };
    },
  },

  // ════════════════════════════════════════════════════
  // SYSTEM INFO PATTERNS
  // ════════════════════════════════════════════════════
  {
    pattern: /^(?:system\s+info(?:rmation)?|device\s+info(?:rmation)?|phone\s+info(?:rmation)?)$/i,
    capability: 'system_info',
    extractParams: () => ({}),
  },
  {
    pattern: /^(?:battery|battery\s+level|how(?:'s|\s+is)\s+my\s+battery|check\s+battery)$/i,
    capability: 'system_info',
    extractParams: () => ({ focus: 'battery' }),
  },
  {
    pattern: /^(?:ram|memory|how\s+much\s+(?:ram|memory)|check\s+(?:ram|memory))$/i,
    capability: 'system_info',
    extractParams: () => ({ focus: 'memory' }),
  },
  {
    pattern: /^(?:storage|how\s+much\s+space|disk\s+space|free\s+space|check\s+storage)$/i,
    capability: 'system_info',
    extractParams: () => ({ focus: 'storage' }),
  },
  {
    pattern: /^(?:cpu\s+temp(?:erature)?|temperature|how\s+hot(?:\s+is\s+(?:my\s+)?(?:phone|device))?)$/i,
    capability: 'system_info',
    extractParams: () => ({ focus: 'temperature' }),
  },

  // ════════════════════════════════════════════════════
  // SIMPLE APP LAUNCH (existing patterns, preserved)
  // These generate app_launch plans with only `target` —
  // TaskExecutor uses openApplication() for these
  // ════════════════════════════════════════════════════

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
    pattern: /^(?:run|start)\s+(.+)/i,
    capability: 'app_launch',
    extractParams: (m) => ({ target: m[1].trim() }),
  },
  {
    pattern: /^text\s+(.+?)\s+(?:saying|with)\s+(.+)/i,
    capability: 'sms_send',
    extractParams: (m) => ({ to: m[1].trim(), message: m[2].trim() }),
  },
  {
    pattern: /^text\s+(.+?)\s+["'](.+)["']/i,
    capability: 'sms_send',
    extractParams: (m) => ({ to: m[1].trim(), message: m[2].trim() }),
  },
  {
    pattern: /^text\s+(\S+)\s+(.+)/i,
    capability: 'sms_send',
    extractParams: (m) => ({ to: m[1].trim(), message: m[2].trim() }),
  },
  {
    pattern: /^text\s+(.+)/i,
    capability: 'sms_send',
    extractParams: (m) => ({ to: m[1].trim() }),
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
    pattern: /^(?:read|open)\s+(?:the\s+)?file\s+(?:named\s+|called\s+)?["']?([^\s"']+)["']?$/i,
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
    pattern: /^generate\s+(?:a\s+)?(?:an?\s+)?(?:image|picture|photo)\s+(?:of\s+)?(.+)/i,
    capability: 'image_generate',
    extractParams: (m) => ({ prompt: m[1].trim() }),
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

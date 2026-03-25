// Auth header builder — supports bearer, api_key_header, basic, custom_header, none

import type { AuthMode } from '../../types/provider';

export interface AuthHeaderInput {
  authMode: AuthMode;
  apiKey?: string | null;
  password?: string | null;
  customAuthHeaderName?: string;
  customAuthHeaderPrefix?: string;
}

export function buildAuthHeaders(input: AuthHeaderInput): Record<string, string> {
  const { authMode, apiKey, password, customAuthHeaderName, customAuthHeaderPrefix } = input;

  switch (authMode) {
    case 'bearer': {
      if (!apiKey) return {};
      return { Authorization: `Bearer ${apiKey}` };
    }
    case 'api_key_header': {
      const headerName = customAuthHeaderName || 'X-API-Key';
      if (!apiKey) return {};
      return { [headerName]: apiKey };
    }
    case 'basic': {
      if (!apiKey) return {};
      const credentials = password ? `${apiKey}:${password}` : apiKey;
      const encoded = btoa(credentials);
      return { Authorization: `Basic ${encoded}` };
    }
    case 'custom_header': {
      if (!customAuthHeaderName || !apiKey) return {};
      const prefix = customAuthHeaderPrefix ? customAuthHeaderPrefix + ' ' : '';
      return { [customAuthHeaderName]: `${prefix}${apiKey}` };
    }
    case 'none':
    default:
      return {};
  }
}

export function redactAuthHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  const sensitiveNames = new Set(['authorization', 'x-api-key', 'api-key', 'x-auth-token']);
  for (const [k, v] of Object.entries(headers)) {
    if (sensitiveNames.has(k.toLowerCase())) {
      redacted[k] = v.length > 8 ? `${v.slice(0, 4)}...${v.slice(-4)}` : '[REDACTED]';
    } else {
      redacted[k] = v;
    }
  }
  return redacted;
}

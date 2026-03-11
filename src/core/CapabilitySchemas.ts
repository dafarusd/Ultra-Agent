import { CapabilitySchema, ActionPlan, ParamDef } from '../types/ultra';

const schemas: CapabilitySchema[] = [
  {
    capabilityId: 'app_launch',
    version: 1,
    requiredParams: {
      target: { type: 'string', description: 'App name or package to launch' },
    },
    optionalParams: {},
  },
  {
    capabilityId: 'sms_send',
    version: 1,
    requiredParams: {
      to: { type: 'string', description: 'Recipient phone number or contact name' },
    },
    optionalParams: {
      message: { type: 'string', description: 'Message content' },
    },
  },
  {
    capabilityId: 'file_read',
    version: 1,
    requiredParams: {},
    optionalParams: {
      path: { type: 'string', description: 'File path to read, defaults to document directory' },
    },
  },
  {
    capabilityId: 'file_write',
    version: 1,
    requiredParams: {
      filename: { type: 'string', description: 'Name of the file to write' },
      content: { type: 'string', description: 'Content to write to the file' },
    },
    optionalParams: {},
  },
  {
    capabilityId: 'file_delete',
    version: 1,
    requiredParams: {
      filename: { type: 'string', description: 'Name of the file to delete' },
    },
    optionalParams: {},
  },
  {
    capabilityId: 'file_organize',
    version: 1,
    requiredParams: {
      actions: { type: 'array', description: 'Array of {source, destination} move operations' },
    },
    optionalParams: {},
  },
  {
    capabilityId: 'contacts_read',
    version: 1,
    requiredParams: {},
    optionalParams: {},
  },
  {
    capabilityId: 'camera_capture',
    version: 1,
    requiredParams: {},
    optionalParams: {},
  },
  {
    capabilityId: 'media_access',
    version: 1,
    requiredParams: {},
    optionalParams: {
      action: { type: 'string', description: 'Action to perform: pick (open gallery picker) or list (default, list recent media)' },
    },
  },
  {
    capabilityId: 'app_share',
    version: 1,
    requiredParams: {},
    optionalParams: {
      content: { type: 'string', description: 'Content or message to share' },
      url: { type: 'string', description: 'URL to share' },
      type: { type: 'string', description: 'MIME type of the content' },
    },
  },
  {
    capabilityId: 'device_location',
    version: 1,
    requiredParams: {},
    optionalParams: {},
  },
  {
    capabilityId: 'code_generate',
    version: 1,
    requiredParams: {
      description: { type: 'string', description: 'Description of code to generate' },
    },
    optionalParams: {
      language: { type: 'string', description: 'Programming language' },
    },
  },
  {
    capabilityId: 'app_build',
    version: 1,
    requiredParams: {
      description: { type: 'string', description: 'Description of the app to build' },
    },
    optionalParams: {},
  },
  {
    capabilityId: 'app_install',
    version: 1,
    requiredParams: {},
    optionalParams: {
      apkPath: { type: 'string', description: 'Path to APK file to install' },
    },
  },
  {
    capabilityId: 'network_request',
    version: 1,
    requiredParams: {
      url: { type: 'string', description: 'URL to request' },
    },
    optionalParams: {
      method: { type: 'string', description: 'HTTP method (GET, POST, etc.)' },
      body: { type: 'string', description: 'Request body' },
    },
  },
  {
    capabilityId: 'ai_query',
    version: 1,
    requiredParams: {
      query: { type: 'string', description: 'Query to send to the AI' },
    },
    optionalParams: {},
  },
  {
    capabilityId: 'dependency_resolve',
    version: 1,
    requiredParams: {
      coordinates: { type: 'array', description: 'Array of Maven coordinates (group:artifact:version)' },
    },
    optionalParams: {},
  },
  {
    capabilityId: 'app_control',
    version: 1,
    requiredParams: {
      targetPackage: { type: 'string', description: 'Package name of app to control' },
      action: { type: 'string', description: 'Action to perform: click, scroll, type, back, home, read' },
    },
    optionalParams: {
      selector: { type: 'string', description: 'Text or content description to find the target element' },
      text: { type: 'string', description: 'Text to input (for type action)' },
    },
  },
  {
    capabilityId: 'app_test',
    version: 1,
    requiredParams: {
      description: { type: 'string', description: 'Description of what the app does (for test plan generation)' },
    },
    optionalParams: {
      packageName: { type: 'string', description: 'Package name of app to test' },
    },
  },
  {
    capabilityId: 'self_modify',
    version: 1,
    requiredParams: {},
    optionalParams: {
      goal: { type: 'string', description: 'Improvement goal for the evolution cycle' },
      maxCycles: { type: 'number', description: 'Maximum evolution cycles (default 3)' },
      challenges: { type: 'array', description: 'Custom task challenges to test offspring against (array of challenge descriptions)' },
    },
  },
  {
    capabilityId: 'self_replicate',
    version: 1,
    requiredParams: {},
    optionalParams: {
      goal: { type: 'string', description: 'Optional goal for the offspring agent' },
    },
  },
];

const schemaMap = new Map<string, CapabilitySchema>();
for (const s of schemas) {
  schemaMap.set(s.capabilityId, s);
}

function checkParamType(value: any, def: ParamDef): boolean {
  switch (def.type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    default:
      return true;
  }
}

export function getSchema(capabilityId: string): CapabilitySchema | undefined {
  return schemaMap.get(capabilityId);
}

export function getAllSchemas(): CapabilitySchema[] {
  return schemas;
}

export function validatePlan(plan: ActionPlan): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const schema = schemaMap.get(plan.capability);

  if (!schema) {
    errors.push(`Unknown capability: ${plan.capability}`);
    return { valid: false, errors };
  }

  for (const [key, def] of Object.entries(schema.requiredParams)) {
    if (plan.params[key] === undefined || plan.params[key] === null) {
      errors.push(`Missing required param: ${key}`);
    } else if (!checkParamType(plan.params[key], def)) {
      errors.push(`Param '${key}' expected type '${def.type}', got '${typeof plan.params[key]}'`);
    }
  }

  for (const [key, value] of Object.entries(plan.params)) {
    if (schema.requiredParams[key]) continue;
    const optDef = schema.optionalParams[key];
    if (optDef && !checkParamType(value, optDef)) {
      errors.push(`Optional param '${key}' expected type '${optDef.type}', got '${typeof value}'`);
    }
  }

  return { valid: errors.length === 0, errors };
}

import { Logger } from '../utils/Logger';

export interface Capability {
  id: string;
  name: string;
  description: string;
  riskLevel: 'safe' | 'moderate' | 'sensitive' | 'dangerous';
  available: boolean;
  permissionsRequired: string[];
}

export class CapabilityRegistry {
  private capabilities: Map<string, Capability>;
  private logger: Logger;

  constructor() {
    this.capabilities = new Map();
    this.logger = new Logger('CapabilityRegistry');
  }

  async initialize(): Promise<void> {
    const caps: Capability[] = [
      { id: 'file_read', name: 'File Read', description: 'Read files from device storage', riskLevel: 'safe', available: true, permissionsRequired: ['READ_EXTERNAL_STORAGE'] },
      { id: 'file_write', name: 'File Write', description: 'Write files to device storage', riskLevel: 'moderate', available: true, permissionsRequired: ['WRITE_EXTERNAL_STORAGE'] },
      { id: 'file_delete', name: 'File Delete', description: 'Delete files', riskLevel: 'dangerous', available: true, permissionsRequired: ['WRITE_EXTERNAL_STORAGE'] },
      { id: 'file_organize', name: 'File Organize', description: 'Move and organize files into folders', riskLevel: 'moderate', available: true, permissionsRequired: ['READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE'] },
      { id: 'contacts_read', name: 'Read Contacts', description: 'Read device contacts', riskLevel: 'sensitive', available: true, permissionsRequired: ['READ_CONTACTS'] },
      { id: 'sms_send', name: 'Send SMS', description: 'Send text messages', riskLevel: 'dangerous', available: true, permissionsRequired: ['SEND_SMS'] },
      { id: 'camera_capture', name: 'Camera', description: 'Take photos', riskLevel: 'moderate', available: true, permissionsRequired: ['CAMERA'] },
      { id: 'media_access', name: 'Media Library', description: 'Access photos and videos', riskLevel: 'safe', available: true, permissionsRequired: ['READ_EXTERNAL_STORAGE'] },
      { id: 'app_launch', name: 'Launch App', description: 'Open other installed apps', riskLevel: 'safe', available: true, permissionsRequired: [] },
      { id: 'app_share', name: 'Share Data', description: 'Share data between apps', riskLevel: 'safe', available: true, permissionsRequired: [] },
      { id: 'code_generate', name: 'Code Gen', description: 'Generate source code via AI', riskLevel: 'safe', available: true, permissionsRequired: [] },
      { id: 'app_build', name: 'Build App', description: 'Compile Android APK on device', riskLevel: 'moderate', available: true, permissionsRequired: ['WRITE_EXTERNAL_STORAGE'] },
      { id: 'app_install', name: 'Install App', description: 'Install built APK', riskLevel: 'dangerous', available: true, permissionsRequired: [] },
      { id: 'network_request', name: 'Network', description: 'Make HTTP requests', riskLevel: 'moderate', available: true, permissionsRequired: [] },
      { id: 'ai_query', name: 'AI Query', description: 'Query AI for assistance', riskLevel: 'safe', available: true, permissionsRequired: [] },
      { id: 'dependency_resolve', name: 'Resolve Dependencies', description: 'Download Maven/JAR dependencies from Maven Central', riskLevel: 'moderate', available: true, permissionsRequired: ['INTERNET'] },
      { id: 'device_location', name: 'Device Location', description: 'Get current GPS coordinates', riskLevel: 'moderate', available: true, permissionsRequired: ['ACCESS_FINE_LOCATION'] },
      { id: 'app_control', name: 'App Control', description: 'Control other apps via accessibility service', riskLevel: 'dangerous', available: true, permissionsRequired: ['BIND_ACCESSIBILITY_SERVICE'] },
      { id: 'app_test', name: 'Test App', description: 'Run E2E tests on a built app via accessibility service', riskLevel: 'moderate', available: true, permissionsRequired: ['BIND_ACCESSIBILITY_SERVICE'] },
      { id: 'self_modify', name: 'Self Modify', description: 'Evolve own genome via mutation and fitness evaluation', riskLevel: 'dangerous', available: true, permissionsRequired: [] },
      { id: 'self_replicate', name: 'Self Replicate', description: 'Compile genome into offspring APK', riskLevel: 'dangerous', available: true, permissionsRequired: ['WRITE_EXTERNAL_STORAGE'] },
      { id: 'image_generate', name: 'Image Generate', description: 'Generate images from text prompts', riskLevel: 'moderate', available: true, permissionsRequired: [] },
    ];
    for (const c of caps) this.capabilities.set(c.id, c);
    this.logger.info(`Registered ${this.capabilities.size} capabilities`);
  }

  get(id: string): Capability | undefined { return this.capabilities.get(id); }
  has(id: string): boolean { return this.capabilities.has(id); }
  getAll(): Capability[] { return Array.from(this.capabilities.values()); }

  getCapabilityList(): string {
    return this.getAll().map((c) => `${c.id}: ${c.description} [${c.riskLevel}]`).join('\n');
  }

  getRequiredPermissions(capIds: string[]): string[] {
    const perms = new Set<string>();
    for (const id of capIds) {
      const cap = this.capabilities.get(id);
      if (cap) cap.permissionsRequired.forEach((p) => perms.add(p));
    }
    return Array.from(perms);
  }

  getHighestRisk(capIds: string[]): Capability['riskLevel'] {
    const levels: Capability['riskLevel'][] = ['safe', 'moderate', 'sensitive', 'dangerous'];
    let highest = 0;
    for (const id of capIds) {
      const cap = this.capabilities.get(id);
      if (cap) {
        const idx = levels.indexOf(cap.riskLevel);
        if (idx > highest) highest = idx;
      }
    }
    return levels[highest];
  }
}

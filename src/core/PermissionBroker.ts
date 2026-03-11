import { Platform } from 'react-native';
import * as Contacts from 'expo-contacts';
import * as MediaLibrary from 'expo-media-library';
import * as Camera from 'expo-camera';
import * as Location from 'expo-location';
import { Logger } from '../utils/Logger';

interface PermissionStatus {
  id: string;
  granted: boolean;
  canAsk: boolean;
}

export class PermissionBroker {
  private logger: Logger;
  private statuses: Map<string, PermissionStatus>;

  constructor() {
    this.logger = new Logger('PermissionBroker');
    this.statuses = new Map();
  }

  async initialize(): Promise<void> {
    await this.refreshAll();
    this.logger.info('PermissionBroker initialized');
  }

  async refreshAll(): Promise<void> {
    await Promise.allSettled([
      this.checkContacts(),
      this.checkMediaLibrary(),
      this.checkCamera(),
      this.checkLocation(),
    ]);
  }

  private async checkContacts(): Promise<void> {
    try {
      const { status } = await Contacts.getPermissionsAsync();
      this.statuses.set('READ_CONTACTS', { id: 'READ_CONTACTS', granted: status === 'granted', canAsk: status !== 'denied' });
    } catch {
      this.statuses.set('READ_CONTACTS', { id: 'READ_CONTACTS', granted: false, canAsk: false });
    }
  }

  private async checkMediaLibrary(): Promise<void> {
    try {
      const { status } = await MediaLibrary.getPermissionsAsync();
      const granted = status === 'granted';
      const canAsk = status !== 'denied';
      this.statuses.set('READ_EXTERNAL_STORAGE', { id: 'READ_EXTERNAL_STORAGE', granted, canAsk });
      this.statuses.set('WRITE_EXTERNAL_STORAGE', { id: 'WRITE_EXTERNAL_STORAGE', granted, canAsk });
    } catch {
      this.statuses.set('READ_EXTERNAL_STORAGE', { id: 'READ_EXTERNAL_STORAGE', granted: false, canAsk: false });
      this.statuses.set('WRITE_EXTERNAL_STORAGE', { id: 'WRITE_EXTERNAL_STORAGE', granted: false, canAsk: false });
    }
  }

  private async checkCamera(): Promise<void> {
    try {
      const fn = (Camera as any).getCameraPermissionsAsync
        ?? (Camera as any).Camera?.getCameraPermissionsAsync;
      if (fn) {
        const { status } = await fn();
        this.statuses.set('CAMERA', { id: 'CAMERA', granted: status === 'granted', canAsk: status !== 'denied' });
      } else {
        this.statuses.set('CAMERA', { id: 'CAMERA', granted: false, canAsk: true });
      }
    } catch {
      this.statuses.set('CAMERA', { id: 'CAMERA', granted: false, canAsk: true });
    }
  }

  private async checkLocation(): Promise<void> {
    try {
      if (Platform.OS === 'web') {
        this.statuses.set('ACCESS_FINE_LOCATION', { id: 'ACCESS_FINE_LOCATION', granted: true, canAsk: true });
        return;
      }
      const { status } = await Location.getForegroundPermissionsAsync();
      this.statuses.set('ACCESS_FINE_LOCATION', { id: 'ACCESS_FINE_LOCATION', granted: status === 'granted', canAsk: status !== 'denied' });
    } catch {
      this.statuses.set('ACCESS_FINE_LOCATION', { id: 'ACCESS_FINE_LOCATION', granted: false, canAsk: false });
    }
  }

  isGranted(permission: string): boolean {
    return this.statuses.get(permission)?.granted ?? false;
  }

  allGranted(permissions: string[]): boolean {
    return permissions.every((p) => this.isGranted(p));
  }

  getMissing(permissions: string[]): string[] {
    return permissions.filter((p) => !this.isGranted(p));
  }

  async request(permission: string): Promise<boolean> {
    try {
      switch (permission) {
        case 'READ_CONTACTS': {
          const { status } = await Contacts.requestPermissionsAsync();
          const g = status === 'granted';
          this.statuses.set(permission, { id: permission, granted: g, canAsk: true });
          return g;
        }
        case 'READ_EXTERNAL_STORAGE':
        case 'WRITE_EXTERNAL_STORAGE': {
          const { status } = await MediaLibrary.requestPermissionsAsync();
          const g = status === 'granted';
          this.statuses.set('READ_EXTERNAL_STORAGE', { id: 'READ_EXTERNAL_STORAGE', granted: g, canAsk: true });
          this.statuses.set('WRITE_EXTERNAL_STORAGE', { id: 'WRITE_EXTERNAL_STORAGE', granted: g, canAsk: true });
          return g;
        }
        case 'CAMERA': {
          try {
            const fn = (Camera as any).requestCameraPermissionsAsync
              ?? (Camera as any).Camera?.requestCameraPermissionsAsync;
            if (fn) {
              const { status } = await fn();
              const g = status === 'granted';
              this.statuses.set(permission, { id: permission, granted: g, canAsk: true });
              return g;
            }
            return false;
          } catch (e: any) {
            this.logger.error(`Camera permission request failed: ${e.message}`);
            return false;
          }
        }
        case 'ACCESS_FINE_LOCATION': {
          if (Platform.OS === 'web') {
            this.statuses.set(permission, { id: permission, granted: true, canAsk: true });
            return true;
          }
          const { status } = await Location.requestForegroundPermissionsAsync();
          const g = status === 'granted';
          this.statuses.set(permission, { id: permission, granted: g, canAsk: true });
          return g;
        }
        default:
          return true;
      }
    } catch (error: any) {
      this.logger.error(`Permission request failed for ${permission}: ${error.message}`);
      return false;
    }
  }

  async requestAll(permissions: string[]): Promise<string[]> {
    const failed: string[] = [];
    for (const p of permissions) {
      if (!this.isGranted(p)) {
        const granted = await this.request(p);
        if (!granted) failed.push(p);
      }
    }
    return failed;
  }

  getStatusReport(): string {
    return Array.from(this.statuses.values())
      .map((s) => `${s.id}: ${s.granted ? 'GRANTED' : 'DENIED'}${!s.canAsk ? ' (blocked)' : ''}`)
      .join('\n');
  }
}

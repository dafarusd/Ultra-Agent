import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { Logger } from '../utils/Logger';

const webStorage: Record<string, string> = {};

async function storeSet(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    try { localStorage.setItem(key, value); } catch { webStorage[key] = value; }
  } else {
    await SecureStore.setItemAsync(key, value);
  }
}

async function storeGet(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    try { return localStorage.getItem(key) ?? webStorage[key] ?? null; } catch { return webStorage[key] ?? null; }
  } else {
    return SecureStore.getItemAsync(key);
  }
}

async function storeDel(key: string): Promise<void> {
  if (Platform.OS === 'web') {
    try { localStorage.removeItem(key); } catch { delete webStorage[key]; }
  } else {
    await SecureStore.deleteItemAsync(key);
  }
}

export class SecureVault {
  private static instance: SecureVault | null = null;
  private logger: Logger;
  private cache: Map<string, string>;
  private initialized: boolean;

  private constructor() {
    this.logger = new Logger('SecureVault');
    this.cache = new Map();
    this.initialized = false;
  }

  static async initialize(): Promise<SecureVault> {
    if (SecureVault.instance) return SecureVault.instance;
    const vault = new SecureVault();
    try {
      await storeSet('__vault_test', 'ok');
      await storeDel('__vault_test');
      vault.initialized = true;
      vault.logger.info('SecureVault initialized');
    } catch (error: any) {
      vault.logger.warn('SecureVault native init failed, using fallback: ' + error.message);
      vault.initialized = true;
    }
    SecureVault.instance = vault;
    return vault;
  }

  static getInstance(): SecureVault {
    if (!SecureVault.instance) throw new Error('SecureVault not initialized');
    return SecureVault.instance;
  }

  async set(key: string, value: string): Promise<void> {
    if (!this.initialized) throw new Error('Vault not initialized');
    try {
      await storeSet(`vu_${key}`, value);
      this.cache.set(key, value);
      this.logger.debug(`Stored: ${key}`);
    } catch (error: any) {
      this.cache.set(key, value);
      this.logger.error(`Store failed for ${key}: ${error.message}`);
    }
  }

  async get(key: string): Promise<string | null> {
    if (!this.initialized) throw new Error('Vault not initialized');
    if (this.cache.has(key)) return this.cache.get(key)!;
    try {
      const value = await storeGet(`vu_${key}`);
      if (value) this.cache.set(key, value);
      return value;
    } catch (error: any) {
      this.logger.error(`Retrieve failed for ${key}: ${error.message}`);
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await storeDel(`vu_${key}`);
      this.cache.delete(key);
      this.logger.debug(`Deleted: ${key}`);
    } catch (error: any) {
      this.cache.delete(key);
      this.logger.error(`Delete failed for ${key}: ${error.message}`);
    }
  }

  async has(key: string): Promise<boolean> {
    const value = await this.get(key);
    return value !== null;
  }

  clearCache(): void {
    this.cache.clear();
  }
}

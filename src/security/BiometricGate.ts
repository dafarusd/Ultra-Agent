import * as LocalAuthentication from 'expo-local-authentication';
import { Logger } from '../utils/Logger';
import { SecureVault } from './SecureVault';

const LOCK_TIMEOUT_KEY = 'biometric_lock_timeout_minutes';

export class BiometricGate {
  private logger: Logger;
  private lastUnlockTime: number = 0;
  private lockTimeoutMinutes: number = 0;
  private vault: SecureVault | null = null;

  constructor() {
    this.logger = new Logger('BiometricGate');
  }

  async init(vault: SecureVault): Promise<void> {
    this.vault = vault;
    try {
      const saved = await vault.get(LOCK_TIMEOUT_KEY);
      if (saved !== null) {
        this.lockTimeoutMinutes = parseInt(saved, 10) || 0;
      }
    } catch {
      this.lockTimeoutMinutes = 0;
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const hardware = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      return hardware && enrolled;
    } catch {
      return false;
    }
  }

  async isLocked(): Promise<boolean> {
    if (this.lockTimeoutMinutes <= 0) return false;
    const now = Date.now();
    if (this.lastUnlockTime === 0) return true;
    const elapsed = now - this.lastUnlockTime;
    return elapsed > this.lockTimeoutMinutes * 60 * 1000;
  }

  markUnlocked(): void {
    this.lastUnlockTime = Date.now();
  }

  async setLockTimeout(minutes: number): Promise<void> {
    this.lockTimeoutMinutes = minutes;
    if (this.vault) {
      await this.vault.set(LOCK_TIMEOUT_KEY, String(minutes));
    }
  }

  getLockTimeout(): number {
    return this.lockTimeoutMinutes;
  }

  getLockTimeoutLabel(): string {
    if (this.lockTimeoutMinutes <= 0) return 'Never';
    if (this.lockTimeoutMinutes === 1) return '1 minute';
    if (this.lockTimeoutMinutes < 60) return `${this.lockTimeoutMinutes} minutes`;
    return `${this.lockTimeoutMinutes / 60} hour${this.lockTimeoutMinutes / 60 > 1 ? 's' : ''}`;
  }

  async authenticate(reason: string = 'Authenticate to proceed'): Promise<boolean> {
    try {
      const available = await this.isAvailable();
      if (!available) {
        this.logger.warn('Biometrics unavailable, granting access');
        this.markUnlocked();
        return true;
      }
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: reason,
        fallbackLabel: 'Use passcode',
        disableDeviceFallback: false,
      });
      if (result.success) {
        this.logger.info('Authentication successful');
        this.markUnlocked();
      } else {
        this.logger.warn('Authentication denied');
      }
      return result.success;
    } catch (error: any) {
      this.logger.error('Auth error: ' + error.message);
      return false;
    }
  }

  needsAuth(): boolean {
    const locked = this.lockTimeoutMinutes <= 0
      ? this.lastUnlockTime === 0
      : (Date.now() - this.lastUnlockTime) > this.lockTimeoutMinutes * 60 * 1000;
    return locked;
  }

  recordAuth(): void {
    this.markUnlocked();
  }

  async authenticateIfNeeded(reason: string = 'Unlock Agent Ultra'): Promise<boolean> {
    const locked = await this.isLocked();
    if (!locked && this.lastUnlockTime > 0) return true;
    const result = await this.authenticate(reason);
    if (result) this.markUnlocked();
    return result;
  }
}

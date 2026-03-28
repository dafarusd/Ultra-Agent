import * as LocalAuthentication from 'expo-local-authentication';
import { Logger } from '../utils/Logger';
import { UltraDevLog } from '../utils/UltraDevLog';
import { SecureVault } from './SecureVault';

const LOCK_TIMEOUT_KEY = 'biometric_lock_timeout_minutes';

export class BiometricGate {
  private logger: Logger;
  private lastUnlockTime: number = 0;
  private lockTimeoutMinutes: number = 0;
  private vault: SecureVault | null = null;

  constructor() {
    this.logger = new Logger('BiometricGate');
    UltraDevLog.push('SYSTEM', { event: 'biometric_gate_construct' });
  }

  async init(vault: SecureVault): Promise<void> {
    this.vault = vault;
    try {
      const saved = await vault.get(LOCK_TIMEOUT_KEY);
      if (saved !== null) {
        this.lockTimeoutMinutes = parseInt(saved, 10) || 0;
      }
      UltraDevLog.push('SYSTEM', { event: 'biometric_gate_init_ok', lockTimeoutMinutes: this.lockTimeoutMinutes, restored: saved !== null });
    } catch (err: any) {
      this.lockTimeoutMinutes = 0;
      UltraDevLog.push('SYSTEM', { event: 'biometric_gate_init_timeout_restore_fail', error: err?.message, fallbackTimeout: 0 });
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const hardware = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      const available = hardware && enrolled;
      UltraDevLog.push('SYSTEM', { event: 'biometric_availability_check', hardware, enrolled, available });
      return available;
    } catch (err: any) {
      UltraDevLog.push('SYSTEM', { event: 'biometric_availability_check_fail', error: err?.message });
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
    UltraDevLog.push('SYSTEM', { event: 'biometric_mark_unlocked', ts: this.lastUnlockTime });
  }

  async setLockTimeout(minutes: number): Promise<void> {
    this.lockTimeoutMinutes = minutes;
    if (this.vault) {
      await this.vault.set(LOCK_TIMEOUT_KEY, String(minutes));
    }
    UltraDevLog.push('SYSTEM', { event: 'biometric_lock_timeout_set', minutes, persisted: !!this.vault });
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
    UltraDevLog.push('SYSTEM', { event: 'biometric_auth_start', reason });
    try {
      const available = await this.isAvailable();
      if (!available) {
        this.logger.warn('Biometrics unavailable, granting access');
        this.markUnlocked();
        UltraDevLog.push('SYSTEM', { event: 'biometric_auth_result', outcome: 'skipped_unavailable', granted: true });
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
        UltraDevLog.push('SYSTEM', { event: 'biometric_auth_result', outcome: 'success', granted: true });
      } else {
        this.logger.warn('Authentication denied');
        UltraDevLog.push('SYSTEM', { event: 'biometric_auth_result', outcome: 'denied', granted: false, errorCode: (result as any).error ?? null });
      }
      return result.success;
    } catch (error: any) {
      this.logger.error('Auth error: ' + error.message);
      UltraDevLog.push('SYSTEM', { event: 'biometric_auth_result', outcome: 'error', granted: false, error: error?.message });
      return false;
    }
  }

  needsAuth(): boolean {
    const locked = this.lockTimeoutMinutes <= 0
      ? this.lastUnlockTime === 0
      : (Date.now() - this.lastUnlockTime) > this.lockTimeoutMinutes * 60 * 1000;
    UltraDevLog.push('SYSTEM', { event: 'biometric_needs_auth_check', locked, lastUnlockTime: this.lastUnlockTime, lockTimeoutMinutes: this.lockTimeoutMinutes });
    return locked;
  }

  recordAuth(): void {
    this.markUnlocked();
  }

  async authenticateIfNeeded(reason: string = 'Unlock Agent Ultra'): Promise<boolean> {
    const locked = await this.isLocked();
    if (!locked && this.lastUnlockTime > 0) {
      UltraDevLog.push('SYSTEM', { event: 'biometric_auth_skipped', reason: 'not_locked', lastUnlockTime: this.lastUnlockTime });
      return true;
    }
    const result = await this.authenticate(reason);
    if (result) this.markUnlocked();
    return result;
  }
}

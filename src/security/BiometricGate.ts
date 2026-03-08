import * as LocalAuthentication from 'expo-local-authentication';
import { Logger } from '../utils/Logger';

export class BiometricGate {
  private logger: Logger;

  constructor() {
    this.logger = new Logger('BiometricGate');
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

  async authenticate(reason: string = 'Authenticate to proceed'): Promise<boolean> {
    try {
      const available = await this.isAvailable();
      if (!available) {
        this.logger.warn('Biometrics unavailable, granting access');
        return true;
      }
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: reason,
        fallbackLabel: 'Use passcode',
        disableDeviceFallback: false,
      });
      if (result.success) {
        this.logger.info('Authentication successful');
      } else {
        this.logger.warn('Authentication denied');
      }
      return result.success;
    } catch (error: any) {
      this.logger.error('Auth error: ' + error.message);
      return false;
    }
  }
}

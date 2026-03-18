import { PermissionsAndroid, Platform } from 'react-native';
import { UltraDevLog as DebugLog } from '../utils/UltraDevLog';

const PERMISSION_MAP: Record<string, string> = {
  'READ_CONTACTS':          PermissionsAndroid.PERMISSIONS.READ_CONTACTS,
  'WRITE_CONTACTS':         PermissionsAndroid.PERMISSIONS.WRITE_CONTACTS,
  'SEND_SMS':               PermissionsAndroid.PERMISSIONS.SEND_SMS,
  'RECEIVE_SMS':            PermissionsAndroid.PERMISSIONS.RECEIVE_SMS,
  'READ_SMS':               PermissionsAndroid.PERMISSIONS.READ_SMS,
  'CAMERA':                 PermissionsAndroid.PERMISSIONS.CAMERA,
  'RECORD_AUDIO':           PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
  'ACCESS_FINE_LOCATION':   PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
  'ACCESS_COARSE_LOCATION': PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
  'READ_EXTERNAL_STORAGE':  PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE,
  'WRITE_EXTERNAL_STORAGE': PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
  'READ_CALL_LOG':          PermissionsAndroid.PERMISSIONS.READ_CALL_LOG,
  'CALL_PHONE':             PermissionsAndroid.PERMISSIONS.CALL_PHONE,
  'BLUETOOTH':              'android.permission.BLUETOOTH',
  'BLUETOOTH_CONNECT':      'android.permission.BLUETOOTH_CONNECT',
  'BLUETOOTH_SCAN':         'android.permission.BLUETOOTH_SCAN',
  'MODIFY_AUDIO_SETTINGS':  'android.permission.MODIFY_AUDIO_SETTINGS',
  'BIND_ACCESSIBILITY_SERVICE': 'android.permission.BIND_ACCESSIBILITY_SERVICE',
  'CHANGE_WIFI_STATE':      'android.permission.CHANGE_WIFI_STATE',
  'FLASHLIGHT':             'android.permission.FLASHLIGHT',
  'VIBRATE':                'android.permission.VIBRATE',
  'INTERNET':               'android.permission.INTERNET',
  'FOREGROUND_SERVICE':     'android.permission.FOREGROUND_SERVICE',
  'QUERY_ALL_PACKAGES':     'android.permission.QUERY_ALL_PACKAGES',
  'WRITE_CALENDAR':         'android.permission.WRITE_CALENDAR',
  'READ_CALENDAR':          'android.permission.READ_CALENDAR',
  'com.android.alarm.permission.SET_ALARM': 'com.android.alarm.permission.SET_ALARM',
  'SET_ALARM':              'com.android.alarm.permission.SET_ALARM',
};

export class PermissionBroker {
  private granted = new Set<string>();
  private denied = new Set<string>();

  async initialize(): Promise<void> {
    if (Platform.OS !== 'android') return;
    for (const [key, androidPerm] of Object.entries(PERMISSION_MAP)) {
      try {
        const result = await PermissionsAndroid.check(androidPerm as any);
        if (result) this.granted.add(key);
        else this.denied.add(key);
      } catch {}
    }
    DebugLog.systemEvent('PermissionBroker', `Init: ${this.granted.size} granted, ${this.denied.size} denied`);
  }

  getMissing(permissions: string[]): string[] {
    if (Platform.OS !== 'android') return [];
    return permissions.filter(p => {
      if (!PERMISSION_MAP[p]) return false;
      return !this.granted.has(p);
    });
  }

  async requestAll(permissions: string[]): Promise<string[]> {
    if (Platform.OS !== 'android') return [];
    const failed: string[] = [];
    for (const key of permissions) {
      const androidPerm = PERMISSION_MAP[key];
      if (!androidPerm) continue;
      try {
        const result = await PermissionsAndroid.request(androidPerm as any, {
          title: 'Agent Ultra needs permission',
          message: `Agent Ultra needs ${key.toLowerCase().replace(/_/g, ' ')} permission to complete this action.`,
          buttonPositive: 'Allow',
          buttonNegative: 'Deny',
        });
        if (result === PermissionsAndroid.RESULTS.GRANTED) {
          this.granted.add(key);
          this.denied.delete(key);
          DebugLog.permissionStatus(key, 'granted');
        } else {
          this.denied.add(key);
          this.granted.delete(key);
          failed.push(key);
          DebugLog.permissionStatus(key, result);
        }
      } catch (e: any) {
        failed.push(key);
        DebugLog.error('PermissionBroker', `Request failed for ${key}: ${e.message}`);
      }
    }
    return failed;
  }

  isGranted(permission: string): boolean {
    return this.granted.has(permission);
  }

  allGranted(permissions: string[]): boolean {
    return permissions.every(p => this.isGranted(p));
  }

  getStatusReport(): string {
    const g = [...this.granted].slice(0, 15).join(', ') || 'none';
    const d = [...this.denied].slice(0, 10).join(', ') || 'none';
    return `Granted: ${g}. Denied: ${d}`;
  }
}

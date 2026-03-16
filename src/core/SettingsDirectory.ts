import { ActivityAction } from 'expo-intent-launcher';

export interface SettingsEntry {
  triggers: string[];
  action: string;
  label: string;
}

export const SETTINGS_MAP: SettingsEntry[] = [
  { triggers: ['settings', 'open settings', 'system settings', 'main settings'],
    action: ActivityAction.SETTINGS, label: 'Settings' },
  { triggers: ['wifi', 'wifi settings', 'wi-fi', 'wi-fi settings', 'wireless'],
    action: ActivityAction.WIFI_SETTINGS, label: 'Wi-Fi Settings' },
  { triggers: ['bluetooth', 'bluetooth settings'],
    action: ActivityAction.BLUETOOTH_SETTINGS, label: 'Bluetooth Settings' },
  { triggers: ['airplane mode', 'flight mode', 'airplane mode settings'],
    action: ActivityAction.AIRPLANE_MODE_SETTINGS, label: 'Airplane Mode' },
  { triggers: ['mobile data', 'data roaming', 'cellular', 'data settings'],
    action: ActivityAction.DATA_ROAMING_SETTINGS, label: 'Mobile Data' },
  { triggers: ['hotspot', 'tethering', 'personal hotspot'],
    action: ActivityAction.TETHER_SETTINGS, label: 'Hotspot & Tethering' },
  { triggers: ['vpn', 'vpn settings'],
    action: ActivityAction.VPN_SETTINGS, label: 'VPN Settings' },
  { triggers: ['nfc', 'nfc settings'],
    action: ActivityAction.NFC_SETTINGS, label: 'NFC Settings' },
  { triggers: ['network', 'network settings', 'wireless settings'],
    action: ActivityAction.WIRELESS_SETTINGS, label: 'Network Settings' },
  { triggers: ['data usage', 'data limit', 'data consumption'],
    action: ActivityAction.DATA_USAGE_SETTINGS, label: 'Data Usage' },
  { triggers: ['display', 'display settings', 'screen settings', 'brightness',
               'dark mode', 'night mode', 'screen timeout', 'font size', 'text size'],
    action: ActivityAction.DISPLAY_SETTINGS, label: 'Display Settings' },
  { triggers: ['sound', 'sound settings', 'volume', 'ringtone', 'notification sound'],
    action: ActivityAction.SOUND_SETTINGS, label: 'Sound Settings' },
  { triggers: ['do not disturb', 'dnd', 'zen mode', 'focus mode'],
    action: ActivityAction.ZEN_MODE_PRIORITY_SETTINGS, label: 'Do Not Disturb' },
  { triggers: ['notifications', 'notification settings'],
    action: ActivityAction.APP_NOTIFICATION_SETTINGS, label: 'Notifications' },
  { triggers: ['apps', 'app settings', 'application settings'],
    action: ActivityAction.APPLICATION_SETTINGS, label: 'App Settings' },
  { triggers: ['installed apps', 'all apps', 'manage apps', 'manage applications'],
    action: ActivityAction.MANAGE_APPLICATIONS_SETTINGS, label: 'Manage Apps' },
  { triggers: ['default apps', 'default applications'],
    action: ActivityAction.MANAGE_DEFAULT_APPS_SETTINGS, label: 'Default Apps' },
  { triggers: ['unknown sources', 'install unknown apps', 'sideload'],
    action: ActivityAction.MANAGE_UNKNOWN_APP_SOURCES, label: 'Install Unknown Apps' },
  { triggers: ['security', 'security settings', 'lock screen', 'screen lock'],
    action: ActivityAction.SECURITY_SETTINGS, label: 'Security Settings' },
  { triggers: ['fingerprint', 'fingerprint settings', 'add fingerprint'],
    action: ActivityAction.FINGERPRINT_ENROLL, label: 'Fingerprint Settings' },
  { triggers: ['device admin', 'device administrators'],
    action: ActivityAction.DEVICE_ADMIN_SETTINGS, label: 'Device Admin' },
  { triggers: ['privacy', 'privacy settings'],
    action: ActivityAction.PRIVACY_SETTINGS, label: 'Privacy Settings' },
  { triggers: ['location', 'location settings', 'gps'],
    action: ActivityAction.LOCATION_SOURCE_SETTINGS, label: 'Location Settings' },
  { triggers: ['permissions', 'app permissions', 'permission manager'],
    action: ActivityAction.PERMISSION_USAGE_SETTINGS, label: 'Permission Manager' },
  { triggers: ['accounts', 'account settings', 'sync', 'sync settings'],
    action: ActivityAction.SYNC_SETTINGS, label: 'Accounts & Sync' },
  { triggers: ['date', 'time', 'date and time', 'clock settings', 'date time'],
    action: ActivityAction.DATE_SETTINGS, label: 'Date & Time' },
  { triggers: ['language', 'locale', 'region', 'language settings'],
    action: ActivityAction.LOCALE_SETTINGS, label: 'Language & Region' },
  { triggers: ['keyboard', 'input method', 'keyboard settings', 'input settings'],
    action: ActivityAction.INPUT_METHOD_SETTINGS, label: 'Keyboard Settings' },
  { triggers: ['accessibility', 'accessibility settings', 'talkback'],
    action: ActivityAction.ACCESSIBILITY_SETTINGS, label: 'Accessibility Settings' },
  { triggers: ['developer', 'developer options', 'developer settings', 'dev options'],
    action: ActivityAction.APPLICATION_DEVELOPMENT_SETTINGS, label: 'Developer Options' },
  { triggers: ['battery', 'battery settings', 'battery saver', 'power saving', 'power saver'],
    action: ActivityAction.BATTERY_SAVER_SETTINGS, label: 'Battery Settings' },
  { triggers: ['battery optimization', 'optimize battery', 'background apps'],
    action: ActivityAction.IGNORE_BATTERY_OPTIMIZATION_SETTINGS, label: 'Battery Optimization' },
  { triggers: ['storage', 'storage settings', 'internal storage', 'free up space'],
    action: ActivityAction.INTERNAL_STORAGE_SETTINGS, label: 'Storage Settings' },
  { triggers: ['about phone', 'about device', 'device info', 'software version',
               'android version', 'software update', 'about'],
    action: ActivityAction.DEVICE_INFO_SETTINGS, label: 'About Phone' },
  { triggers: ['cast', 'screen cast', 'smart view', 'cast settings'],
    action: ActivityAction.CAST_SETTINGS, label: 'Cast Settings' },
  { triggers: ['home app', 'default home', 'launcher', 'home settings'],
    action: ActivityAction.HOME_SETTINGS, label: 'Home App Settings' },
  { triggers: ['hearing', 'hearing aid', 'hearing devices'],
    action: ActivityAction.HEARING_DEVICES_SETTINGS, label: 'Hearing Devices' },
];

export function resolveSettingsIntent(query: string): SettingsEntry | null {
  const q = query.toLowerCase().trim()
    .replace(/^(open|go to|show|show me|launch|take me to)\s+/i, '')
    .replace(/\s+(please|now)$/i, '');
  let best: SettingsEntry | null = null;
  let bestLen = 0;
  for (const entry of SETTINGS_MAP) {
    for (const trigger of entry.triggers) {
      if ((q === trigger || q.includes(trigger)) && trigger.length > bestLen) {
        best = entry;
        bestLen = trigger.length;
      }
    }
  }
  return best;
}

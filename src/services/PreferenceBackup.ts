import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';
import { SecureVault } from '../security/SecureVault';
import { LogFolder } from './LogFolder';
import { UltraDevLog } from '../utils/UltraDevLog';

const EXPORT_KEYS = [
  'preferred_model', 'api_defaults', 'saved_apis',
  'learned_patterns', 'user_preferences',
  'daily_cost_limit', 'task_cost_limit',
];

export async function exportPreferences(): Promise<{ success: boolean; message: string }> {
  try {
    const vault = await SecureVault.initialize();
    const data: Record<string, any> = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      source: 'agent-ultra',
    };
    for (const key of EXPORT_KEYS) {
      const val = await vault.get(key);
      if (val !== null) data[key] = val;
    }
    const json = JSON.stringify(data, null, 2);
    await LogFolder.writeLog('agent-ultra-preferences-backup.json', json);
    const filePath = `${FileSystem.documentDirectory}agent-ultra-logs/agent-ultra-preferences-backup.json`;
    const canShare = await Sharing.isAvailableAsync();
    if (canShare) {
      await Sharing.shareAsync(filePath, {
        mimeType: 'application/json',
        dialogTitle: 'Save Agent Ultra Preferences Backup',
      });
    }
    const keyCount = Object.keys(data).length - 3;
    UltraDevLog.preferenceBackup('export', true, keyCount);
    return { success: true, message: 'Preferences exported. Share or save the file to back up your settings.' };
  } catch (err: any) {
    UltraDevLog.preferenceBackup('export', false, 0, err.message);
    return { success: false, message: `Export failed: ${err.message}` };
  }
}

export async function importPreferences(): Promise<{ success: boolean; message: string }> {
  try {
    const result = await DocumentPicker.getDocumentAsync({
      type: ['application/json', 'text/plain', '*/*'],
      copyToCacheDirectory: true,
    });
    if (result.canceled) return { success: false, message: 'Import cancelled.' };
    const fileUri = result.assets[0].uri;
    const fileContent = await FileSystem.readAsStringAsync(fileUri);
    let data: any;
    try {
      data = JSON.parse(fileContent);
    } catch {
      return { success: false, message: 'Invalid file — could not parse JSON.' };
    }
    if (!data.version || !data.source || data.source !== 'agent-ultra') {
      return { success: false, message: 'Invalid backup file — not an Agent Ultra preferences backup.' };
    }
    const vault = await SecureVault.initialize();
    const imported: string[] = [];
    for (const key of EXPORT_KEYS) {
      if (data[key] !== undefined) {
        const val = typeof data[key] === 'string' ? data[key] : JSON.stringify(data[key]);
        await vault.set(key, val);
        imported.push(key);
      }
    }
    UltraDevLog.preferenceBackup('import', true, imported.length);
    return {
      success: true,
      message: `Restored ${imported.length} settings: ${imported.join(', ')}. Restart the app to apply all changes.`
    };
  } catch (err: any) {
    UltraDevLog.preferenceBackup('import', false, 0, err.message);
    return { success: false, message: `Import failed: ${err.message}` };
  }
}

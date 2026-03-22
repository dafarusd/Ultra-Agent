import { NativeModules, Platform } from 'react-native';
import { UltraDevLog } from '../utils/UltraDevLog';

const exec = async (cmd: string): Promise<string> => {
  try {
    if (Platform.OS !== 'android') return '';
    const result = await NativeModules.AgentNative?.exec?.(cmd);
    return typeof result === 'string' ? result : '';
  } catch { return ''; }
};

export class DeviceDiagnostics {

  static async logAudioState(): Promise<void> {
    try {
      const raw = await exec('dumpsys audio');
      if (!raw) return;

      const state: Record<string, any> = {};

      const ringerMatch = raw.match(/ringer mode:\s*(\w+)/i);
      if (ringerMatch) state.ringerMode = ringerMatch[1];

      const musicMatch = raw.match(/- STREAM_MUSIC:[\s\S]*?Max:\s*(\d+)[\s\S]*?Current:\s*(\d+)/i);
      if (musicMatch) { state.musicMax = parseInt(musicMatch[1]); state.musicCurrent = parseInt(musicMatch[2]); }

      const activeMatch = raw.match(/isMusicActive\(\):\s*(true|false)/i);
      if (activeMatch) state.musicActive = activeMatch[1] === 'true';

      const focusMatch = raw.match(/Audio Focus stack entries[\s\S]*?source:\s*(\S+)/i);
      if (focusMatch) state.focusOwner = focusMatch[1].slice(0, 60);

      if (raw.includes('isBluetoothScoOn=true') || raw.includes('A2DP device')) {
        state.bluetoothAudio = true;
      }

      if (Object.keys(state).length > 0) {
        UltraDevLog.push('AUDIO_STATE', state);
      }
    } catch {}
  }

  static async logThermalState(): Promise<void> {
    try {
      const battRaw = await exec('dumpsys battery');
      const state: Record<string, any> = {};

      if (battRaw) {
        const tempMatch = battRaw.match(/temperature:\s*(\d+)/);
        if (tempMatch) state.batteryTempC = parseInt(tempMatch[1]) / 10;

        const levelMatch = battRaw.match(/level:\s*(\d+)/);
        if (levelMatch) state.batteryLevel = parseInt(levelMatch[1]);

        const statusMatch = battRaw.match(/status:\s*(\d+)/);
        if (statusMatch) {
          const codes: Record<string, string> = { '1': 'unknown', '2': 'charging', '3': 'discharging', '4': 'not_charging', '5': 'full' };
          state.batteryStatus = codes[statusMatch[1]] || statusMatch[1];
        }
      }

      const thermalRaw = await exec('dumpsys thermalservice');
      if (thermalRaw) {
        const statusMatch = thermalRaw.match(/mStatus:\s*(\d+)/);
        if (statusMatch) {
          const level = parseInt(statusMatch[1]);
          const labels = ['none', 'light', 'moderate', 'severe', 'critical', 'emergency', 'shutdown'];
          state.thermalStatus = level;
          state.thermalLabel = labels[level] || 'unknown';
        }

        const zones: string[] = [];
        const zoneMatches = thermalRaw.matchAll(/(\w+):\s*([\d.]+)\s*C/gi);
        for (const m of zoneMatches) {
          zones.push(`${m[1]}:${m[2]}C`);
        }
        if (zones.length > 0) state.thermalZones = zones.slice(0, 5).join(', ');
      }

      if (Object.keys(state).length > 0) {
        UltraDevLog.push('THERMAL', state);
      }
    } catch {}
  }

  static async logMemoryState(): Promise<void> {
    try {
      const pid = await exec('cat /proc/self/stat | cut -d" " -f1');
      const raw = await exec(`dumpsys meminfo ${pid.trim()}`);
      const state: Record<string, any> = {};

      if (raw) {
        const totalMatch = raw.match(/TOTAL\s+(\d+)/);
        if (totalMatch) state.totalPssKB = parseInt(totalMatch[1]);

        const javaMatch = raw.match(/Java Heap:\s+(\d+)/);
        if (javaMatch) state.javaHeapKB = parseInt(javaMatch[1]);

        const nativeMatch = raw.match(/Native Heap:\s+(\d+)/);
        if (nativeMatch) state.nativeHeapKB = parseInt(nativeMatch[1]);

        const codeMatch = raw.match(/Code:\s+(\d+)/);
        if (codeMatch) state.codeKB = parseInt(codeMatch[1]);
      }

      const meminfo = await exec('cat /proc/meminfo');
      if (meminfo) {
        const totalMatch = meminfo.match(/MemTotal:\s+(\d+)/);
        const availMatch = meminfo.match(/MemAvailable:\s+(\d+)/);
        if (totalMatch) state.systemTotalMB = Math.round(parseInt(totalMatch[1]) / 1024);
        if (availMatch) state.systemAvailMB = Math.round(parseInt(availMatch[1]) / 1024);
      }

      if (Object.keys(state).length > 0) {
        UltraDevLog.push('MEMORY', state);
      }
    } catch {}
  }

  static async logRenderStats(): Promise<void> {
    try {
      const raw = await exec('dumpsys gfxinfo com.agent.ultra');
      if (!raw) return;

      const state: Record<string, any> = {};

      const totalMatch = raw.match(/Total frames rendered:\s*(\d+)/);
      if (totalMatch) state.totalFrames = parseInt(totalMatch[1]);

      const jankyMatch = raw.match(/Janky frames:\s*(\d+)\s*\(([\d.]+)%\)/);
      if (jankyMatch) {
        state.jankyFrames = parseInt(jankyMatch[1]);
        state.jankyPercent = parseFloat(jankyMatch[2]);
      }

      const pctMatch = raw.match(/50th percentile:\s*(\d+)ms/);
      if (pctMatch) state.p50ms = parseInt(pctMatch[1]);
      const p90Match = raw.match(/90th percentile:\s*(\d+)ms/);
      if (p90Match) state.p90ms = parseInt(p90Match[1]);
      const p99Match = raw.match(/99th percentile:\s*(\d+)ms/);
      if (p99Match) state.p99ms = parseInt(p99Match[1]);

      const vsyncMatch = raw.match(/Number Missed Vsync:\s*(\d+)/);
      if (vsyncMatch) state.missedVsync = parseInt(vsyncMatch[1]);

      if (Object.keys(state).length > 0) {
        UltraDevLog.push('RENDER_STATS', state);
      }
    } catch {}
  }

  static async logA11yStatus(): Promise<void> {
    try {
      const raw = await exec('dumpsys accessibility');
      if (!raw) return;

      const state: Record<string, any> = {};

      state.ultraEnabled = raw.includes('com.agent.ultra') && raw.includes('isEnabled=true');

      const enabledMatches = raw.match(/isEnabled=true/g);
      state.enabledServiceCount = enabledMatches ? enabledMatches.length : 0;

      UltraDevLog.push('A11Y_DUMPSYS', state);
    } catch {}
  }

  static async runAll(): Promise<void> {
    await DeviceDiagnostics.logAudioState();
    await DeviceDiagnostics.logThermalState();
    await DeviceDiagnostics.logMemoryState();
    await DeviceDiagnostics.logRenderStats();
    await DeviceDiagnostics.logA11yStatus();
  }

  static async logAudioBeforeAfter(when: string): Promise<void> {
    try {
      const raw = await exec('dumpsys audio');
      if (!raw) return;
      const state: Record<string, any> = { when };
      const musicMatch = raw.match(/- STREAM_MUSIC:[\s\S]*?Max:\s*(\d+)[\s\S]*?Current:\s*(\d+)/i);
      if (musicMatch) { state.musicMax = parseInt(musicMatch[1]); state.musicCurrent = parseInt(musicMatch[2]); }
      const ringerMatch = raw.match(/ringer mode:\s*(\w+)/i);
      if (ringerMatch) state.ringerMode = ringerMatch[1];
      const activeMatch = raw.match(/isMusicActive\(\):\s*(true|false)/i);
      if (activeMatch) state.musicActive = activeMatch[1] === 'true';
      UltraDevLog.push('AUDIO_STATE', state);
    } catch {}
  }
}

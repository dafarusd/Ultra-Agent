import { NativeModules, Platform } from 'react-native';

export interface UINode {
  className: string;
  text: string | null;
  contentDescription: string | null;
  bounds: { left: number; top: number; right: number; bottom: number };
  clickable: boolean;
  scrollable: boolean;
  children: UINode[];
}

export interface AppControllerInterface {
  getScreenContent(): Promise<UINode>;
  getScreenContentFlat(): Promise<string>;
  performClick(nodeSelector: string): Promise<boolean>;
  performTap(x: number, y: number): Promise<boolean>;
  performSwipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<boolean>;
  performScroll(direction: 'up' | 'down' | 'left' | 'right' | string): Promise<boolean>;
  performText(nodeSelector: string, text: string): Promise<boolean>;
  performBack(): Promise<boolean>;
  performHome(): Promise<boolean>;
  getActivePackage(): Promise<string>;
  isServiceEnabled(): Promise<boolean>;
  openAccessibilitySettings(): Promise<void>;
  allowPackage(pkg: string): Promise<boolean>;
  revokePackage(pkg: string): Promise<boolean>;
  waitForUiChange(timeoutMs: number): Promise<boolean>;
  performQuickSettings(): Promise<boolean>;
  takeScreenshot(): Promise<boolean>;
  toggleQuickSetting(tileLabel: string): Promise<boolean>;
  isAvailable(): boolean;
}

const emptyNode: UINode = {
  className: '',
  text: null,
  contentDescription: null,
  bounds: { left: 0, top: 0, right: 0, bottom: 0 },
  clickable: false,
  scrollable: false,
  children: [],
};

const noopController: AppControllerInterface = {
  getScreenContent: async () => emptyNode,
  getScreenContentFlat: async () => '[]',
  performClick: async () => false,
  performTap: async () => false,
  performSwipe: async () => false,
  performScroll: async () => false,
  performText: async () => false,
  performBack: async () => false,
  performHome: async () => false,
  getActivePackage: async () => '',
  isServiceEnabled: async () => false,
  openAccessibilitySettings: async () => {},
  allowPackage: async () => true,
  revokePackage: async () => true,
  waitForUiChange: async () => false,
  performQuickSettings: async () => false,
  takeScreenshot: async () => false,
  toggleQuickSetting: async () => false,
  isAvailable: () => false,
};

function createNativeController(): AppControllerInterface {
  const native = NativeModules.AppController;
  if (!native) return noopController;

  return {
    getScreenContent: async () => {
      try {
        const json = await native.getScreenContent();
        return JSON.parse(json) as UINode;
      } catch (error) {
        console.error('Failed to parse screen content:', error);
        return emptyNode;
      }
    },
    getScreenContentFlat: async () => {
      if (!native.getScreenContentFlat) return '[]';
      return native.getScreenContentFlat();
    },
    performClick: (nodeSelector: string) => native.performClick(nodeSelector),
    performTap: (x: number, y: number) => {
      if (!native.performTap) return Promise.resolve(false);
      return native.performTap(x, y);
    },
    performSwipe: (x1: number, y1: number, x2: number, y2: number, durationMs: number) => {
      if (!native.performSwipe) return Promise.resolve(false);
      return native.performSwipe(x1, y1, x2, y2, durationMs);
    },
    performScroll: (direction: string) => native.performScroll(direction),
    performText: (nodeSelector: string, text: string) => native.performText(nodeSelector, text),
    performBack: () => native.performBack(),
    performHome: () => native.performHome(),
    getActivePackage: () => native.getActivePackage(),
    isServiceEnabled: () => native.isServiceEnabled(),
    openAccessibilitySettings: () => native.openAccessibilitySettings(),
    allowPackage: (pkg: string) => native.allowPackage(pkg),
    revokePackage: (pkg: string) => native.revokePackage(pkg),
    waitForUiChange: (timeoutMs: number) => {
      if (!native.waitForUiChange) return Promise.resolve(false);
      return native.waitForUiChange(timeoutMs);
    },
    performQuickSettings: () => native.performQuickSettings ? native.performQuickSettings() : Promise.resolve(false),
    takeScreenshot: () => native.takeScreenshot ? native.takeScreenshot() : Promise.resolve(false),
    toggleQuickSetting: (tileLabel: string) => native.toggleQuickSetting ? native.toggleQuickSetting(tileLabel) : Promise.resolve(false),
    isAvailable: () => true,
  };
}

const AppController: AppControllerInterface =
  Platform.OS !== 'web' ? createNativeController() : noopController;

export default AppController;

export async function performTap(x: number, y: number): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const mod = NativeModules.AppController;
  if (!mod?.performTap) return false;
  return mod.performTap(x, y);
}

export async function performSwipe(
  x1: number, y1: number,
  x2: number, y2: number,
  durationMs: number = 350
): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const mod = NativeModules.AppController;
  if (!mod?.performSwipe) return false;
  return mod.performSwipe(x1, y1, x2, y2, durationMs);
}

export async function getScreenContentFlat(): Promise<string> {
  if (Platform.OS !== 'android') return '[]';
  const mod = NativeModules.AppController;
  if (!mod?.getScreenContentFlat) return '[]';
  return mod.getScreenContentFlat();
}

export async function waitForUiChange(timeoutMs: number = 3000): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const mod = NativeModules.AppController;
  if (!mod?.waitForUiChange) return false;
  return mod.waitForUiChange(timeoutMs);
}

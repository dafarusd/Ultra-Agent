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
  performClick(nodeSelector: string): Promise<boolean>;
  performScroll(direction: 'up' | 'down' | 'left' | 'right'): Promise<boolean>;
  performText(nodeSelector: string, text: string): Promise<boolean>;
  performBack(): Promise<boolean>;
  performHome(): Promise<boolean>;
  getActivePackage(): Promise<string>;
  isServiceEnabled(): Promise<boolean>;
  openAccessibilitySettings(): Promise<void>;
  allowPackage(pkg: string): Promise<boolean>;
  revokePackage(pkg: string): Promise<boolean>;
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
  performClick: async () => false,
  performScroll: async () => false,
  performText: async () => false,
  performBack: async () => false,
  performHome: async () => false,
  getActivePackage: async () => '',
  isServiceEnabled: async () => false,
  openAccessibilitySettings: async () => {},
  allowPackage: async () => true,
  revokePackage: async () => true,
  isAvailable: () => false,
};

function createNativeController(): AppControllerInterface {
  const native = NativeModules.AppController;
  if (!native) return noopController;

  return {
    getScreenContent: async () => {
      const json = await native.getScreenContent();
      return JSON.parse(json) as UINode;
    },
    performClick: (nodeSelector: string) => native.performClick(nodeSelector),
    performScroll: (direction: 'up' | 'down' | 'left' | 'right') => native.performScroll(direction),
    performText: (nodeSelector: string, text: string) => native.performText(nodeSelector, text),
    performBack: () => native.performBack(),
    performHome: () => native.performHome(),
    getActivePackage: () => native.getActivePackage(),
    isServiceEnabled: () => native.isServiceEnabled(),
    openAccessibilitySettings: () => native.openAccessibilitySettings(),
    allowPackage: (pkg: string) => native.allowPackage(pkg),
    revokePackage: (pkg: string) => native.revokePackage(pkg),
    isAvailable: () => true,
  };
}

const AppController: AppControllerInterface =
  Platform.OS !== 'web' ? createNativeController() : noopController;

export default AppController;

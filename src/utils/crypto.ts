import { Platform } from 'react-native';

function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  const h1 = (hash >>> 0).toString(16).padStart(8, '0');

  let hash2 = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash2 ^= input.charCodeAt(i);
    hash2 = (hash2 * 0x01000193) | 0;
  }
  const h2 = (hash2 >>> 0).toString(16).padStart(8, '0');

  let hash3 = 0;
  for (let i = 0; i < input.length; i++) {
    hash3 = input.charCodeAt(i) + ((hash3 << 6) + (hash3 << 16) - hash3);
  }
  const h3 = (hash3 >>> 0).toString(16).padStart(8, '0');

  let hash4 = 0x5bd1e995;
  for (let i = 0; i < input.length; i++) {
    hash4 = ((hash4 << 5) + hash4) + input.charCodeAt(i);
  }
  const h4 = (hash4 >>> 0).toString(16).padStart(8, '0');

  return h1 + h2 + h3 + h4 + h1 + h2 + h3 + h4;
}

let _cryptoModule: any = null;
let _cryptoLoaded = false;

async function loadCryptoModule(): Promise<any> {
  if (_cryptoLoaded) return _cryptoModule;
  _cryptoLoaded = true;
  if (Platform.OS !== 'web') {
    try {
      _cryptoModule = require('expo-crypto');
    } catch {
      _cryptoModule = null;
    }
  }
  return _cryptoModule;
}

export function createHash(input: string): string {
  return simpleHash(input);
}

export async function createHashAsync(input: string): Promise<string> {
  const crypto = await loadCryptoModule();
  if (crypto && crypto.digestStringAsync) {
    try {
      const digest = await crypto.digestStringAsync(
        crypto.CryptoDigestAlgorithm.SHA256,
        input
      );
      return digest;
    } catch {
      return simpleHash(input);
    }
  }
  return simpleHash(input);
}

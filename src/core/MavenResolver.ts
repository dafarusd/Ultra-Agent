import * as ExpoFileSystem from 'expo-file-system';
import { Platform } from 'react-native';

const FS: any = Platform.OS !== 'web' ? ExpoFileSystem : null;
const MAVEN_CENTRAL = 'https://repo1.maven.org/maven2';

function getCacheDir(): string {
  const docDir = (FS?.documentDirectory) || '';
  return `${docDir}maven_cache`;
}

export class MavenResolver {
  private cacheDir: string;

  constructor() {
    this.cacheDir = getCacheDir();
  }

  async resolveAll(coordinates: string[]): Promise<string[]> {
    await this.ensureCacheDir();
    const paths: string[] = [];
    for (const coord of coordinates) {
      const path = await this.resolve(coord);
      if (path) paths.push(path);
    }
    return paths;
  }

  async resolve(coordinate: string): Promise<string | null> {
    const parts = coordinate.split(':');
    if (parts.length !== 3) {
      console.warn(`Invalid Maven coordinate: ${coordinate}`);
      return null;
    }
    const [group, artifact, version] = parts;
    const groupPath = group.replace(/\./g, '/');
    const jarName = `${artifact}-${version}.jar`;
    const localPath = `${this.cacheDir}/${group}/${artifact}/${version}/${jarName}`;

    const info = await FS.getInfoAsync(localPath);
    if (info.exists && (info as any).size > 0) return localPath;

    const url = `${MAVEN_CENTRAL}/${groupPath}/${artifact}/${version}/${jarName}`;
    console.log(`MavenResolver: downloading ${url}`);

    try {
      const parentDir = localPath.substring(0, localPath.lastIndexOf('/'));
      await FS.makeDirectoryAsync(parentDir, { intermediates: true });

      const download = await FS.downloadAsync(url, localPath);
      if (download.status !== 200) {
        console.warn(`MavenResolver: HTTP ${download.status} for ${url}`);
        return this.resolveAar(group, artifact, version);
      }
      return localPath;
    } catch (e) {
      console.error(`MavenResolver: failed to download ${coordinate}`, e);
      return null;
    }
  }

  private async resolveAar(group: string, artifact: string, version: string): Promise<string | null> {
    const groupPath = group.replace(/\./g, '/');
    const aarName = `${artifact}-${version}.aar`;
    const aarUrl = `${MAVEN_CENTRAL}/${groupPath}/${artifact}/${version}/${aarName}`;
    const aarPath = `${this.cacheDir}/${group}/${artifact}/${version}/${aarName}`;

    try {
      const parentDir = aarPath.substring(0, aarPath.lastIndexOf('/'));
      await FS.makeDirectoryAsync(parentDir, { intermediates: true });

      const download = await FS.downloadAsync(aarUrl, aarPath);
      if (download.status !== 200) return null;

      return aarPath;
    } catch {
      return null;
    }
  }

  private async ensureCacheDir() {
    const info = await FS.getInfoAsync(this.cacheDir);
    if (!info.exists) {
      await FS.makeDirectoryAsync(this.cacheDir, { intermediates: true });
    }
  }

  async clearCache(): Promise<void> {
    const info = await FS.getInfoAsync(this.cacheDir);
    if (info.exists) {
      await FS.deleteAsync(this.cacheDir, { idempotent: true });
    }
  }
}

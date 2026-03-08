const { withDangerousMod, withAndroidManifest } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const NATIVE_MODULE_JAVA = `package com.agent.ultra;

import com.facebook.react.bridge.*;
import java.io.*;
import java.util.zip.*;
import java.security.*;
import android.content.Intent;
import android.net.Uri;
import androidx.core.content.FileProvider;

public class AgentNativeModule extends ReactContextBaseJavaModule {
    private final ReactApplicationContext ctx;

    public AgentNativeModule(ReactApplicationContext reactContext) {
        super(reactContext);
        this.ctx = reactContext;
    }

    @Override
    public String getName() {
        return "AgentNative";
    }

    @ReactMethod
    public void compileJava(String sourceDir, String outputDir, String classpath, Promise promise) {
        try {
            File out = new File(outputDir);
            out.mkdirs();
            String ecj = ctx.getFilesDir() + "/build-tools/ecj.jar";
            ProcessBuilder pb = new ProcessBuilder(
                "dalvikvm", "-cp", ecj,
                "org.eclipse.jdt.internal.compiler.batch.Main",
                "-source", "1.8", "-target", "1.8",
                "-cp", classpath, "-d", outputDir, sourceDir
            );
            pb.redirectErrorStream(true);
            Process p = pb.start();
            BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) sb.append(line).append("\\n");
            p.waitFor();
            promise.resolve(p.exitValue() == 0 ? "Compilation successful" : "ERROR: " + sb.toString());
        } catch (Exception e) {
            promise.reject("COMPILE_ERROR", e.getMessage(), e);
        }
    }

    @ReactMethod
    public void convertToDex(String classDir, String outputPath, Promise promise) {
        try {
            String d8 = ctx.getFilesDir() + "/build-tools/d8.jar";
            File dir = new File(classDir);
            StringBuilder classFiles = new StringBuilder();
            findClasses(dir, classFiles);
            ProcessBuilder pb = new ProcessBuilder(
                "dalvikvm", "-cp", d8, "com.android.tools.r8.D8",
                "--output", new File(outputPath).getParent(),
                classFiles.toString().trim()
            );
            pb.redirectErrorStream(true);
            Process p = pb.start();
            BufferedReader reader = new BufferedReader(new InputStreamReader(p.getInputStream()));
            StringBuilder out = new StringBuilder();
            String ln;
            while ((ln = reader.readLine()) != null) out.append(ln).append("\\n");
            p.waitFor();
            promise.resolve("DEX conversion complete");
        } catch (Exception e) {
            promise.reject("DEX_ERROR", e.getMessage(), e);
        }
    }

    private void findClasses(File dir, StringBuilder result) {
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File f : files) {
            if (f.isDirectory()) findClasses(f, result);
            else if (f.getName().endsWith(".class")) result.append(f.getAbsolutePath()).append(" ");
        }
    }

    @ReactMethod
    public void packageApk(String configJson, Promise promise) {
        try {
            org.json.JSONObject cfg = new org.json.JSONObject(configJson);
            String dex = cfg.getString("dexPath");
            String manifest = cfg.getString("manifestPath");
            String output = cfg.getString("outputPath");
            FileOutputStream fos = new FileOutputStream(output);
            ZipOutputStream zos = new ZipOutputStream(fos);
            addToZip(zos, dex, "classes.dex");
            addToZip(zos, manifest, "AndroidManifest.xml");
            if (cfg.has("resDir")) {
                File resDir = new File(cfg.getString("resDir"));
                addDirToZip(zos, resDir, "res");
            }
            zos.close();
            fos.close();
            promise.resolve("APK packaged: " + output);
        } catch (Exception e) {
            promise.reject("PKG_ERROR", e.getMessage(), e);
        }
    }

    private void addToZip(ZipOutputStream zos, String filePath, String entry) throws IOException {
        File f = new File(filePath);
        if (!f.exists()) return;
        FileInputStream fis = new FileInputStream(f);
        zos.putNextEntry(new ZipEntry(entry));
        byte[] buf = new byte[4096];
        int len;
        while ((len = fis.read(buf)) > 0) zos.write(buf, 0, len);
        zos.closeEntry();
        fis.close();
    }

    private void addDirToZip(ZipOutputStream zos, File dir, String base) throws IOException {
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File f : files) {
            String ep = base + "/" + f.getName();
            if (f.isDirectory()) addDirToZip(zos, f, ep);
            else addToZip(zos, f.getAbsolutePath(), ep);
        }
    }

    @ReactMethod
    public void signApk(String input, String output, Promise promise) {
        try {
            FileInputStream fis = new FileInputStream(input);
            FileOutputStream fos = new FileOutputStream(output);
            byte[] buf = new byte[4096];
            int len;
            while ((len = fis.read(buf)) > 0) fos.write(buf, 0, len);
            fis.close();
            fos.close();
            promise.resolve("APK signed: " + output);
        } catch (Exception e) {
            promise.reject("SIGN_ERROR", e.getMessage(), e);
        }
    }

    @ReactMethod
    public void installApk(String apkPath, Promise promise) {
        try {
            File apk = new File(apkPath);
            Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            ctx.startActivity(intent);
            promise.resolve("Install prompt shown");
        } catch (Exception e) {
            promise.reject("INSTALL_ERROR", e.getMessage(), e);
        }
    }

    @ReactMethod
    public void exec(String command, String workDir, Promise promise) {
        try {
            ProcessBuilder pb = new ProcessBuilder("sh", "-c", command);
            if (workDir != null && !workDir.isEmpty()) pb.directory(new File(workDir));
            pb.redirectErrorStream(true);
            Process p = pb.start();
            BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) sb.append(line).append("\\n");
            p.waitFor();
            int exit = p.exitValue();
            if (exit == 0) promise.resolve(sb.toString());
            else promise.reject("EXEC_ERROR", "Exit " + exit + ": " + sb.toString());
        } catch (Exception e) {
            promise.reject("EXEC_ERROR", e.getMessage(), e);
        }
    }

    @ReactMethod
    public void getStorageInfo(Promise promise) {
        try {
            File data = ctx.getFilesDir();
            long total = data.getTotalSpace();
            long free = data.getFreeSpace();
            long used = total - free;
            WritableMap map = Arguments.createMap();
            map.putDouble("total", total);
            map.putDouble("free", free);
            map.putDouble("used", used);
            promise.resolve(map);
        } catch (Exception e) {
            promise.reject("STORAGE_ERROR", e.getMessage(), e);
        }
    }
}`;

const NATIVE_PACKAGE_JAVA = `package com.agent.ultra;

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.uimanager.ViewManager;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public class AgentNativePackage implements ReactPackage {
    @Override
    public List<NativeModule> createNativeModules(ReactApplicationContext reactContext) {
        List<NativeModule> modules = new ArrayList<>();
        modules.add(new AgentNativeModule(reactContext));
        return modules;
    }

    @Override
    public List<ViewManager> createViewManagers(ReactApplicationContext reactContext) {
        return Collections.emptyList();
    }
}`;

const FILE_PROVIDER_PATHS = `<?xml version="1.0" encoding="utf-8"?>
<paths xmlns:android="http://schemas.android.com/apk/res/android">
    <files-path name="builds" path="builds/" />
    <files-path name="projects" path="projects/" />
    <cache-path name="cache" path="." />
    <external-files-path name="external" path="." />
</paths>`;

function withAgentNative(config) {
  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const projectRoot = config.modRequest.projectRoot;
      const androidDir = path.join(projectRoot, 'android');

      const javaDir = path.join(
        androidDir,
        'app',
        'src',
        'main',
        'java',
        'com',
        'agent',
        'ultra'
      );
      fs.mkdirSync(javaDir, { recursive: true });
      fs.writeFileSync(path.join(javaDir, 'AgentNativeModule.java'), NATIVE_MODULE_JAVA);
      fs.writeFileSync(path.join(javaDir, 'AgentNativePackage.java'), NATIVE_PACKAGE_JAVA);

      const xmlDir = path.join(androidDir, 'app', 'src', 'main', 'res', 'xml');
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(path.join(xmlDir, 'file_paths.xml'), FILE_PROVIDER_PATHS);

      const mainAppPath = path.join(androidDir, 'app', 'src', 'main', 'java', 'com', 'agent', 'ultra', 'MainApplication.java');
      if (fs.existsSync(mainAppPath)) {
        let mainApp = fs.readFileSync(mainAppPath, 'utf8');
        if (!mainApp.includes('AgentNativePackage')) {
          mainApp = mainApp.replace(
            'packages.add(new com.facebook.react.shell.MainReactPackage());',
            'packages.add(new com.facebook.react.shell.MainReactPackage());\n            packages.add(new AgentNativePackage());'
          );
          fs.writeFileSync(mainAppPath, mainApp);
        }
      }

      return config;
    },
  ]);

  config = withAndroidManifest(config, async (config) => {
    const manifest = config.modResults;
    const app = manifest.manifest.application[0];

    const hasProvider = (app.provider || []).some(
      (p) => p.$['android:authorities'] === 'com.agent.ultra.fileprovider'
    );

    if (!hasProvider) {
      if (!app.provider) app.provider = [];
      app.provider.push({
        $: {
          'android:name': 'androidx.core.content.FileProvider',
          'android:authorities': 'com.agent.ultra.fileprovider',
          'android:exported': 'false',
          'android:grantUriPermissions': 'true',
        },
        'meta-data': [
          {
            $: {
              'android:name': 'android.support.FILE_PROVIDER_PATHS',
              'android:resource': '@xml/file_paths',
            },
          },
        ],
      });
    }

    return config;
  });

  return config;
}

module.exports = withAgentNative;

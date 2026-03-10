const { withDangerousMod, withAndroidManifest } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const NATIVE_MODULE_JAVA = `package com.agent.ultra;

import com.facebook.react.bridge.*;
import java.io.*;
import java.util.*;
import java.util.zip.*;
import java.security.*;
import java.security.cert.*;
import java.security.spec.*;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.util.Base64;
import android.util.Log;
import androidx.core.content.FileProvider;

public class AgentNativeModule extends ReactContextBaseJavaModule {
    private static final String TAG = "AgentNative";
    private static final String[] ALLOWED_COMMANDS = {
        "dalvikvm", "keytool", "ls", "mkdir", "cp", "cat", "chmod", "find"
    };
    private static final String[] BLOCKED_METACHAR = {
        ";", "|", "&&", "||", "$(", "\`"
    };
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
    public void writeFile(String filePath, String content, Promise promise) {
        try {
            File f = new File(filePath);
            f.getParentFile().mkdirs();
            FileOutputStream fos = new FileOutputStream(f);
            fos.write(content.getBytes(StandardCharsets.UTF_8));
            fos.close();
            promise.resolve(true);
        } catch (Exception e) {
            promise.reject("WRITE_ERROR", e.getMessage(), e);
        }
    }

    @ReactMethod
    public void compileJava(ReadableArray sourcePaths, String outputDir, String classpath, Promise promise) {
        try {
            File out = new File(outputDir);
            out.mkdirs();
            String ecj = ctx.getFilesDir() + "/build-tools/ecj.jar";

            List<String> allSources = new ArrayList<>();
            for (int i = 0; i < sourcePaths.size(); i++) {
                String sp = sourcePaths.getString(i);
                File sf = new File(sp);
                if (sf.isDirectory()) {
                    findJavaFiles(sf, allSources);
                } else if (sf.getName().endsWith(".java")) {
                    allSources.add(sf.getAbsolutePath());
                }
            }

            if (allSources.isEmpty()) {
                WritableMap map = Arguments.createMap();
                map.putBoolean("success", false);
                map.putString("output", "");
                map.putString("errors", "No .java source files found");
                promise.resolve(map);
                return;
            }

            List<String> cmd = new ArrayList<>();
            cmd.add("dalvikvm");
            cmd.add("-Xmx256m");
            cmd.add("-cp");
            cmd.add(ecj);
            cmd.add("org.eclipse.jdt.internal.compiler.batch.Main");
            cmd.add("-source");
            cmd.add("1.8");
            cmd.add("-target");
            cmd.add("1.8");
            cmd.add("-cp");
            cmd.add(classpath);
            cmd.add("-d");
            cmd.add(outputDir);
            cmd.addAll(allSources);

            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.redirectErrorStream(true);
            Process p = pb.start();
            BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) sb.append(line).append("\\n");
            int exitCode = p.waitFor();

            WritableMap map = Arguments.createMap();
            map.putBoolean("success", exitCode == 0);
            map.putString("output", exitCode == 0 ? sb.toString() : "");
            map.putString("errors", exitCode != 0 ? sb.toString() : "");
            promise.resolve(map);
        } catch (Exception e) {
            promise.reject("COMPILE_ERROR", e.getMessage(), e);
        }
    }

    private void findJavaFiles(File dir, List<String> result) {
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File f : files) {
            if (f.isDirectory()) findJavaFiles(f, result);
            else if (f.getName().endsWith(".java")) result.add(f.getAbsolutePath());
        }
    }

    @ReactMethod
    public void convertToDex(String classDir, String outputDir, String extraClasspath, Promise promise) {
        try {
            File outDir = new File(outputDir);
            outDir.mkdirs();
            String d8 = ctx.getFilesDir() + "/build-tools/d8.jar";
            File dir = new File(classDir);
            List<String> classFiles = new ArrayList<>();
            findClassFiles(dir, classFiles);

            if (classFiles.isEmpty()) {
                WritableMap map = Arguments.createMap();
                map.putBoolean("success", false);
                map.putString("error", "No .class files found in " + classDir);
                promise.resolve(map);
                return;
            }

            List<String> cmd = new ArrayList<>();
            cmd.add("dalvikvm");
            cmd.add("-Xmx256m");
            cmd.add("-cp");
            cmd.add(d8);
            cmd.add("com.android.tools.r8.D8");
            cmd.add("--min-api");
            cmd.add("26");
            cmd.add("--output");
            cmd.add(outputDir);
            if (extraClasspath != null && !extraClasspath.isEmpty()) {
                for (String cp : extraClasspath.split(":")) {
                    if (!cp.isEmpty()) {
                        cmd.add("--lib");
                        cmd.add(cp);
                    }
                }
            }
            cmd.addAll(classFiles);

            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.redirectErrorStream(true);
            Process p = pb.start();
            BufferedReader reader = new BufferedReader(new InputStreamReader(p.getInputStream()));
            StringBuilder out = new StringBuilder();
            String ln;
            while ((ln = reader.readLine()) != null) out.append(ln).append("\\n");
            int exitCode = p.waitFor();

            WritableMap map = Arguments.createMap();
            if (exitCode == 0) {
                map.putBoolean("success", true);
                map.putString("dexPath", outputDir + "/classes.dex");
            } else {
                map.putBoolean("success", false);
                map.putString("error", out.toString());
            }
            promise.resolve(map);
        } catch (Exception e) {
            WritableMap map = Arguments.createMap();
            map.putBoolean("success", false);
            map.putString("error", e.getMessage());
            promise.resolve(map);
        }
    }

    private void findClassFiles(File dir, List<String> result) {
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File f : files) {
            if (f.isDirectory()) findClassFiles(f, result);
            else if (f.getName().endsWith(".class")) result.add(f.getAbsolutePath());
        }
    }

    @ReactMethod
    public void packageApk(
        String projectDir,
        String packageName,
        String appName,
        int versionCode,
        String versionName,
        int minSdk,
        int targetSdk,
        ReadableArray permissions,
        ReadableArray activities,
        String outputPath,
        Promise promise
    ) {
        try {
            List<String> permList = new ArrayList<>();
            for (int i = 0; i < permissions.size(); i++) permList.add(permissions.getString(i));
            List<String[]> actList = new ArrayList<>();
            for (int i = 0; i < activities.size(); i++) {
                ReadableMap act = activities.getMap(i);
                actList.add(new String[]{
                    act.getString("name"),
                    act.getBoolean("exported") ? "true" : "false",
                    act.getBoolean("launcher") ? "true" : "false"
                });
            }

            byte[] manifestBytes = BinaryManifestWriter.encode(
                packageName, versionCode, versionName, minSdk, targetSdk,
                appName, permList, actList
            );

            File dexFile = new File(projectDir, "build/dex/classes.dex");
            File output = new File(outputPath);
            output.getParentFile().mkdirs();

            Map<String, File> extras = new HashMap<>();
            File assetsDir = new File(projectDir, "assets");
            if (assetsDir.isDirectory()) collectFiles(assetsDir, "assets", extras);

            ApkPackager.packageApk(manifestBytes, dexFile, output, extras);
            promise.resolve(output.getAbsolutePath());
        } catch (Exception e) {
            promise.reject("PACKAGE_ERROR", e.getMessage(), e);
        }
    }

    private void collectFiles(File dir, String prefix, Map<String, File> map) {
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File f : files) {
            String p = prefix + "/" + f.getName();
            if (f.isDirectory()) collectFiles(f, p, map);
            else map.put(p, f);
        }
    }

    @ReactMethod
    public void signApk(String unsignedPath, Promise promise) {
        try {
            ApkSignerV1 signer = new ApkSignerV1(ctx);
            String signedPath = signer.sign(unsignedPath);
            promise.resolve(signedPath);
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
            if (!isCommandAllowed(command)) {
                logExec(command, "BLOCKED");
                promise.reject("EXEC_BLOCKED", "Command not in allowlist: " + command.split(" ")[0]);
                return;
            }
            logExec(command, "ALLOWED");
            ProcessBuilder pb = new ProcessBuilder("sh", "-c", command);
            if (workDir != null && !workDir.isEmpty()) pb.directory(new File(workDir));
            pb.redirectErrorStream(true);
            Process p = pb.start();
            BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) sb.append(line).append("\\n");
            int exitCode = p.waitFor();
            if (exitCode == 0) promise.resolve(sb.toString());
            else promise.reject("EXEC_ERROR", "Exit " + exitCode + ": " + sb.toString());
        } catch (Exception e) {
            promise.reject("EXEC_ERROR", e.getMessage(), e);
        }
    }

    private boolean isCommandAllowed(String command) {
        String trimmed = command.trim();
        boolean prefixOk = false;
        for (String allowed : ALLOWED_COMMANDS) {
            if (trimmed.startsWith(allowed + " ") || trimmed.equals(allowed)) {
                prefixOk = true;
                break;
            }
        }
        if (!prefixOk) return false;
        for (String meta : BLOCKED_METACHAR) {
            if (trimmed.contains(meta)) return false;
        }
        return true;
    }

    private void logExec(String command, String status) {
        try {
            File logFile = new File(ctx.getFilesDir(), "exec_audit.log");
            FileOutputStream fos = new FileOutputStream(logFile, true);
            String entry = System.currentTimeMillis() + " [" + status + "] " + command + "\\n";
            fos.write(entry.getBytes(StandardCharsets.UTF_8));
            fos.close();
        } catch (Exception ignored) {}
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

const BINARY_MANIFEST_WRITER_JAVA = `package com.agent.ultra;

import java.io.*;
import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

public class BinaryManifestWriter {

    private static final int CHUNK_AXML = 0x00080003;
    private static final int CHUNK_STRING_POOL = 0x001C0001;
    private static final int CHUNK_RESOURCE_IDS = 0x00080180;
    private static final int CHUNK_START_NS = 0x00100100;
    private static final int CHUNK_END_NS = 0x00100101;
    private static final int CHUNK_START_TAG = 0x00100102;
    private static final int CHUNK_END_TAG = 0x00100103;

    private static final int ANDROID_NS_IDX = 0;
    private static final String ANDROID_NS = "http://schemas.android.com/apk/res/android";

    private static final int RES_PACKAGE = 0x01010003;
    private static final int RES_VERSION_CODE = 0x0101021b;
    private static final int RES_VERSION_NAME = 0x0101021c;
    private static final int RES_MIN_SDK = 0x0101020c;
    private static final int RES_TARGET_SDK = 0x01010270;
    private static final int RES_NAME = 0x01010003;
    private static final int RES_LABEL = 0x01010001;
    private static final int RES_ALLOW_BACKUP = 0x01010280;
    private static final int RES_EXPORTED = 0x01010010;

    private static final int TYPE_STRING = 0x03;
    private static final int TYPE_INT = 0x10;
    private static final int TYPE_BOOL = 0x12;
    private static final int TYPE_REFERENCE = 0x01;

    public static byte[] encode(
        String packageName, int versionCode, String versionName,
        int minSdk, int targetSdk, String appLabel,
        List<String> permissions, List<String[]> activities
    ) throws IOException {
        List<String> strings = new ArrayList<>();
        Map<String, Integer> stringIdx = new HashMap<>();
        List<Integer> resourceIds = new ArrayList<>();

        strings.add(ANDROID_NS);
        stringIdx.put(ANDROID_NS, 0);

        String[] baseStrings = {
            "", "manifest", "package", "versionCode", "versionName",
            "platformBuildVersionCode", "platformBuildVersionName",
            "uses-sdk", "minSdkVersion", "targetSdkVersion",
            "uses-permission", "name",
            "application", "label", "allowBackup",
            "activity", "exported",
            "intent-filter", "action", "category",
            "android.intent.action.MAIN", "android.intent.category.LAUNCHER",
            packageName, String.valueOf(versionCode), versionName,
            appLabel
        };
        for (String s : baseStrings) {
            if (!stringIdx.containsKey(s)) {
                stringIdx.put(s, strings.size());
                strings.add(s);
            }
        }
        for (String perm : permissions) {
            if (!stringIdx.containsKey(perm)) {
                stringIdx.put(perm, strings.size());
                strings.add(perm);
            }
        }
        for (String[] act : activities) {
            if (!stringIdx.containsKey(act[0])) {
                stringIdx.put(act[0], strings.size());
                strings.add(act[0]);
            }
        }

        resourceIds.add(RES_PACKAGE);
        resourceIds.add(RES_VERSION_CODE);
        resourceIds.add(RES_VERSION_NAME);
        resourceIds.add(RES_MIN_SDK);
        resourceIds.add(RES_TARGET_SDK);
        resourceIds.add(RES_NAME);
        resourceIds.add(RES_LABEL);
        resourceIds.add(RES_ALLOW_BACKUP);
        resourceIds.add(RES_EXPORTED);

        ByteArrayOutputStream body = new ByteArrayOutputStream();

        writeStringPool(body, strings);
        writeResourceIds(body, resourceIds);

        int nsIdx = stringIdx.get(ANDROID_NS);
        int androidStr = ensureString(strings, stringIdx, "android");
        writeNamespace(body, CHUNK_START_NS, androidStr, nsIdx);

        int manifestIdx = stringIdx.get("manifest");
        writeStartTag(body, -1, manifestIdx, new int[][]{
            {stringIdx.get("package"), -1, TYPE_STRING, stringIdx.get(packageName)},
            {stringIdx.get("versionCode"), -1, TYPE_INT, versionCode},
            {stringIdx.get("versionName"), -1, TYPE_STRING, stringIdx.get(versionName)},
        }, nsIdx);

        int usesSdkIdx = stringIdx.get("uses-sdk");
        writeStartTag(body, -1, usesSdkIdx, new int[][]{
            {stringIdx.get("minSdkVersion"), -1, TYPE_INT, minSdk},
            {stringIdx.get("targetSdkVersion"), -1, TYPE_INT, targetSdk},
        }, nsIdx);
        writeEndTag(body, -1, usesSdkIdx);

        int usesPermIdx = stringIdx.get("uses-permission");
        int nameIdx = stringIdx.get("name");
        for (String perm : permissions) {
            writeStartTag(body, -1, usesPermIdx, new int[][]{
                {nameIdx, -1, TYPE_STRING, stringIdx.get(perm)},
            }, nsIdx);
            writeEndTag(body, -1, usesPermIdx);
        }

        int appIdx = stringIdx.get("application");
        int labelIdx = stringIdx.get("label");
        int allowBackupIdx = stringIdx.get("allowBackup");
        writeStartTag(body, -1, appIdx, new int[][]{
            {labelIdx, -1, TYPE_STRING, stringIdx.get(appLabel)},
            {allowBackupIdx, -1, TYPE_BOOL, 0xFFFFFFFF},
        }, nsIdx);

        int actIdx = stringIdx.get("activity");
        int exportedIdx = stringIdx.get("exported");
        int ifIdx = stringIdx.get("intent-filter");
        int actionIdx = stringIdx.get("action");
        int catIdx = stringIdx.get("category");
        int mainActionIdx = stringIdx.get("android.intent.action.MAIN");
        int launcherCatIdx = stringIdx.get("android.intent.category.LAUNCHER");

        for (String[] act : activities) {
            boolean isExported = "true".equals(act[1]);
            boolean isLauncher = "true".equals(act[2]);
            writeStartTag(body, -1, actIdx, new int[][]{
                {nameIdx, -1, TYPE_STRING, stringIdx.get(act[0])},
                {exportedIdx, -1, TYPE_BOOL, isExported ? 0xFFFFFFFF : 0},
            }, nsIdx);
            if (isLauncher) {
                writeStartTag(body, -1, ifIdx, new int[][]{}, nsIdx);
                writeStartTag(body, -1, actionIdx, new int[][]{
                    {nameIdx, -1, TYPE_STRING, mainActionIdx},
                }, nsIdx);
                writeEndTag(body, -1, actionIdx);
                writeStartTag(body, -1, catIdx, new int[][]{
                    {nameIdx, -1, TYPE_STRING, launcherCatIdx},
                }, nsIdx);
                writeEndTag(body, -1, catIdx);
                writeEndTag(body, -1, ifIdx);
            }
            writeEndTag(body, -1, actIdx);
        }

        writeEndTag(body, -1, appIdx);
        writeEndTag(body, -1, manifestIdx);
        writeNamespace(body, CHUNK_END_NS, androidStr, nsIdx);

        byte[] bodyBytes = body.toByteArray();
        ByteArrayOutputStream full = new ByteArrayOutputStream();
        writeInt(full, CHUNK_AXML);
        writeInt(full, bodyBytes.length + 8);
        full.write(bodyBytes);
        return full.toByteArray();
    }

    private static int ensureString(List<String> strings, Map<String, Integer> idx, String s) {
        if (idx.containsKey(s)) return idx.get(s);
        int i = strings.size();
        strings.add(s);
        idx.put(s, i);
        return i;
    }

    private static void writeStringPool(ByteArrayOutputStream out, List<String> strings) throws IOException {
        int count = strings.size();
        byte[][] encoded = new byte[count][];
        int dataSize = 0;
        for (int i = 0; i < count; i++) {
            byte[] utf8 = strings.get(i).getBytes(StandardCharsets.UTF_8);
            int charLen = strings.get(i).length();
            ByteArrayOutputStream entry = new ByteArrayOutputStream();
            if (charLen > 0x7F) { entry.write((charLen >> 8) | 0x80); entry.write(charLen & 0xFF); }
            else entry.write(charLen);
            if (utf8.length > 0x7F) { entry.write((utf8.length >> 8) | 0x80); entry.write(utf8.length & 0xFF); }
            else entry.write(utf8.length);
            entry.write(utf8);
            entry.write(0);
            encoded[i] = entry.toByteArray();
            dataSize += encoded[i].length;
        }

        int offsetsSize = count * 4;
        int headerSize = 28;
        int stringsStart = headerSize + offsetsSize;
        int totalSize = stringsStart + dataSize;
        totalSize = (totalSize + 3) & ~3;

        writeInt(out, CHUNK_STRING_POOL);
        writeInt(out, totalSize);
        writeInt(out, count);
        writeInt(out, 0);
        writeInt(out, 0x100);
        writeInt(out, stringsStart);
        writeInt(out, 0);

        int offset = 0;
        for (int i = 0; i < count; i++) {
            writeInt(out, offset);
            offset += encoded[i].length;
        }
        for (byte[] e : encoded) out.write(e);
        int pad = totalSize - stringsStart - dataSize;
        for (int i = 0; i < pad; i++) out.write(0);
    }

    private static void writeResourceIds(ByteArrayOutputStream out, List<Integer> ids) throws IOException {
        writeInt(out, CHUNK_RESOURCE_IDS);
        writeInt(out, 8 + ids.size() * 4);
        for (int id : ids) writeInt(out, id);
    }

    private static void writeNamespace(ByteArrayOutputStream out, int type, int prefixIdx, int uriIdx) throws IOException {
        writeInt(out, type);
        writeInt(out, 24);
        writeInt(out, 0);
        writeInt(out, 0xFFFFFFFF);
        writeInt(out, prefixIdx);
        writeInt(out, uriIdx);
    }

    private static void writeStartTag(ByteArrayOutputStream out, int nsIdx, int nameIdx, int[][] attrs, int androidNsIdx) throws IOException {
        int attrCount = attrs.length;
        int size = 36 + attrCount * 20;
        writeInt(out, CHUNK_START_TAG);
        writeInt(out, size);
        writeInt(out, 0);
        writeInt(out, 0xFFFFFFFF);
        writeInt(out, nsIdx);
        writeInt(out, nameIdx);
        writeInt(out, 0x00140014);
        writeShort(out, attrCount);
        writeShort(out, 0);

        for (int[] attr : attrs) {
            writeInt(out, androidNsIdx);
            writeInt(out, attr[0]);
            int rawValue = attr[2] == TYPE_STRING ? attr[3] : -1;
            writeInt(out, rawValue);
            writeShort(out, 8);
            out.write(0);
            out.write(attr[2]);
            writeInt(out, attr[3]);
        }
    }

    private static void writeEndTag(ByteArrayOutputStream out, int nsIdx, int nameIdx) throws IOException {
        writeInt(out, CHUNK_END_TAG);
        writeInt(out, 24);
        writeInt(out, 0);
        writeInt(out, 0xFFFFFFFF);
        writeInt(out, nsIdx);
        writeInt(out, nameIdx);
    }

    private static void writeInt(ByteArrayOutputStream out, int v) throws IOException {
        out.write(v & 0xFF);
        out.write((v >> 8) & 0xFF);
        out.write((v >> 16) & 0xFF);
        out.write((v >> 24) & 0xFF);
    }

    private static void writeShort(ByteArrayOutputStream out, int v) throws IOException {
        out.write(v & 0xFF);
        out.write((v >> 8) & 0xFF);
    }
}`;

const APK_PACKAGER_JAVA = `package com.agent.ultra;

import java.io.*;
import java.util.*;
import java.util.zip.*;

public class ApkPackager {

    private static final int ALIGNMENT = 4;

    public static void packageApk(byte[] binaryManifest, File dexFile, File outputApk, Map<String, File> extras) throws IOException {
        outputApk.getParentFile().mkdirs();
        FileOutputStream fos = new FileOutputStream(outputApk);
        ZipOutputStream zos = new ZipOutputStream(new BufferedOutputStream(fos));

        addAlignedEntry(zos, "AndroidManifest.xml", binaryManifest);

        if (dexFile.exists()) {
            addAlignedEntry(zos, "classes.dex", readFile(dexFile));
        }

        if (extras != null) {
            for (Map.Entry<String, File> entry : extras.entrySet()) {
                if (entry.getValue().exists()) {
                    addAlignedEntry(zos, entry.getKey(), readFile(entry.getValue()));
                }
            }
        }

        zos.close();
        fos.close();
    }

    private static void addAlignedEntry(ZipOutputStream zos, String name, byte[] data) throws IOException {
        ZipEntry entry = new ZipEntry(name);
        entry.setMethod(ZipEntry.STORED);
        entry.setSize(data.length);
        entry.setCompressedSize(data.length);
        CRC32 crc = new CRC32();
        crc.update(data);
        entry.setCrc(crc.getValue());
        zos.putNextEntry(entry);
        zos.write(data);
        zos.closeEntry();
    }

    private static byte[] readFile(File f) throws IOException {
        FileInputStream fis = new FileInputStream(f);
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int len;
        while ((len = fis.read(buf)) > 0) bos.write(buf, 0, len);
        fis.close();
        return bos.toByteArray();
    }
}`;

const APK_SIGNER_V1_JAVA = `package com.agent.ultra;

import android.content.Context;
import android.util.Base64;
import android.util.Log;

import java.io.*;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.cert.*;
import java.util.*;
import java.util.zip.*;

public class ApkSignerV1 {
    private static final String TAG = "ApkSignerV1";
    private static final String KEYSTORE_FILE = "ultra_keystore.bks";
    private static final String KEY_ALIAS = "ultra";
    private static final char[] KEY_PASSWORD = "ultrakey".toCharArray();

    private final Context ctx;
    private KeyStore keyStore;
    private PrivateKey privateKey;
    private java.security.cert.X509Certificate certificate;

    public ApkSignerV1(Context context) {
        this.ctx = context;
    }

    public String sign(String unsignedPath) throws Exception {
        ensureKeyStore();

        String signedPath = unsignedPath.replace(".apk", "-signed.apk").replace(".unsigned", "");
        if (signedPath.equals(unsignedPath)) signedPath = unsignedPath + ".signed";

        Map<String, byte[]> entries = readApkEntries(unsignedPath);

        StringBuilder manifest = new StringBuilder();
        manifest.append("Manifest-Version: 1.0\\r\\n");
        manifest.append("Created-By: Agent Ultra\\r\\n\\r\\n");

        Map<String, String> entryDigests = new LinkedHashMap<>();
        for (Map.Entry<String, byte[]> entry : entries.entrySet()) {
            String name = entry.getKey();
            if (name.startsWith("META-INF/")) continue;
            MessageDigest sha256 = MessageDigest.getInstance("SHA-256");
            byte[] digest = sha256.digest(entry.getValue());
            String b64 = Base64.encodeToString(digest, Base64.NO_WRAP);
            manifest.append("Name: ").append(name).append("\\r\\n");
            manifest.append("SHA-256-Digest: ").append(b64).append("\\r\\n\\r\\n");
            entryDigests.put(name, b64);
        }

        byte[] manifestBytes = manifest.toString().getBytes(StandardCharsets.UTF_8);

        MessageDigest mainDigest = MessageDigest.getInstance("SHA-256");
        String manifestDigest = Base64.encodeToString(mainDigest.digest(manifestBytes), Base64.NO_WRAP);

        StringBuilder sigFile = new StringBuilder();
        sigFile.append("Signature-Version: 1.0\\r\\n");
        sigFile.append("SHA-256-Digest-Manifest: ").append(manifestDigest).append("\\r\\n");
        sigFile.append("Created-By: Agent Ultra\\r\\n\\r\\n");

        for (Map.Entry<String, String> entry : entryDigests.entrySet()) {
            String section = "Name: " + entry.getKey() + "\\r\\n" +
                           "SHA-256-Digest: " + entry.getValue() + "\\r\\n\\r\\n";
            MessageDigest sd = MessageDigest.getInstance("SHA-256");
            String sectionDigest = Base64.encodeToString(sd.digest(section.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
            sigFile.append("Name: ").append(entry.getKey()).append("\\r\\n");
            sigFile.append("SHA-256-Digest: ").append(sectionDigest).append("\\r\\n\\r\\n");
        }

        byte[] sigFileBytes = sigFile.toString().getBytes(StandardCharsets.UTF_8);

        Signature sig = Signature.getInstance("SHA256withRSA");
        sig.initSign(privateKey);
        sig.update(sigFileBytes);
        byte[] signatureBytes = sig.sign();

        byte[] pkcs7 = buildPkcs7(certificate, signatureBytes, sigFileBytes);

        FileOutputStream fos = new FileOutputStream(signedPath);
        ZipOutputStream zos = new ZipOutputStream(new BufferedOutputStream(fos));

        zos.putNextEntry(new ZipEntry("META-INF/MANIFEST.MF"));
        zos.write(manifestBytes);
        zos.closeEntry();

        zos.putNextEntry(new ZipEntry("META-INF/CERT.SF"));
        zos.write(sigFileBytes);
        zos.closeEntry();

        zos.putNextEntry(new ZipEntry("META-INF/CERT.RSA"));
        zos.write(pkcs7);
        zos.closeEntry();

        for (Map.Entry<String, byte[]> entry : entries.entrySet()) {
            if (entry.getKey().startsWith("META-INF/")) continue;
            ZipEntry ze = new ZipEntry(entry.getKey());
            ze.setMethod(ZipEntry.STORED);
            byte[] data = entry.getValue();
            ze.setSize(data.length);
            ze.setCompressedSize(data.length);
            CRC32 crc = new CRC32();
            crc.update(data);
            ze.setCrc(crc.getValue());
            zos.putNextEntry(ze);
            zos.write(data);
            zos.closeEntry();
        }

        zos.close();
        fos.close();

        Log.i(TAG, "APK signed with V1: " + signedPath);
        return signedPath;
    }

    private void ensureKeyStore() throws Exception {
        File ksFile = new File(ctx.getFilesDir(), KEYSTORE_FILE);
        keyStore = KeyStore.getInstance("BKS");

        if (ksFile.exists()) {
            FileInputStream fis = new FileInputStream(ksFile);
            keyStore.load(fis, KEY_PASSWORD);
            fis.close();
        } else {
            keyStore.load(null, KEY_PASSWORD);
            KeyPairGenerator kpg = KeyPairGenerator.getInstance("RSA");
            kpg.initialize(2048);
            KeyPair kp = kpg.generateKeyPair();

            java.security.cert.X509Certificate cert = generateSelfSignedCert(kp);

            keyStore.setKeyEntry(KEY_ALIAS, kp.getPrivate(), KEY_PASSWORD, new java.security.cert.Certificate[]{cert});

            FileOutputStream fos = new FileOutputStream(ksFile);
            keyStore.store(fos, KEY_PASSWORD);
            fos.close();
            Log.i(TAG, "Generated new signing keystore");
        }

        privateKey = (PrivateKey) keyStore.getKey(KEY_ALIAS, KEY_PASSWORD);
        certificate = (java.security.cert.X509Certificate) keyStore.getCertificate(KEY_ALIAS);
    }

    private java.security.cert.X509Certificate generateSelfSignedCert(KeyPair kp) throws Exception {
        long now = System.currentTimeMillis();
        long tenYears = 10L * 365 * 24 * 3600 * 1000;

        byte[] encoded = buildSelfSignedCertDer(kp, now, now + tenYears);

        CertificateFactory cf = CertificateFactory.getInstance("X.509");
        return (java.security.cert.X509Certificate) cf.generateCertificate(new ByteArrayInputStream(encoded));
    }

    private byte[] buildSelfSignedCertDer(KeyPair kp, long notBefore, long notAfter) throws Exception {
        byte[] subjectDer = derSequence(
            derSet(derSequence(
                derOid(new int[]{2,5,4,3}),
                derUtf8("Agent Ultra")
            ))
        );

        byte[] serialBytes = BigInteger.valueOf(System.currentTimeMillis()).toByteArray();
        byte[] serial = derInteger(serialBytes);

        byte[] algId = derSequence(derOid(new int[]{1,2,840,113549,1,1,11}), derNull());

        byte[] validity = derSequence(
            derUtcTime(new Date(notBefore)),
            derUtcTime(new Date(notAfter))
        );

        byte[] pubKeyInfo = kp.getPublic().getEncoded();

        byte[] tbsCert = derSequence(
            derExplicit(0, derInteger(new byte[]{2})),
            serial,
            algId,
            subjectDer,
            validity,
            subjectDer,
            pubKeyInfo
        );

        Signature sig = Signature.getInstance("SHA256withRSA");
        sig.initSign(kp.getPrivate());
        sig.update(tbsCert);
        byte[] signature = sig.sign();

        return derSequence(tbsCert, algId, derBitString(signature));
    }

    private byte[] buildPkcs7(java.security.cert.X509Certificate cert, byte[] signature, byte[] signedData) throws Exception {
        byte[] certDer = cert.getEncoded();
        byte[] issuerAndSerial = derSequence(
            extractIssuer(certDer),
            derInteger(cert.getSerialNumber().toByteArray())
        );
        byte[] digestAlgId = derSequence(derOid(new int[]{2,16,840,1,101,3,4,2,1}), derNull());
        byte[] sigAlgId = derSequence(derOid(new int[]{1,2,840,113549,1,1,11}), derNull());

        byte[] signerInfo = derSequence(
            derInteger(new byte[]{1}),
            issuerAndSerial,
            digestAlgId,
            sigAlgId,
            derOctetString(signature)
        );

        byte[] contentInfo = derSequence(derOid(new int[]{1,2,840,113549,1,7,1}));
        byte[] signedDataSeq = derSequence(
            derInteger(new byte[]{1}),
            derSet(digestAlgId),
            contentInfo,
            derExplicit(0, certDer),
            derSet(signerInfo)
        );

        return derSequence(
            derOid(new int[]{1,2,840,113549,1,7,2}),
            derExplicit(0, signedDataSeq)
        );
    }

    private byte[] extractIssuer(byte[] certDer) {
        try {
            CertificateFactory cf = CertificateFactory.getInstance("X.509");
            java.security.cert.X509Certificate c = (java.security.cert.X509Certificate)
                cf.generateCertificate(new ByteArrayInputStream(certDer));
            return c.getIssuerX500Principal().getEncoded();
        } catch (Exception e) {
            return derSequence(derSet(derSequence(derOid(new int[]{2,5,4,3}), derUtf8("Agent Ultra"))));
        }
    }

    private Map<String, byte[]> readApkEntries(String apkPath) throws IOException {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        ZipInputStream zis = new ZipInputStream(new FileInputStream(apkPath));
        ZipEntry entry;
        while ((entry = zis.getNextEntry()) != null) {
            if (entry.isDirectory()) continue;
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int len;
            while ((len = zis.read(buf)) > 0) bos.write(buf, 0, len);
            entries.put(entry.getName(), bos.toByteArray());
        }
        zis.close();
        return entries;
    }

    private static byte[] derSequence(byte[]... items) {
        return derConstructed(0x30, items);
    }
    private static byte[] derSet(byte[]... items) {
        return derConstructed(0x31, items);
    }
    private static byte[] derConstructed(int tag, byte[]... items) {
        ByteArrayOutputStream content = new ByteArrayOutputStream();
        for (byte[] item : items) {
            try { content.write(item); } catch (IOException ignored) {}
        }
        byte[] body = content.toByteArray();
        return derTlv(tag, body);
    }
    private static byte[] derExplicit(int tagNum, byte[]... items) {
        ByteArrayOutputStream content = new ByteArrayOutputStream();
        for (byte[] item : items) {
            try { content.write(item); } catch (IOException ignored) {}
        }
        return derTlv(0xA0 | tagNum, content.toByteArray());
    }
    private static byte[] derInteger(byte[] val) { return derTlv(0x02, val); }
    private static byte[] derBitString(byte[] val) {
        byte[] body = new byte[val.length + 1];
        body[0] = 0;
        System.arraycopy(val, 0, body, 1, val.length);
        return derTlv(0x03, body);
    }
    private static byte[] derOctetString(byte[] val) { return derTlv(0x04, val); }
    private static byte[] derNull() { return new byte[]{0x05, 0x00}; }
    private static byte[] derOid(int[] oid) {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        b.write(oid[0] * 40 + oid[1]);
        for (int i = 2; i < oid.length; i++) {
            int v = oid[i];
            if (v < 128) b.write(v);
            else {
                Stack<Integer> stack = new Stack<>();
                while (v > 0) { stack.push(v & 0x7F); v >>= 7; }
                while (!stack.isEmpty()) {
                    int octet = stack.pop();
                    if (!stack.isEmpty()) octet |= 0x80;
                    b.write(octet);
                }
            }
        }
        return derTlv(0x06, b.toByteArray());
    }
    private static byte[] derUtf8(String s) { return derTlv(0x0C, s.getBytes(StandardCharsets.UTF_8)); }
    @SuppressWarnings("deprecation")
    private static byte[] derUtcTime(Date d) {
        java.text.SimpleDateFormat sdf = new java.text.SimpleDateFormat("yyMMddHHmmss'Z'");
        sdf.setTimeZone(TimeZone.getTimeZone("UTC"));
        return derTlv(0x17, sdf.format(d).getBytes(StandardCharsets.UTF_8));
    }
    private static byte[] derTlv(int tag, byte[] value) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(tag);
        int len = value.length;
        if (len < 128) out.write(len);
        else if (len < 256) { out.write(0x81); out.write(len); }
        else { out.write(0x82); out.write((len >> 8) & 0xFF); out.write(len & 0xFF); }
        try { out.write(value); } catch (IOException ignored) {}
        return out.toByteArray();
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
        modules.add(new AccessibilityBridgeModule(reactContext));
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
    <files-path name="maven" path="maven_cache/" />
    <cache-path name="cache" path="." />
    <external-files-path name="external" path="." />
</paths>`;

const ACCESSIBILITY_SERVICE_JAVA = `package com.agent.ultra;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.graphics.Rect;
import android.os.Bundle;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.util.Log;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.*;

public class AgentAccessibilityService extends AccessibilityService {
    private static final String TAG = "AgentA11y";
    private static AgentAccessibilityService instance;
    private String currentPackage = "";
    private static final Set<String> allowedPackages = Collections.synchronizedSet(new HashSet<String>());

    public static AgentAccessibilityService getInstance() { return instance; }
    public static boolean isRunning() { return instance != null; }

    public static void allowPackage(String pkg) { allowedPackages.add(pkg); }
    public static void revokePackage(String pkg) { allowedPackages.remove(pkg); }
    public static boolean isPackageAllowed(String pkg) { return allowedPackages.contains(pkg); }

    @Override
    public void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
        AccessibilityServiceInfo info = getServiceInfo();
        info.eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
            | AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
            | AccessibilityEvent.TYPE_VIEW_CLICKED;
        info.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC;
        info.flags = AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
            | AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
            | AccessibilityServiceInfo.FLAG_REQUEST_ENHANCED_WEB_ACCESSIBILITY;
        info.notificationTimeout = 100;
        setServiceInfo(info);
        Log.i(TAG, "Accessibility service connected");
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event.getPackageName() != null) {
            currentPackage = event.getPackageName().toString();
        }
    }

    @Override
    public void onInterrupt() {
        Log.w(TAG, "Accessibility service interrupted");
    }

    @Override
    public void onDestroy() {
        instance = null;
        super.onDestroy();
    }

    public String getActivePackage() { return currentPackage; }

    public String getScreenContent() {
        try {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root == null) return "{}";
            JSONObject tree = nodeToJson(root, 0, 5);
            root.recycle();
            return tree.toString();
        } catch (Exception e) {
            Log.e(TAG, "getScreenContent error", e);
            return "{\\"error\\":\\"" + e.getMessage() + "\\"}";
        }
    }

    private JSONObject nodeToJson(AccessibilityNodeInfo node, int depth, int maxDepth) {
        JSONObject obj = new JSONObject();
        try {
            obj.put("class", node.getClassName() != null ? node.getClassName().toString() : "");
            obj.put("text", node.getText() != null ? node.getText().toString() : "");
            obj.put("desc", node.getContentDescription() != null ? node.getContentDescription().toString() : "");
            obj.put("id", node.getViewIdResourceName() != null ? node.getViewIdResourceName() : "");
            Rect bounds = new Rect();
            node.getBoundsInScreen(bounds);
            obj.put("bounds", bounds.flattenToString());
            obj.put("clickable", node.isClickable());
            obj.put("scrollable", node.isScrollable());
            obj.put("editable", node.isEditable());
            obj.put("enabled", node.isEnabled());
            obj.put("focused", node.isFocused());

            if (depth < maxDepth && node.getChildCount() > 0) {
                JSONArray children = new JSONArray();
                for (int i = 0; i < node.getChildCount() && i < 50; i++) {
                    AccessibilityNodeInfo child = node.getChild(i);
                    if (child != null) {
                        children.put(nodeToJson(child, depth + 1, maxDepth));
                        child.recycle();
                    }
                }
                obj.put("children", children);
            }
        } catch (Exception e) {
            try { obj.put("error", e.getMessage()); } catch (Exception ignored) {}
        }
        return obj;
    }

    public boolean performClick(String selector) {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return false;
        AccessibilityNodeInfo target = findNode(root, selector);
        boolean result = false;
        if (target != null) {
            result = target.performAction(AccessibilityNodeInfo.ACTION_CLICK);
            target.recycle();
        }
        root.recycle();
        return result;
    }

    public boolean performText(String selector, String text) {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return false;
        AccessibilityNodeInfo target = findNode(root, selector);
        boolean result = false;
        if (target != null) {
            Bundle args = new Bundle();
            args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
            result = target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
            target.recycle();
        }
        root.recycle();
        return result;
    }

    public boolean performScroll(String direction) {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return false;
        AccessibilityNodeInfo scrollable = findScrollable(root);
        boolean result = false;
        if (scrollable != null) {
            int action = "up".equals(direction) || "backward".equals(direction)
                ? AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
                : AccessibilityNodeInfo.ACTION_SCROLL_FORWARD;
            result = scrollable.performAction(action);
            scrollable.recycle();
        }
        root.recycle();
        return result;
    }

    public boolean performBack() {
        return performGlobalAction(GLOBAL_ACTION_BACK);
    }

    public boolean performHome() {
        return performGlobalAction(GLOBAL_ACTION_HOME);
    }

    private AccessibilityNodeInfo findNode(AccessibilityNodeInfo root, String selector) {
        List<AccessibilityNodeInfo> byText = root.findAccessibilityNodeInfosByText(selector);
        if (byText != null && !byText.isEmpty()) return byText.get(0);
        List<AccessibilityNodeInfo> byId = root.findAccessibilityNodeInfosByViewId(selector);
        if (byId != null && !byId.isEmpty()) return byId.get(0);
        return findByContentDesc(root, selector);
    }

    private AccessibilityNodeInfo findByContentDesc(AccessibilityNodeInfo node, String desc) {
        if (node.getContentDescription() != null &&
            node.getContentDescription().toString().toLowerCase().contains(desc.toLowerCase())) {
            return AccessibilityNodeInfo.obtain(node);
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) {
                AccessibilityNodeInfo found = findByContentDesc(child, desc);
                if (found != null) { child.recycle(); return found; }
                child.recycle();
            }
        }
        return null;
    }

    private AccessibilityNodeInfo findScrollable(AccessibilityNodeInfo node) {
        if (node.isScrollable()) return AccessibilityNodeInfo.obtain(node);
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) {
                AccessibilityNodeInfo found = findScrollable(child);
                if (found != null) { child.recycle(); return found; }
                child.recycle();
            }
        }
        return null;
    }
}`;

const ACCESSIBILITY_BRIDGE_JAVA = `package com.agent.ultra;

import android.content.Context;
import android.content.Intent;
import android.provider.Settings;
import android.text.TextUtils;

import com.facebook.react.bridge.*;

public class AccessibilityBridgeModule extends ReactContextBaseJavaModule {
    private final ReactApplicationContext ctx;

    public AccessibilityBridgeModule(ReactApplicationContext context) {
        super(context);
        this.ctx = context;
    }

    @Override
    public String getName() {
        return "AppController";
    }

    @ReactMethod
    public void isServiceEnabled(Promise promise) {
        try {
            String service = ctx.getPackageName() + "/" + AgentAccessibilityService.class.getCanonicalName();
            String enabledServices = Settings.Secure.getString(
                ctx.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            boolean enabled = enabledServices != null && enabledServices.contains(service);
            promise.resolve(enabled || AgentAccessibilityService.isRunning());
        } catch (Exception e) {
            promise.resolve(false);
        }
    }

    @ReactMethod
    public void openAccessibilitySettings(Promise promise) {
        try {
            Intent intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
            intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(intent);
            promise.resolve(true);
        } catch (Exception e) {
            promise.reject("SETTINGS_ERROR", e.getMessage(), e);
        }
    }

    @ReactMethod
    public void allowPackage(String pkg, Promise promise) {
        AgentAccessibilityService.allowPackage(pkg);
        promise.resolve(true);
    }

    @ReactMethod
    public void revokePackage(String pkg, Promise promise) {
        AgentAccessibilityService.revokePackage(pkg);
        promise.resolve(true);
    }

    @ReactMethod
    public void getActivePackage(Promise promise) {
        if (!AgentAccessibilityService.isRunning()) {
            promise.resolve("");
            return;
        }
        promise.resolve(AgentAccessibilityService.getInstance().getActivePackage());
    }

    @ReactMethod
    public void getScreenContent(Promise promise) {
        if (!AgentAccessibilityService.isRunning()) {
            promise.resolve("{\\"error\\":\\"Service not running\\"}");
            return;
        }
        promise.resolve(AgentAccessibilityService.getInstance().getScreenContent());
    }

    @ReactMethod
    public void performClick(String selector, Promise promise) {
        if (!AgentAccessibilityService.isRunning()) {
            promise.resolve(false);
            return;
        }
        String pkg = AgentAccessibilityService.getInstance().getActivePackage();
        if (!AgentAccessibilityService.isPackageAllowed(pkg)) {
            promise.reject("NOT_ALLOWED", "Package " + pkg + " is not in the allowlist");
            return;
        }
        promise.resolve(AgentAccessibilityService.getInstance().performClick(selector));
    }

    @ReactMethod
    public void performText(String selector, String text, Promise promise) {
        if (!AgentAccessibilityService.isRunning()) {
            promise.resolve(false);
            return;
        }
        String pkg = AgentAccessibilityService.getInstance().getActivePackage();
        if (!AgentAccessibilityService.isPackageAllowed(pkg)) {
            promise.reject("NOT_ALLOWED", "Package " + pkg + " is not in the allowlist");
            return;
        }
        promise.resolve(AgentAccessibilityService.getInstance().performText(selector, text));
    }

    @ReactMethod
    public void performScroll(String direction, Promise promise) {
        if (!AgentAccessibilityService.isRunning()) {
            promise.resolve(false);
            return;
        }
        promise.resolve(AgentAccessibilityService.getInstance().performScroll(direction));
    }

    @ReactMethod
    public void performBack(Promise promise) {
        if (!AgentAccessibilityService.isRunning()) {
            promise.resolve(false);
            return;
        }
        promise.resolve(AgentAccessibilityService.getInstance().performBack());
    }

    @ReactMethod
    public void performHome(Promise promise) {
        if (!AgentAccessibilityService.isRunning()) {
            promise.resolve(false);
            return;
        }
        promise.resolve(AgentAccessibilityService.getInstance().performHome());
    }
}`;

const ACCESSIBILITY_SERVICE_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<accessibility-service xmlns:android="http://schemas.android.com/apk/res/android"
    android:description="@string/accessibility_service_description"
    android:accessibilityEventTypes="typeWindowStateChanged|typeWindowContentChanged|typeViewClicked"
    android:accessibilityFeedbackType="feedbackGeneric"
    android:notificationTimeout="100"
    android:canRetrieveWindowContent="true"
    android:settingsActivity="com.agent.ultra.MainActivity"
    android:accessibilityFlags="flagReportViewIds|flagIncludeNotImportantViews" />`;

const STRINGS_XML_ADDITION = `    <string name="accessibility_service_description">Agent Ultra uses accessibility to interact with other apps on your behalf. Enable only if you want Ultra to control apps for you.</string>`;

function withAgentNative(config) {
  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const projectRoot = config.modRequest.projectRoot;
      const androidDir = path.join(projectRoot, 'android');

      const javaDir = path.join(
        androidDir, 'app', 'src', 'main', 'java', 'com', 'agent', 'ultra'
      );
      fs.mkdirSync(javaDir, { recursive: true });
      fs.writeFileSync(path.join(javaDir, 'AgentNativeModule.java'), NATIVE_MODULE_JAVA);
      fs.writeFileSync(path.join(javaDir, 'AgentNativePackage.java'), NATIVE_PACKAGE_JAVA);
      fs.writeFileSync(path.join(javaDir, 'BinaryManifestWriter.java'), BINARY_MANIFEST_WRITER_JAVA);
      fs.writeFileSync(path.join(javaDir, 'ApkPackager.java'), APK_PACKAGER_JAVA);
      fs.writeFileSync(path.join(javaDir, 'ApkSignerV1.java'), APK_SIGNER_V1_JAVA);
      fs.writeFileSync(path.join(javaDir, 'AgentAccessibilityService.java'), ACCESSIBILITY_SERVICE_JAVA);
      fs.writeFileSync(path.join(javaDir, 'AccessibilityBridgeModule.java'), ACCESSIBILITY_BRIDGE_JAVA);

      const xmlDir = path.join(androidDir, 'app', 'src', 'main', 'res', 'xml');
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(path.join(xmlDir, 'file_paths.xml'), FILE_PROVIDER_PATHS);
      fs.writeFileSync(path.join(xmlDir, 'accessibility_service_config.xml'), ACCESSIBILITY_SERVICE_CONFIG);

      const stringsPath = path.join(androidDir, 'app', 'src', 'main', 'res', 'values', 'strings.xml');
      if (fs.existsSync(stringsPath)) {
        let stringsXml = fs.readFileSync(stringsPath, 'utf8');
        if (!stringsXml.includes('accessibility_service_description')) {
          stringsXml = stringsXml.replace('</resources>', STRINGS_XML_ADDITION + '\n</resources>');
          fs.writeFileSync(stringsPath, stringsXml);
        }
      }

      const mainAppPath = path.join(javaDir, 'MainApplication.java');
      if (fs.existsSync(mainAppPath)) {
        let mainApp = fs.readFileSync(mainAppPath, 'utf8');
        if (!mainApp.includes('AgentNativePackage')) {
          if (mainApp.includes('packages.add(new com.facebook.react.shell.MainReactPackage());')) {
            mainApp = mainApp.replace(
              'packages.add(new com.facebook.react.shell.MainReactPackage());',
              'packages.add(new com.facebook.react.shell.MainReactPackage());\n            packages.add(new AgentNativePackage());'
            );
          } else {
            const autolinkedMatch = mainApp.match(/(new\s+PackageList\(this\)\.getPackages\(\))/);
            if (autolinkedMatch) {
              mainApp = mainApp.replace(
                autolinkedMatch[0],
                autolinkedMatch[0] + ';\n            packages.add(new AgentNativePackage())'
              );
            }
            if (!mainApp.includes('AgentNativePackage')) {
              const addPackagesPattern = /(@Override\s+protected\s+List<ReactPackage>\s+getPackages\(\)\s*\{[\s\S]*?)(return\s+packages;)/;
              const addMatch = mainApp.match(addPackagesPattern);
              if (addMatch) {
                mainApp = mainApp.replace(
                  addMatch[2],
                  'packages.add(new AgentNativePackage());\n            ' + addMatch[2]
                );
              }
            }
          }
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
        'meta-data': [{
          $: {
            'android:name': 'android.support.FILE_PROVIDER_PATHS',
            'android:resource': '@xml/file_paths',
          },
        }],
      });
    }

    const hasA11y = (app.service || []).some(
      (s) => s.$['android:name'] === '.AgentAccessibilityService'
    );
    if (!hasA11y) {
      if (!app.service) app.service = [];
      app.service.push({
        $: {
          'android:name': '.AgentAccessibilityService',
          'android:permission': 'android.permission.BIND_ACCESSIBILITY_SERVICE',
          'android:exported': 'false',
        },
        'intent-filter': [{
          action: [{
            $: { 'android:name': 'android.accessibilityservice.AccessibilityService' },
          }],
        }],
        'meta-data': [{
          $: {
            'android:name': 'android.accessibilityservice',
            'android:resource': '@xml/accessibility_service_config',
          },
        }],
      });
    }

    return config;
  });

  return config;
}

module.exports = withAgentNative;

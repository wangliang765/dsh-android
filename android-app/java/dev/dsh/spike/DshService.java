package dev.dsh.spike;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.nio.file.Files;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * M1 shell service: extracts the dsh runtime payload from assets, then spawns
 * the bundled node ELF to run `dsh web` with the android patch overlay. The
 * ready line from stdout flips {@link #readyUrl}; MainActivity polls it.
 */
public class DshService extends Service {
    private static final String TAG = "dsh-spike";
    private static final String CHANNEL_ID = "dsh";
    private static final int NOTIFICATION_ID = 42;
    private static final Pattern READY = Pattern.compile("dsh web: (http://127\\.0\\.0\\.1:\\d+)");
    private static final Pattern PORT = Pattern.compile("--port (\\d+)");

    /** Ready URL once the server binds; null until then. Written by the reader thread. */
    public static volatile String readyUrl;
    /** Last log lines for the activity status view. */
    public static volatile String tail = "";

    private Process process;
    /** API key passed through the start intent (headless test seam). */
    private volatile String intentApiKey;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        startForegroundTyped();
        new Thread(this::run, "dsh-boot").start();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && intent.hasExtra("api_key")) {
            intentApiKey = intent.getStringExtra("api_key");
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (process != null) process.destroy();
        super.onDestroy();
    }

    private void startForegroundTyped() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID, "DeepSeek Harness", NotificationManager.IMPORTANCE_LOW);
        manager.createNotificationChannel(channel);
        Notification notification = new Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("DSH runtime")
            .setContentText("local agent runtime running")
            .setSmallIcon(android.R.drawable.sym_def_app_icon)
            .setOngoing(true)
            .build();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    /**
     * API key resolution order: start-intent extra (headless test seam), then
     * preferences, then files/api_key.txt.
     */
    private String resolveApiKey() {
        if (intentApiKey != null && !intentApiKey.isEmpty()) return intentApiKey;
        String stored = MainActivity.apiKey(this);
        if (!stored.isEmpty()) return stored;
        try {
            File file = new File(getFilesDir(), "api_key.txt");
            if (file.isFile()) {
                BufferedReader reader = new BufferedReader(new InputStreamReader(
                    new FileInputStream(file), "UTF-8"));
                String line = reader.readLine();
                reader.close();
                if (line != null) return line.trim();
            }
        } catch (Exception ignored) {
            Log.w(TAG, "api_key.txt read failed");
        }
        return "";
    }

    private void run() {
        try {
            File filesDir = getFilesDir();
            File runtimeDir = new File(filesDir, "runtime");
            extractAssets(runtimeDir);

            ArrayList<String> argv = new ArrayList<>();
            argv.add(new File(getApplicationInfo().nativeLibraryDir, "libnode_dsh.so").getAbsolutePath());
            // The post-boot watch-only HMR mount requires loader internals access.
            argv.add("--expose-internals");
            argv.add(new File(runtimeDir, "node_modules/@deepseek-ai/dsh/lib/bin.js").getAbsolutePath());
            argv.add("web");
            argv.add("--host");
            argv.add("127.0.0.1");
            argv.add("--port");
            argv.add("3080");

            ProcessBuilder builder = new ProcessBuilder(argv);
            Map<String, String> env = builder.environment();
            String nativeDir = getApplicationInfo().nativeLibraryDir;
            env.put("LD_LIBRARY_PATH", nativeDir);
            // The model's shell commands run through `bash -c`; stock Android
            // ships no bash binary (/system/bin has only toybox sh). Expose the
            // bundled termux bash (jniLibs libbash.so) on PATH via a symlink:
            // execve resolves through it into nativeLibraryDir, the one
            // W^X-exempt location on targetSdk >= 29, so SELinux allows it.
            File binDir = ensureBashOnPath(filesDir, nativeDir);
            env.put("PATH", binDir.getAbsolutePath() + ":" + nativeDir + ":/system/bin:/system/xbin");
            env.put("HOME", filesDir.getAbsolutePath());
            env.put("DSH_HOME", new File(filesDir, ".dsh").getAbsolutePath());
            env.put("DSH_AGENTS_HOME", new File(filesDir, ".agents").getAbsolutePath());
            env.put("TMPDIR", getCacheDir().getAbsolutePath());
            env.put("SSL_CERT_FILE", new File(filesDir, "etc/tls/cert.pem").getAbsolutePath());
            env.put("DEEPSEEK_API_KEY", resolveApiKey());
            env.put("DSH_PERMISSION_MODE", "danger-full-access");
            env.put("DSH_TELEMETRY_DISABLED", "1");
            env.put("LANG", "en_US.UTF-8");
            env.put("LC_ALL", "en_US.UTF-8");
            env.put("TERM", "xterm-256color");
            env.put("COLUMNS", "120");
            env.put("LINES", "40");

            File workspace = new File(filesDir, "workspace");
            workspace.mkdirs();
            builder.directory(workspace);
            builder.redirectErrorStream(true);

            appendTail("spawn: " + joinArgv(argv));
            process = builder.start();
            BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream()));
            String line;
            while ((line = reader.readLine()) != null) {
                Log.i(TAG, line);
                appendTail(line);
                Matcher matcher = READY.matcher(line);
                if (matcher.find()) {
                    readyUrl = matcher.group(1);
                    Log.i(TAG, "READY " + readyUrl);
                }
            }
            appendTail("node exited: " + process.waitFor());
        } catch (Throwable throwable) {
            Log.e(TAG, "boot failed", throwable);
            appendTail("ERROR " + Log.getStackTraceString(throwable));
        }
    }

    /**
     * Extracts runtime.zip / android.patch.yml / ca-cert.pem from assets when the
     * installed APK is newer than the last extraction (marker file comparison).
     */
    private void extractAssets(File runtimeDir) throws Exception {
        File marker = new File(runtimeDir, ".extracted");
        String fingerprint = Long.toString(
            getPackageManager().getPackageInfo(getPackageName(), 0).lastUpdateTime);
        runtimeDir.mkdirs();
        if (marker.exists() && fingerprint.equals(readFile(marker))) {
            appendTail("assets up to date, skipping extraction");
            return;
        }
        appendTail("extracting runtime payload...");
        unzip(getAssets().open("runtime.zip"), runtimeDir);
        // runtime.zip carries the patch overlay and CA bundle at its root next
        // to the node_modules tree; deploy each to its runtime location.
        File profileLayer = new File(new File(getFilesDir(), ".dsh/profiles/web"), "cordis.patch.yml");
        profileLayer.getParentFile().mkdirs();
        if (!new File(runtimeDir, "android.patch.yml").renameTo(profileLayer)) {
            throw new IllegalStateException("runtime.zip missing android.patch.yml entry");
        }
        File etcTls = new File(getFilesDir(), "etc/tls");
        etcTls.mkdirs();
        if (!new File(runtimeDir, "ca-cert.pem").renameTo(new File(etcTls, "cert.pem"))) {
            throw new IllegalStateException("runtime.zip missing ca-cert.pem entry");
        }
        writeFile(marker, fingerprint);
        appendTail("extraction done");
    }

    /**
     * Ensures files/bin/bash exists as a symlink to the bundled termux bash
     * (libbash.so inside nativeLibraryDir) and returns the bin dir for PATH.
     * Re-links when the install path changed (each update gets a new
     * /data/app/~~random/ directory).
     */
    private File ensureBashOnPath(File filesDir, String nativeDir) throws Exception {
        File binDir = new File(filesDir, "bin");
        if (!binDir.isDirectory() && !binDir.mkdirs()) {
            throw new IllegalStateException("cannot create app bin dir: " + binDir);
        }
        File link = new File(binDir, "bash");
        File target = new File(nativeDir, "libbash.so");
        boolean valid = false;
        try {
            valid = link.exists() && target.getAbsolutePath().equals(link.getCanonicalPath());
        } catch (IOException ignored) {
            // Stale or unreadable link: fall through and re-create it.
        }
        if (!valid) {
            link.delete();
            Files.createSymbolicLink(link.toPath(), target.toPath());
            appendTail("linked bash -> " + target);
        }
        return binDir;
    }

    private void unzip(InputStream input, File targetDir) throws Exception {
        byte[] buffer = new byte[1 << 16];
        try (ZipInputStream zip = new ZipInputStream(input)) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                File target = new File(targetDir, entry.getName());
                if (!target.getCanonicalPath().startsWith(targetDir.getCanonicalPath() + File.separator)
                    && !target.getCanonicalPath().equals(targetDir.getCanonicalPath())) {
                    throw new SecurityException("zip entry escapes target dir: " + entry.getName());
                }
                if (entry.isDirectory()) {
                    target.mkdirs();
                    continue;
                }
                target.getParentFile().mkdirs();
                try (OutputStream output = new FileOutputStream(target)) {
                    int read;
                    while ((read = zip.read(buffer)) > 0) {
                        output.write(buffer, 0, read);
                    }
                }
            }
        }
    }

    private static synchronized void appendTail(String line) {
        StringBuilder next = new StringBuilder(tail);
        next.append(line).append('\n');
        if (next.length() > 8192) next.delete(0, next.length() - 4096);
        tail = next.toString();
    }

    private static String joinArgv(ArrayList<String> argv) {
        StringBuilder out = new StringBuilder();
        for (String arg : argv) out.append(arg).append(' ');
        return out.toString();
    }

    private static String readFile(File file) throws Exception {
        try (InputStream input = new FileInputStream(file)) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int read;
            while ((read = input.read(buffer)) > 0) out.write(buffer, 0, read);
            return out.toString("UTF-8").trim();
        }
    }

    private static void writeFile(File file, String content) throws Exception {
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(content.getBytes("UTF-8"));
        }
    }
}

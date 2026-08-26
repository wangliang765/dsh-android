package dev.dsh.spike;

import android.app.Notification;
import android.app.NotificationManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.BatteryManager;
import android.os.Build;
import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * M2 Bridge v1: a hand-rolled loopback HTTP/1.1 JSON service (127.0.0.1:3081)
 * the Node-side toolkit plugin (@dsh-external/android-bridge-tools) calls to
 * reach native Android capabilities: notifications, clipboard, share sheet,
 * SAF picking, and device facts. com.sun.net.httpserver is absent from
 * android.jar, so this parses the minimal request shape itself: one request
 * per connection (Connection: close), POST only, Content-Length bodies.
 * Every response body is {ok:true,...} or {ok:false,error,code}.
 */
public class BridgeServer {
    private static final String TAG = "dsh-bridge";
    private static final int PORT = 3081;
    private static final int MAX_BODY = 4 * 1024 * 1024;
    /** Model-posted notification ids start above the FGS's fixed id (42). */
    private static final int NOTIFY_BASE_ID = 1000;

    private ServerSocket serverSocket;
    private ExecutorService pool;
    private volatile boolean running;
    private final DshService owner;

    public BridgeServer(DshService owner) {
        this.owner = owner;
    }

    /** Binds and serves; failures are logged, never fatal to the runtime. */
    public void start() {
        try {
            serverSocket = new ServerSocket(PORT, 16, java.net.InetAddress.getByName("127.0.0.1"));
            running = true;
            pool = Executors.newFixedThreadPool(3);
            Thread acceptor = new Thread(this::acceptLoop, "dsh-bridge-accept");
            acceptor.setDaemon(true);
            acceptor.start();
            Log.i(TAG, "bridge listening on 127.0.0.1:" + PORT);
        } catch (Throwable t) {
            Log.e(TAG, "bridge start failed", t);
        }
    }

    public void stop() {
        running = false;
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (IOException ignored) {
        }
        if (pool != null) pool.shutdownNow();
    }

    private void acceptLoop() {
        while (running) {
            try {
                Socket socket = serverSocket.accept();
                pool.execute(() -> serve(socket));
            } catch (IOException e) {
                if (running) Log.w(TAG, "accept failed", e);
            }
        }
    }

    /** Handles exactly one request per connection, then closes. */
    private void serve(Socket socket) {
        try {
            socket.setSoTimeout(150_000); // SAF picker polls up to 120s inside the handler
            InputStream in = socket.getInputStream();
            String requestLine = readLine(in);
            if (requestLine == null || !requestLine.startsWith("POST ")) {
                respond(socket, 405, err("POST only", "HTTP_405"));
                return;
            }
            String path = requestLine.split(" ")[1];
            int contentLength = 0;
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                int colon = line.indexOf(':');
                if (colon > 0) {
                    String name = line.substring(0, colon).trim().toLowerCase(java.util.Locale.US);
                    if ("content-length".equals(name)) {
                        try { contentLength = Integer.parseInt(line.substring(colon + 1).trim()); } catch (NumberFormatException ignored) {}
                    }
                }
            }
            if (contentLength > MAX_BODY) {
                respond(socket, 400, err("body too large", "BODY_TOO_LARGE"));
                return;
            }
            byte[] bodyBytes = new byte[contentLength];
            int off = 0;
            while (off < contentLength) {
                int read = in.read(bodyBytes, off, contentLength - off);
                if (read < 0) break;
                off += read;
            }
            JSONObject req = new JSONObject(off > 0 ? new String(bodyBytes, StandardCharsets.UTF_8) : "{}");
            dispatch(socket, path, req);
        } catch (org.json.JSONException je) {
            safeRespond(socket, 400, errStatic("bad json body: " + je.getMessage(), "BAD_JSON"));
        } catch (Throwable t) {
            Log.w(TAG, "request failed", t);
            safeRespond(socket, 500, errStatic(String.valueOf(t.getMessage()), "BRIDGE_INTERNAL"));
        } finally {
            try { socket.close(); } catch (IOException ignored) {}
        }
    }

    private void dispatch(Socket socket, String path, JSONObject req) throws Exception {
        switch (path) {
            case "/notify":
                handleNotify(socket, req); return;
            case "/clipboard/read":
                handleClipboardRead(socket); return;
            case "/clipboard/write":
                handleClipboardWrite(socket, req); return;
            case "/share/text":
                handleShareText(socket, req); return;
            case "/share/targets":
                handleShareTargets(socket); return;
            case "/pick/file":
                handlePickFile(socket, req); return;
            case "/device/info":
                handleDeviceInfo(socket); return;
            case "/health":
                respond(socket, 200, okObj().put("service", "android-bridge").put("version", 1)); return;
            default:
                respond(socket, 404, err("unknown endpoint " + path, "UNKNOWN_ENDPOINT"));
        }
    }

    // ── endpoints ────────────────────────────────────────────────────────

    private void handleNotify(Socket socket, JSONObject req) throws Exception {
        // Android 13+ silently drops posts without POST_NOTIFICATIONS; surface
        // the denial instead of reporting success into the void.
        if (Build.VERSION.SDK_INT >= 33 && owner.checkSelfPermission(
                android.Manifest.permission.POST_NOTIFICATIONS)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            respond(socket, 200, err(
                "POST_NOTIFICATIONS not granted; grant it in system settings to post notifications",
                "NOTIFICATION_DENIED"));
            return;
        }
        String title = req.optString("title", "DSH");
        String text = req.optString("text", "");
        NotificationManager nm = owner.getSystemService(NotificationManager.class);
        int id = NOTIFY_BASE_ID + (int) (System.currentTimeMillis() % 100000L);
        Notification n = new Notification.Builder(owner, DshService.CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(android.R.drawable.sym_def_app_icon)
            .setAutoCancel(true)
            .build();
        nm.notify(id, n);
        respond(socket, 200, okObj().put("posted", true).put("notificationId", id));
    }

    private void handleClipboardRead(Socket socket) throws Exception {
        // Android 10+: only the focused app may read the clipboard; background
        // reads yield stale/empty data. Deny cleanly instead of lying.
        if (!isAppForeground()) {
            respond(socket, 200, err(
                "clipboard read requires the app to be in the foreground on Android 10+",
                "CLIPBOARD_BLOCKED"));
            return;
        }
        ClipboardManager cm = (ClipboardManager) owner.getSystemService(Context.CLIPBOARD_SERVICE);
        ClipData clip = cm.getPrimaryClip();
        CharSequence text = clip != null && clip.getItemCount() > 0 ? clip.getItemAt(0).coerceToText(owner) : "";
        respond(socket, 200, okObj().put("text", text == null ? "" : text.toString()));
    }

    /** True while any of the app's activities is front-of-screen. */
    private boolean isAppForeground() {
        android.app.ActivityManager am = (android.app.ActivityManager) owner.getSystemService(Context.ACTIVITY_SERVICE);
        java.util.List<android.app.ActivityManager.RunningAppProcessInfo> procs = am.getRunningAppProcesses();
        if (procs == null) return false;
        for (android.app.ActivityManager.RunningAppProcessInfo info : procs) {
            if (info.uid == owner.getApplicationInfo().uid
                && info.importance <= android.app.ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND) {
                return true;
            }
        }
        return false;
    }

    private void handleClipboardWrite(Socket socket, JSONObject req) throws Exception {
        String text = req.optString("text", "");
        ClipboardManager cm = (ClipboardManager) owner.getSystemService(Context.CLIPBOARD_SERVICE);
        cm.setPrimaryClip(ClipData.newPlainText("dsh", text));
        respond(socket, 200, okObj().put("copied", true).put("length", text.length()));
    }

    /**
     * ACTION_SEND chooser launched from the service context needs
     * FLAG_ACTIVITY_NEW_TASK; the chooser runs in its own task and this
     * endpoint answers right away (the user completes/dismisses it there).
     * When `packageName` is set, the sheet is bypassed and the send intent
     * targets that app directly (still lands in its own compose UI — no
     * public API exists to auto-pick a friend/chat inside WeChat/QQ).
     */
    private void handleShareText(Socket socket, JSONObject req) throws Exception {
        String text = req.optString("text", "");
        String subject = req.has("subject") && !req.isNull("subject") ? req.getString("subject") : null;
        String pkg = req.has("packageName") && !req.isNull("packageName") ? req.getString("packageName").trim() : "";
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("text/plain");
        send.putExtra(Intent.EXTRA_TEXT, text);
        if (subject != null) send.putExtra(Intent.EXTRA_SUBJECT, subject);
        Intent launch;
        boolean targeted;
        if (!pkg.isEmpty()) {
            // Validate the target really handles ACTION_SEND text/plain before
            // launching; an unknown package would crash with ActivityNotFound.
            java.util.List<android.content.pm.ResolveInfo> candidates =
                owner.getPackageManager().queryIntentActivities(send, 0);
            boolean found = false;
            for (android.content.pm.ResolveInfo info : candidates) {
                if (pkg.equals(info.activityInfo.packageName)) { found = true; break; }
            }
            if (!found) {
                respond(socket, 200, err("package " + pkg + " does not accept shared text", "SHARE_TARGET_UNAVAILABLE"));
                return;
            }
            send.setPackage(pkg);
            launch = send;
            targeted = true;
        } else {
            launch = Intent.createChooser(send, "Share via");
            targeted = false;
        }
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        owner.startActivity(launch);
        respond(socket, 200, okObj().put("shared", true)
            .put("targeted", targeted)
            .putOpt("packageName", targeted ? pkg : null));
    }

    /**
     * Enumerate installed apps whose share UI accepts text/plain, so the model
     * can offer concrete android_share_text packageName choices. Returns the
     * deduplicated set of packages with their user-visible labels, sorted.
     */
    private void handleShareTargets(Socket socket) throws Exception {
        Intent probe = new Intent(Intent.ACTION_SEND);
        probe.setType("text/plain");
        java.util.List<android.content.pm.ResolveInfo> infos =
            owner.getPackageManager().queryIntentActivities(probe, 0);
        java.util.TreeMap<String, String> byPackage = new java.util.TreeMap<>();
        for (android.content.pm.ResolveInfo info : infos) {
            String label;
            try { label = String.valueOf(info.loadLabel(owner.getPackageManager())); }
            catch (Throwable t) { label = info.activityInfo.packageName; }
            byPackage.put(info.activityInfo.packageName, label);
        }
        JSONArray apps = new JSONArray();
        for (java.util.Map.Entry<String, String> entry : byPackage.entrySet()) {
            JSONObject app = new JSONObject();
            app.put("packageName", entry.getKey());
            app.put("label", entry.getValue());
            apps.put(app);
        }
        respond(socket, 200, okObj().put("apps", apps).put("count", apps.length()));
    }

    /**
     * SAF open-document picker. v1 keeps the interaction one-shot: hand the
     * request to MainActivity (which owns the UI stack) so IT calls
     * startActivityForResult — results only reach the Activity that started
     * them. The activity stages {picked:true,name,path,sizeBytes,mimeType} or
     * {picked:false} under files/picked/<pickId>.json; we poll for it here.
     */
    private void handlePickFile(Socket socket, JSONObject req) throws Exception {
        String pickId = "pick-" + Long.toHexString(System.currentTimeMillis());
        File signalDir = new File(owner.getFilesDir(), "picked");
        signalDir.mkdirs();
        File signal = new File(signalDir, pickId + ".json");
        signal.delete();

        MainActivity.pendingPickId = pickId;
        MainActivity.pendingPickRequest = req.toString();
        Intent relay = new Intent(owner, MainActivity.class);
        relay.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        relay.putExtra("dsh_pick", pickId);
        owner.startActivity(relay);

        long deadline = System.currentTimeMillis() + 120_000L;
        while (System.currentTimeMillis() < deadline) {
            if (signal.isFile()) {
                byte[] bytes = Files.readAllBytes(signal.toPath());
                signal.delete();
                respondRaw(socket, 200, new String(bytes, StandardCharsets.UTF_8));
                return;
            }
            try { Thread.sleep(500L); } catch (InterruptedException ie) { break; }
        }
        respond(socket, 200, err("picker timed out without user choice", "PICK_TIMEOUT"));
    }

    private void handleDeviceInfo(Socket socket) throws Exception {
        BatteryManager bm = (BatteryManager) owner.getSystemService(Context.BATTERY_SERVICE);
        int percent = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
        Intent charged = owner.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        int status = charged != null ? charged.getIntExtra(BatteryManager.EXTRA_STATUS, -1) : -1;
        boolean charging = status == BatteryManager.BATTERY_STATUS_CHARGING
            || status == BatteryManager.BATTERY_STATUS_FULL;
        JSONObject out = okObj()
            .put("manufacturer", Build.MANUFACTURER)
            .put("model", Build.MODEL)
            .put("androidVersion", Build.VERSION.RELEASE)
            .put("sdkInt", Build.VERSION.SDK_INT)
            .put("charging", charging)
            .put("serviceAlive", true);
        // Omit (not null) when unknown: output schemas reject null for integer.
        if (percent > 0) out.put("batteryPercent", percent);
        respond(socket, 200, out);
    }

    // ── plumbing ─────────────────────────────────────────────────────────

    private static JSONObject okObj() throws Exception { return new JSONObject().put("ok", true); }

    private static JSONObject err(String message, String code) throws Exception {
        return new JSONObject().put("ok", false).put("error", message).put("code", code);
    }

    /** Exception-free twin of {@link #err} for catch blocks. */
    private static JSONObject errStatic(String message, String code) {
        try { return err(message, code); } catch (Exception e) { return new JSONObject(); }
    }

    /** Reads one CRLF/LF-terminated header line; null at stream end. */
    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream(128);
        int prev = -1;
        int c;
        while ((c = in.read()) >= 0) {
            if (prev == '\r' && c == '\n') break;
            if (c != '\n' && c != '\r') buf.write(c);
            prev = c;
            if (buf.size() > 8192) throw new IOException("header line too long");
        }
        if (buf.size() == 0 && c < 0) return null;
        return buf.toString("UTF-8");
    }

    private static void respond(Socket socket, int status, JSONObject body) throws IOException {
        respondRaw(socket, status, body.toString());
    }

    private static void respondRaw(Socket socket, int status, String json) throws IOException {
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        OutputStream os = socket.getOutputStream();
        os.write(("HTTP/1.1 " + status + " " + reason(status) + "\r\n"
            + "Content-Type: application/json; charset=utf-8\r\n"
            + "Content-Length: " + bytes.length + "\r\n"
            + "Connection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        os.write(bytes);
        os.flush();
    }

    private static void safeRespond(Socket socket, int status, JSONObject body) {
        try { respond(socket, status, body); } catch (IOException ignored) {}
    }

    private static String reason(int status) {
        switch (status) {
            case 200: return "OK";
            case 400: return "Bad Request";
            case 404: return "Not Found";
            case 405: return "Method Not Allowed";
            default: return "Error";
        }
    }
}

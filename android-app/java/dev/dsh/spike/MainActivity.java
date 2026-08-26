package dev.dsh.spike;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.text.TextUtils;
import android.util.Log;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.ScrollView;
import android.widget.TextView;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** M1 shell: collect the API key, start the foreground runtime, show the GUI when ready. */
public class MainActivity extends Activity {
    private static final String TAG = "dsh-spike";
    private static final int REQUEST_NOTIFICATIONS = 7;
    private static final int REQUEST_PICK_FILE = 11;

    /** Pick id the in-flight SAF request is staged under; null when idle. */
    public static volatile String pendingPickId;
    /** JSON args for the in-flight pick (mimeTypes/title), staged by BridgeServer. */
    public static volatile String pendingPickRequest;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView webView;
    private TextView status;
    private boolean webShown;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        status = new TextView(this);
        status.setTextIsSelectable(true);
        status.setPadding(32, 32, 32, 32);
        ScrollView scroller = new ScrollView(this);
        scroller.addView(status);
        setContentView(scroller);
        status.setText("starting dsh runtime...\n");

        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFICATIONS);
        }

        if (TextUtils.isEmpty(apiKey(this)) && TextUtils.isEmpty(getIntent().getStringExtra("api_key"))) {
            promptApiKey();
            return;
        }
        startRuntime();
        handleSendIntent(getIntent());
        maybeStartPick(getIntent());
    }

    /**
     * BridgeServer relays android_pick_file here (results only reach the
     * activity that starts them). The relay intent carries the pick id; the
     * request JSON sits in the static pendingPickRequest slot.
     */
    private void maybeStartPick(Intent intent) {
        if (intent == null || !intent.hasExtra("dsh_pick")) return;
        String pickId = intent.getStringExtra("dsh_pick");
        if (!pickId.equals(pendingPickId) || pendingPickRequest == null) return;
        try {
            JSONObject req = new JSONObject(pendingPickRequest);
            Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            pick.addCategory(Intent.CATEGORY_OPENABLE);
            java.util.ArrayList<String> mimes = new java.util.ArrayList<>();
            org.json.JSONArray arr = req.optJSONArray("mimeTypes");
            if (arr != null) for (int i = 0; i < arr.length(); i++) mimes.add(arr.optString(i));
            if (mimes.size() == 1) pick.setType(mimes.get(0));
            else if (mimes.isEmpty()) pick.setType("*/*");
            else {
                pick.setType("*/*");
                pick.putExtra(Intent.EXTRA_MIME_TYPES, mimes.toArray(new String[0]));
            }
            startActivityForResult(pick, REQUEST_PICK_FILE);
        } catch (Exception e) {
            Log.w(TAG, "pick relay failed", e);
            JSONObject fail = new JSONObject();
            try {
                fail.put("ok", false).put("error", String.valueOf(e.getMessage())).put("code", "PICK_LAUNCH_FAILED");
            } catch (Exception ignored) {}
            stagePickResult(pickId, fail);
        }
    }

    /** Stages shared text; consumed once the WebView exists. */
    private void handleSendIntent(Intent intent) {
        if (intent == null || !"android.intent.action.SEND".equals(intent.getAction())) return;
        String type = intent.getType();
        if (type == null || !type.startsWith("text/")) return;
        String shared = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (shared == null || shared.isEmpty()) return;
        prefs(this).edit().putString("pending_share", shared).apply();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleSendIntent(intent);
        maybeStartPick(intent);
        injectPendingShare();
    }

    /** Injects the queued share into the composer, if the WebView is live. */
    private void injectPendingShare() {
        if (!webShown || webView == null) return;
        String text = prefs(this).getString("pending_share", "");
        if (text.isEmpty()) return;
        prefs(this).edit().remove("pending_share").apply();
        String js = "(function(){var ta=document.querySelector('textarea');"
            + "if(!ta){return 'no-composer';}"
            + "ta.focus();"
            + "var setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;"
            + "setter.call(ta," + org.json.JSONObject.quote(text) + ");"
            + "ta.dispatchEvent(new Event('input',{bubbles:true}));"
            + "return 'seeded';})()";
        webView.evaluateJavascript(js, null);
    }

    private static MainActivity instance;

    @Override
    protected void onResume() {
        super.onResume();
        instance = this;
        injectPendingShare();
    }

    @Override
    protected void onPause() {
        super.onPause();
        instance = null;
    }

    /**
     * SAF outcome for android_pick_file: copies the picked content into
     * workspace/picked/<display name> and stages the result JSON under
     * files/picked/<pickId>.json where BridgeServer.handlePickFile polls it.
     * Cancel stages {picked:false}; every failure degrades to a staged error
     * so the tool call always settles with a structured answer.
     */
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_PICK_FILE) return;
        String pickId = pendingPickId;
        pendingPickId = null;
        pendingPickRequest = null;
        if (pickId == null) return;
        JSONObject out = new JSONObject();
        try {
            Uri uri = data != null ? data.getData() : null;
            if (resultCode != RESULT_OK || uri == null) {
                out.put("ok", true).put("picked", false).put("reason", "cancelled");
            } else {
                String name = queryDisplayName(uri);
                File pickedDir = new File(getFilesDir(), "workspace/picked");
                pickedDir.mkdirs();
                File target = uniqueTarget(pickedDir, name != null ? name : "picked-file");
                long bytes = copyStream(getContentResolver().openInputStream(uri), target);
                String mime = getContentResolver().getType(uri);
                out.put("ok", true).put("picked", true)
                    .put("path", "picked/" + target.getName())
                    .put("displayName", target.getName())
                    .put("sizeBytes", bytes)
                    .putOpt("mimeType", mime == null ? null : mime)
                    .put("sourceUri", uri.toString());
            }
        } catch (Throwable t) {
            Log.w(TAG, "pick handling failed", t);
            JSONObject fail = new JSONObject();
            try {
                fail.put("ok", false).put("error", String.valueOf(t.getMessage())).put("code", "PICK_COPY_FAILED");
            } catch (Exception ignored) {}
            out = fail;
        }
        stagePickResult(pickId, out);
    }

    /** Writes the outcome JSON BridgeServer.handlePickFile polls for. */
    private static void stagePickResult(String pickId, JSONObject out) {
        try {
            File signal = new File(new File(getInstance().getFilesDir(), "picked"), pickId + ".json");
            FileOutputStream fout = new FileOutputStream(signal);
            fout.write(out.toString().getBytes(StandardCharsets.UTF_8));
            fout.close();
        } catch (Exception e) {
            Log.e(TAG, "cannot stage pick result", e);
        }
    }

    static MainActivity getInstance() { return instance; }

    /** OpenableColumns display-name lookup; null when the provider omits it. */
    private String queryDisplayName(Uri uri) {
        try (Cursor cursor = getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0 && !cursor.isNull(idx)) return cursor.getString(idx);
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    /** Appends -2/-3/… before the extension when the name already exists. */
    private static File uniqueTarget(File dir, String name) {
        File candidate = new File(dir, name);
        if (!candidate.exists()) return candidate;
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 2; i < 1000; i++) {
            candidate = new File(dir, base + "-" + i + ext);
            if (!candidate.exists()) return candidate;
        }
        throw new IllegalStateException("cannot find a free name for " + name);
    }

    private static long copyStream(InputStream input, File target) throws Exception {
        OutputStream fout = new FileOutputStream(target);
        byte[] buffer = new byte[65536];
        long total = 0;
        try {
            int read;
            while ((read = input.read(buffer)) > 0) {
                fout.write(buffer, 0, read);
                total += read;
            }
        } finally {
            try { input.close(); } catch (Exception ignored) {}
            fout.close();
        }
        return total;
    }

    private void promptApiKey() {
        EditText input = new EditText(this);
        input.setHint("DEEPSEEK_API_KEY (sk-...)");
        new AlertDialog.Builder(this)
            .setTitle("DeepSeek API Key")
            .setMessage("Stored in app-private preferences and passed to the local runtime as an environment variable.")
            .setView(input)
            .setCancelable(false)
            .setPositiveButton("Save & start", (dialog, which) -> {
                SharedPreferences prefs = prefs(this);
                prefs.edit().putString("api_key", input.getText().toString().trim()).apply();
                startRuntime();
            })
            .show();
    }

    private void startRuntime() {
        Intent intent = new Intent(this, DshService.class);
        // Test seam: an --es api_key extra overrides stored credentials so
        // headless emulator runs can inject a key without UI interaction.
        String extra = getIntent().getStringExtra("api_key");
        if (extra != null && !extra.isEmpty()) intent.putExtra("api_key", extra);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent);
        else startService(intent);
        handler.postDelayed(this::pollReady, 1000);
    }

    /** Polls the service's ready URL; swaps the status view for the WebView once bound. */
    private void pollReady() {
        String url = DshService.readyUrl;
        if (url == null) {
            String snapshot = DshService.tail;
            if (!webShown && snapshot.length() > 0) {
                String tail = snapshot.length() > 4000
                    ? snapshot.substring(snapshot.length() - 4000)
                    : snapshot;
                status.setText(tail);
            }
            handler.postDelayed(this::pollReady, 1000);
            return;
        }
        if (webShown) return;
        webShown = true;
        Log.i(TAG, "loading GUI at " + url);
        setContentView(webView());
        webView.loadUrl(url);
        injectPendingShare();
    }

    private WebView webView() {
        webView = new WebView(this);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                injectMobileOverrides(view);
            }
        });
        return webView;
    }

    /**
     * Idempotently injects the res/raw mobile CSS overrides into the page head.
     * A style tag survives SPA re-renders, and onPageFinished fires again on
     * every real navigation, so one guard-by-id check covers both paths. The
     * overrides live entirely in this app (docs/m1-notes.md): upstream web
     * bundles stay untouched, so following upstream releases needs no merge.
     */
    private void injectMobileOverrides(WebView view) {
        try {
            BufferedReader reader = new BufferedReader(new InputStreamReader(
                getResources().openRawResource(R.raw.mobile_overrides), "UTF-8"));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line).append('\n');
            }
            reader.close();
            String js = "(function(){if(document.getElementById('dsh-mobile-overrides'))return;"
                + "var s=document.createElement('style');s.id='dsh-mobile-overrides';"
                + "s.textContent=" + org.json.JSONObject.quote(sb.toString()) + ";"
                + "document.head.appendChild(s);})()";
            view.evaluateJavascript(js, null);
        } catch (Exception e) {
            Log.w(TAG, "mobile overrides injection failed", e);
        }
    }

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("dsh", Context.MODE_PRIVATE);
    }

    static String apiKey(Context context) {
        return prefs(context).getString("api_key", "");
    }
}

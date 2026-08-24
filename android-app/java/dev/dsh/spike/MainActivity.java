package dev.dsh.spike;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.Log;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.ScrollView;
import android.widget.TextView;

/** M1 shell: collect the API key, start the foreground runtime, show the GUI when ready. */
public class MainActivity extends Activity {
    private static final String TAG = "dsh-spike";
    private static final int REQUEST_NOTIFICATIONS = 7;

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
    }

    private WebView webView() {
        webView = new WebView(this);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.setWebViewClient(new WebViewClient());
        return webView;
    }

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("dsh", Context.MODE_PRIVATE);
    }

    static String apiKey(Context context) {
        return prefs(context).getString("api_key", "");
    }
}

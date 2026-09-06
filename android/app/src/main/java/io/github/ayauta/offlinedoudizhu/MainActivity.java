package io.github.ayauta.offlinedoudizhu;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;

public final class MainActivity extends Activity {
    private static final String ASSET_HOST = "appassets.androidplatform.net";
    private static final String ASSET_PREFIX = "/assets/";
    private static final String HOME_URL =
            "https://appassets.androidplatform.net/assets/embedded.html";
    private static final long EXIT_CONFIRMATION_WINDOW_MILLIS = 2_000L;

    private WebView webView;
    private long exitConfirmationStartedAt = -1L;
    @Nullable private Toast exitToast;
    @Nullable private OnBackInvokedCallback backInvokedCallback;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(6, 63, 45));
        setContentView(
                webView,
                new ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT));
        configureFullscreenWindow();
        configureWebView(webView);
        configureSystemBack();

        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            webView.loadUrl(HOME_URL);
        }
    }

    private void configureSystemBack() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return;
        }

        backInvokedCallback = this::handleSystemBack;
        getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                backInvokedCallback);
    }

    private void handleSystemBack() {
        long now = SystemClock.elapsedRealtime();
        if (exitConfirmationStartedAt >= 0L
                && now - exitConfirmationStartedAt <= EXIT_CONFIRMATION_WINDOW_MILLIS) {
            clearExitConfirmation();
            finishAndRemoveTask();
            return;
        }

        exitConfirmationStartedAt = now;
        if (exitToast != null) {
            exitToast.cancel();
        }
        exitToast = Toast.makeText(this, R.string.press_back_again_to_exit, Toast.LENGTH_SHORT);
        exitToast.show();
    }

    private void clearExitConfirmation() {
        exitConfirmationStartedAt = -1L;
        if (exitToast != null) {
            exitToast.cancel();
            exitToast = null;
        }
    }

    // Android 13+ dispatches to backInvokedCallback; this override is the API 29-32 fallback.
    @SuppressLint("GestureBackNavigation")
    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        handleSystemBack();
    }

    private void configureFullscreenWindow() {
        WindowManager.LayoutParams attributes = getWindow().getAttributes();
        attributes.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        getWindow().setAttributes(attributes);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.systemBars());
                controller.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
            return;
        }

        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    @SuppressLint({"SetJavaScriptEnabled", "ObsoleteSdkInt"})
    private void configureWebView(@NonNull WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setBlockNetworkLoads(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setGeolocationEnabled(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSafeBrowsingEnabled(true);

        boolean debuggable =
                (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debuggable);

        WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler(
                        ASSET_PREFIX,
                        new WebViewAssetLoader.AssetsPathHandler(this))
                .build();
        view.setWebViewClient(new LocalContentClient(assetLoader));
    }

    private static boolean isLocalAsset(@Nullable Uri uri) {
        return uri != null
                && "https".equals(uri.getScheme())
                && ASSET_HOST.equals(uri.getHost())
                && uri.getPath() != null
                && uri.getPath().startsWith(ASSET_PREFIX);
    }

    private static WebResourceResponse blockedResponse() {
        byte[] body = "Not found".getBytes(StandardCharsets.UTF_8);
        return new WebResourceResponse(
                "text/plain",
                StandardCharsets.UTF_8.name(),
                404,
                "Not Found",
                Collections.singletonMap("Cache-Control", "no-store"),
                new ByteArrayInputStream(body));
    }

    private final class LocalContentClient extends WebViewClientCompat {
        private final WebViewAssetLoader assetLoader;

        private LocalContentClient(WebViewAssetLoader assetLoader) {
            this.assetLoader = assetLoader;
        }

        @Override
        public boolean shouldOverrideUrlLoading(
                @NonNull WebView view,
                @NonNull WebResourceRequest request) {
            return !isLocalAsset(request.getUrl());
        }

        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(@NonNull WebView view, @NonNull String url) {
            return !isLocalAsset(Uri.parse(url));
        }

        @Nullable
        @Override
        public WebResourceResponse shouldInterceptRequest(
                @NonNull WebView view,
                @NonNull WebResourceRequest request) {
            if (!isLocalAsset(request.getUrl())) {
                return blockedResponse();
            }
            WebResourceResponse response = assetLoader.shouldInterceptRequest(request.getUrl());
            return response == null ? blockedResponse() : response;
        }

        @Nullable
        @Override
        @SuppressWarnings("deprecation")
        public WebResourceResponse shouldInterceptRequest(
                @NonNull WebView view,
                @NonNull String url) {
            Uri uri = Uri.parse(url);
            if (!isLocalAsset(uri)) {
                return blockedResponse();
            }
            WebResourceResponse response = assetLoader.shouldInterceptRequest(uri);
            return response == null ? blockedResponse() : response;
        }

        @Override
        public boolean onRenderProcessGone(
                @NonNull WebView view,
                @NonNull RenderProcessGoneDetail detail) {
            view.destroy();
            recreate();
            return true;
        }
    }

    @Override
    protected void onSaveInstanceState(@NonNull Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onPause() {
        clearExitConfirmation();
        webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        configureFullscreenWindow();
        webView.onResume();
    }

    @Override
    protected void onDestroy() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && backInvokedCallback != null) {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backInvokedCallback);
            backInvokedCallback = null;
        }
        clearExitConfirmation();
        webView.stopLoading();
        webView.destroy();
        super.onDestroy();
    }
}

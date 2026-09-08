package io.github.ayauta.offlinedoudizhu;

import static androidx.test.espresso.web.assertion.WebViewAssertions.webMatches;
import static androidx.test.espresso.web.sugar.Web.onWebView;
import static androidx.test.espresso.web.webdriver.DriverAtoms.findElement;
import static androidx.test.espresso.web.webdriver.DriverAtoms.getText;
import static androidx.test.espresso.web.webdriver.DriverAtoms.webClick;
import static org.hamcrest.Matchers.containsString;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import android.app.Instrumentation;
import android.content.pm.ActivityInfo;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;

import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.filters.LargeTest;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.Until;
import androidx.test.espresso.web.webdriver.Locator;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.IOException;
import java.io.InputStream;

@LargeTest
@RunWith(AndroidJUnit4.class)
public final class AndroidShellInteractionTest {
    private static final String GESTURAL_NAVIGATION_OVERLAY =
            "com.android.internal.systemui.navbar.gestural";
    private static final long WEB_WAIT_MILLIS = 10_000L;
    private static final long STATE_WAIT_MILLIS = 5_000L;
    private static final long EXIT_CONFIRMATION_EXPIRY_MILLIS = 2_500L;

    private Instrumentation instrumentation;
    private UiDevice device;

    @Before
    public void prepareDevice() throws IOException {
        instrumentation = InstrumentationRegistry.getInstrumentation();
        device = UiDevice.getInstance(instrumentation);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            executeShellCommand(
                    "cmd overlay enable-exclusive --category " + GESTURAL_NAVIGATION_OVERLAY);
        }
        device.waitForIdle();
    }

    @After
    public void restoreRotation() throws Exception {
        if (device != null) {
            device.unfreezeRotation();
        }
    }

    @Test
    public void embeddedGameSurvivesLifecycleAndBothLandscapeRotations() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            onWebView().forceJavascriptEnabled();
            waitForWebElement(".start-button", "开始游戏");
            onWebView()
                    .withElement(findElement(Locator.CSS_SELECTOR, ".start-button"))
                    .perform(webClick());
            waitForWebElement(".match-screen", "叫地主");

            scenario.moveToState(Lifecycle.State.CREATED);
            assertEquals(Lifecycle.State.CREATED, scenario.getState());
            scenario.moveToState(Lifecycle.State.RESUMED);
            waitForWebElement(".match-screen", "叫地主");

            int initialRotation = device.getDisplayRotation();
            scenario.onActivity(
                    activity ->
                            activity.setRequestedOrientation(
                                    ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE));
            waitForDifferentRotation(initialRotation);
            waitForWebElement(".match-screen", "叫地主");

            int reverseRotation = device.getDisplayRotation();
            scenario.onActivity(
                    activity ->
                            activity.setRequestedOrientation(
                                    ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));
            waitForDifferentRotation(reverseRotation);
            waitForWebElement(".match-screen", "叫地主");

            scenario.recreate();
            waitForWebElement(".match-screen", "叫地主");
        }
    }

    @Test
    public void twoSystemBackActionsExitOnlyInsideConfirmationWindow() throws Exception {
        String confirmationText =
                instrumentation
                        .getTargetContext()
                        .getString(R.string.press_back_again_to_exit);

        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            waitForWebElement(".start-button", "开始游戏");

            long firstBackStartedAt = SystemClock.elapsedRealtime();
            performSystemBack();
            assertTrue(
                    "The first system Back action must show exit guidance.",
                    device.wait(Until.hasObject(By.text(confirmationText)), STATE_WAIT_MILLIS));
            assertEquals(Lifecycle.State.RESUMED, scenario.getState());

            waitUntilAfter(
                    firstBackStartedAt,
                    EXIT_CONFIRMATION_EXPIRY_MILLIS + 250L);
            assertEquals(Lifecycle.State.RESUMED, scenario.getState());
            assertTrue(
                    "Expired exit guidance must leave the accessibility window.",
                    device.wait(Until.gone(By.text(confirmationText)), STATE_WAIT_MILLIS));

            performSystemBack();
            assertTrue(
                    "A new system Back action must start a fresh confirmation window.",
                    device.wait(Until.hasObject(By.text(confirmationText)), STATE_WAIT_MILLIS));
            performSystemBack();
            waitForLifecycleState(scenario, Lifecycle.State.DESTROYED);
        }
    }

    private void performSystemBack() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            assertTrue("UI Automator could not inject Back.", device.pressBack());
            return;
        }

        int height = device.getDisplayHeight();
        int width = device.getDisplayWidth();
        assertTrue(
                "UI Automator could not inject the predictive Back edge gesture.",
                device.swipe(1, height / 2, width / 3, height / 2, 20));
        device.waitForIdle();
    }

    private void waitForWebElement(String selector, String expectedText) {
        long deadline = SystemClock.elapsedRealtime() + WEB_WAIT_MILLIS;
        Throwable lastFailure = null;
        while (SystemClock.elapsedRealtime() < deadline) {
            try {
                onWebView()
                        .withElement(findElement(Locator.CSS_SELECTOR, selector))
                        .check(webMatches(getText(), containsString(expectedText)));
                return;
            } catch (RuntimeException | AssertionError failure) {
                lastFailure = failure;
                SystemClock.sleep(200L);
            }
        }
        throw new AssertionError("Timed out waiting for WebView element " + selector, lastFailure);
    }

    private void waitForDifferentRotation(int previousRotation) {
        long deadline = SystemClock.elapsedRealtime() + STATE_WAIT_MILLIS;
        while (SystemClock.elapsedRealtime() < deadline) {
            if (device.getDisplayRotation() != previousRotation) {
                return;
            }
            SystemClock.sleep(100L);
        }
        assertNotEquals(previousRotation, device.getDisplayRotation());
    }

    private static void waitUntilAfter(long startedAt, long durationMillis) {
        long remaining;
        while ((remaining = startedAt + durationMillis - SystemClock.elapsedRealtime()) > 0L) {
            SystemClock.sleep(Math.min(remaining, 100L));
        }
    }

    private static void waitForLifecycleState(
            ActivityScenario<MainActivity> scenario,
            Lifecycle.State expectedState) {
        long deadline = SystemClock.elapsedRealtime() + STATE_WAIT_MILLIS;
        while (SystemClock.elapsedRealtime() < deadline) {
            if (scenario.getState() == expectedState) {
                return;
            }
            SystemClock.sleep(100L);
        }
        assertEquals(expectedState, scenario.getState());
    }

    private void executeShellCommand(String command) throws IOException {
        ParcelFileDescriptor descriptor =
                instrumentation.getUiAutomation().executeShellCommand(command);
        try (InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(descriptor)) {
            byte[] buffer = new byte[1024];
            while (input.read(buffer) != -1) {
                // Drain the command output so completion is synchronized.
            }
        }
    }
}

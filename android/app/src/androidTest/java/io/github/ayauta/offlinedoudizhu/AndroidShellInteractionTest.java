package io.github.ayauta.offlinedoudizhu;

import static androidx.test.espresso.web.assertion.WebViewAssertions.webMatches;
import static androidx.test.espresso.web.sugar.Web.onWebView;
import static androidx.test.espresso.web.webdriver.DriverAtoms.findElement;
import static androidx.test.espresso.web.webdriver.DriverAtoms.getText;
import static androidx.test.espresso.web.webdriver.DriverAtoms.webClick;
import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.notNullValue;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import android.app.Instrumentation;
import android.content.pm.ActivityInfo;
import android.os.Build;
import android.os.SystemClock;

import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.filters.LargeTest;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.UiDevice;
import androidx.test.espresso.web.webdriver.Locator;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.concurrent.atomic.AtomicBoolean;

@LargeTest
@RunWith(AndroidJUnit4.class)
public final class AndroidShellInteractionTest {
    private static final long WEB_WAIT_MILLIS = 10_000L;
    private static final long STATE_WAIT_MILLIS = 5_000L;
    private static final long EXIT_CONFIRMATION_EXPIRY_MILLIS = 2_500L;

    private UiDevice device;

    @Before
    public void prepareDevice() {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        device = UiDevice.getInstance(instrumentation);
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
            waitForWindowFocus(scenario);
            onWebView().forceJavascriptEnabled();
            waitForWebElement(".start-button", "开始游戏");
            onWebView()
                    .withElement(findElement(Locator.CSS_SELECTOR, ".start-button"))
                    .perform(webClick());
            waitForWebElement(".match-screen");

            scenario.moveToState(Lifecycle.State.CREATED);
            assertEquals(Lifecycle.State.CREATED, scenario.getState());
            scenario.moveToState(Lifecycle.State.RESUMED);
            waitForWindowFocus(scenario);
            waitForWebElement(".match-screen");

            int initialRotation = device.getDisplayRotation();
            scenario.onActivity(
                    activity ->
                            activity.setRequestedOrientation(
                                    ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE));
            waitForDifferentRotation(initialRotation);
            waitForWindowFocus(scenario);
            waitForWebElement(".match-screen");

            int reverseRotation = device.getDisplayRotation();
            scenario.onActivity(
                    activity ->
                            activity.setRequestedOrientation(
                                    ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));
            waitForDifferentRotation(reverseRotation);
            waitForWindowFocus(scenario);
            waitForWebElement(".match-screen");

            scenario.recreate();
            waitForWindowFocus(scenario);
            waitForWebElement(".match-screen");
        }
    }

    @Test
    public void twoSystemBackActionsExitOnlyInsideConfirmationWindow() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            waitForWindowFocus(scenario);
            waitForWebElement(".start-button", "开始游戏");

            long firstBackStartedAt = SystemClock.elapsedRealtime();
            performSystemBack();
            waitForExitConfirmationState(scenario, true);
            assertEquals(Lifecycle.State.RESUMED, scenario.getState());

            waitUntilAfter(
                    firstBackStartedAt,
                    EXIT_CONFIRMATION_EXPIRY_MILLIS + 250L);
            waitForExitConfirmationState(scenario, false);
            assertEquals(Lifecycle.State.RESUMED, scenario.getState());

            performSystemBack();
            waitForExitConfirmationState(scenario, true);
            performSystemBack();
            waitForLifecycleState(scenario, Lifecycle.State.DESTROYED);
        }
    }

    private static void waitForWindowFocus(ActivityScenario<MainActivity> scenario) {
        long deadline = SystemClock.elapsedRealtime() + STATE_WAIT_MILLIS;
        AtomicBoolean hasFocus = new AtomicBoolean(false);
        while (SystemClock.elapsedRealtime() < deadline) {
            scenario.onActivity(
                    activity ->
                            hasFocus.set(
                                    activity.getWindow().getDecorView().hasWindowFocus()));
            if (hasFocus.get()) {
                return;
            }
            SystemClock.sleep(100L);
        }
        assertTrue("The activity window never received focus.", hasFocus.get());
    }

    private static void waitForExitConfirmationState(
            ActivityScenario<MainActivity> scenario, boolean expectedState) {
        long deadline = SystemClock.elapsedRealtime() + STATE_WAIT_MILLIS;
        AtomicBoolean actualState = new AtomicBoolean(!expectedState);
        while (SystemClock.elapsedRealtime() < deadline) {
            scenario.onActivity(
                    activity -> actualState.set(activity.hasActiveExitConfirmation()));
            if (actualState.get() == expectedState) {
                return;
            }
            SystemClock.sleep(100L);
        }
        assertEquals(expectedState, actualState.get());
    }

    private void performSystemBack() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            device.pressBack();
            device.waitForIdle();
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

    private void waitForWebElement(String selector) {
        long deadline = SystemClock.elapsedRealtime() + WEB_WAIT_MILLIS;
        Throwable lastFailure = null;
        while (SystemClock.elapsedRealtime() < deadline) {
            try {
                onWebView()
                        .withElement(findElement(Locator.CSS_SELECTOR, selector))
                        .check(webMatches(getText(), notNullValue(String.class)));
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
}

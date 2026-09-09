# Spec 044 Xiaomi 10S Android Quick Check

Status: Closed as non-blocking device evidence under ADR 0012

Date: 2026-09-06

No device identifier, account, notification, or other personal data is recorded.

## Environment

- Device model: Xiaomi 10S
- Android: 13 (API 33)
- System WebView: `com.google.android.webview` 116.0.5845.92
- Physical display: 1080 × 2340; application observed at 2340 × 1080 landscape
- System font scale: 1.0
- Window and transition animation scales: 1.0
- APK: debug build, application ID `io.github.ayauta.offlinedoudizhu.debug`

## Automated and visual checks

- [x] APK installed successfully through Google Platform Tools 37.0.1.
- [x] An initial launch crash was reproduced and isolated to fullscreen setup
      running before Android had created the window decor view.
- [x] A regression test was added; fullscreen setup now runs after
      `setContentView`, and the rebuilt APK was installed.
- [x] Five post-fix force-stop/cold-start runs completed successfully. Reported
      activity start time ranged from 432 ms to 606 ms.
- [x] The Activity remained the visible, top-resumed fullscreen Activity after
      launch, with no isolated Android Runtime or Chromium crash entry.
- [x] A captured full-screen frame showed the complete landscape home screen.
- [x] One injected tap on `开始游戏` opened the bidding table; a captured frame
      showed both opponents, bottom cards, bidding actions, and all 17 human
      cards without clipping.
- [x] WebView debug metadata reported the packaged
      `https://appassets.androidplatform.net/assets/embedded.html` URL and no
      service-worker target.
- [x] APK inspection reported zero requested permissions and a valid debug v2
      signature.

## Owner-operated quick check

- [x] General gameplay and presentation were reported as basically normal.
- [x] Pre-fix system Back behavior exposed an older settlement from the home
      screen and exited immediately from an active match; this is recorded as a
      failed interaction check rather than accepted behavior.
- [x] The rebuilt APK retained the home and active-match screens after one
      injected system Back invocation, then returned to the MIUI launcher after
      two consecutive invocations.
- [x] Reopening after the active-match exit showed a clean game home screen,
      not the discarded match or an older settlement.
- [ ] The owner confirms that `再按一次退出游戏` is visibly readable after the
      first system Back invocation and that the same behavior holds on the
      settlement screen.
- [ ] Rapid continuous card selection for roughly 30 seconds has no missed or
      delayed input, unintended scrolling, or visible stutter.
- [ ] One representative bidding/play flow completes normally.
- [ ] Three background/resume cycles preserve the current session.
- [ ] Rotation between both landscape directions preserves the current session
      and layout.
- [ ] No unexpected reload, external page, permission prompt, or uncomfortable
      heat is observed.
- [x] Offline-first launch was repeated with Wi-Fi and mobile data disabled.

## Closure note

On 2026-09-06 the owner reported extended play with no material problem and
then separately confirmed a cold launch with Wi-Fi and mobile data disabled.
The unchecked granular observations above were not individually recorded and
remain unchecked; they are not retroactively claimed as passed. ADR 0012 and
Spec 045 make repeatable CI plus Android-emulator acceptance authoritative for
public releases, while this record remains useful optional physical evidence.

This record is closed as optional physical evidence; the unchecked observations
remain available for a future comfort review but do not block an automated
public release.

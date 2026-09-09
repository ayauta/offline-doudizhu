# Spec 043 Physical-Phone Checklist

Status: Optional non-blocking device evidence under ADR 0012

Prepared: 2026-09-04

This checklist hands Spec 040 to later physical-device acceptance. It does not
claim that either phone has passed. Record the exact OS, Chrome/System WebView
version, display/text scaling, reduced-motion setting, and observed landscape
CSS viewport before each run.

## Device matrix

| Device | Environment recorded | Full run | Evidence | Result |
| --- | --- | --- | --- | --- |
| Redmi K60E | Pending | Pending | Pending | Not tested |
| Redmi K70 Pro | Pending | Pending | Pending | Not tested |

## Per-device run

- [ ] Load the reviewed production build once, then enable airplane mode and
      relaunch it from the installed PWA entry.
- [ ] Install the exact candidate Android APK, keep airplane mode enabled, and
      confirm it cold-starts directly to the embedded home screen. Press system
      Back once and confirm `再按一次退出游戏` appears without leaving; wait
      more than two seconds and confirm another single Back still does not exit.
      Then press Back twice within two seconds, confirm the task exits, and
      relaunch it. Record whether navigation buttons or gestures were used.
- [ ] Confirm portrait shows only `请旋转手机`; rotate back during an AI beat
      and verify the exact deal, selection, turn, and pending action resume.
- [ ] Check both landscape orientations for cutout/safe-area clearance, no page
      scrolling, no clipped count, message, action, or 20-card hand.
- [ ] Tap exposed strips at both ends and the middle of a 20-card hand; then
      select and deselect at least eight cards with one deliberately fast
      continuous swipe. Reverse direction in the same gesture, leave the hand
      vertically, and re-enter over a different card. Confirm every crossed
      card changes once, the outside segment changes none, and prior changes
      remain. Record misses, unintended scrolling/dragging, and visible response
      latency.
- [ ] Select five cards with one swipe, then hold a second swipe while
      deselecting the same five. Confirm the origin card settles with the other
      four and does not perform another visible rebound on release.
- [ ] Observe the hand at 17, 20, and—during a late game—two cards. Confirm card
      size remains stable, 17 and two cards form naturally centered compact
      groups, 20 compresses without clipping, and two cards never separate
      across the table.
- [ ] After an accepted play, confirm remaining cards regroup horizontally in
      one restrained beat with no jump or vertical wobble. Repeat with reduced
      motion and confirm regrouping is immediate.
- [ ] Verify every exposed rank/suit, complete `10`, and both upright stacked
      `JOKER` indices are legible at the owner's normal viewing distance in the
      20-card hand, selected hand, bottom cards, and public plays. Confirm faces
      have no center mark or visible Chinese joker text. Also check selected and
      disabled states, role, current seat, and the `剩2张`/`剩1张` warning.
- [ ] Confirm each opponent's large remaining count reads as part of its
      fanned card-back stack, the role below remains easy to read, and neither
      status anchor looks or responds like a button. Confirm `上家`/`下家` is
      unnecessary at both landscape orientations.
- [ ] Compare the status anchors with the real action buttons: only controls
      should appear elevated and respond to touch, while the current-seat halo
      remains soft, borderless, and understandable without color alone.
- [ ] Complete an offline round through bidding, a valid response, an invalid
      selection, `没有可以压过的牌`, a special-pattern label, exit cancel, and
      result/rematch. Confirm the final public play remains unobscured and the
      result title, winning side, last play, and actions read as one comfortable
      vertical sequence. Compare victory and failure: layout, type, and motion
      must match, with only wording different.
- [ ] Play a long straight and, if practical, a 20-card airplane with pair
      wings. Confirm every public rank and suit remains readable, wrapping is
      orderly, the pattern label remains visible, and neither result action
      covers the final group at either landscape orientation.
- [ ] On a failed round with cards remaining in the human hand, tap the center
      and lower portion of both `返回首页` and `再来一局` in separate runs. Confirm
      the faded hand never intercepts either result action in either landscape
      orientation.
- [ ] Repeat the essential flow with reduced motion and increased system text
      scale; record any overlap or missing information rather than relaxing the
      automated baseline.
- [ ] Run five cold starts, roughly 30 seconds of rapid continuous selection,
      one representative round flow, and three background/rotation cycles.
      Note visible stutter, delayed taps, unexpected reloads, battery drain, and
      uncomfortable heat. Extend to a 15-minute continuous diagnostic only when
      the quick run exposes a performance, reload, battery, or heat concern.

For every failure, attach a screenshot or short screen recording, the exact
step, device/environment fields, and a reproducible issue. Keep device
identifiers, accounts, notifications, and other personal data out of evidence.

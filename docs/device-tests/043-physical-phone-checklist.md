# Spec 043 Physical-Phone Checklist

Status: Prepared; not yet executed

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
- [ ] Confirm portrait shows only `请旋转手机`; rotate back during an AI beat
      and verify the exact deal, selection, turn, and pending action resume.
- [ ] Check both landscape orientations for cutout/safe-area clearance, no page
      scrolling, no clipped count, message, action, or 20-card hand.
- [ ] Tap exposed strips at both ends and the middle of a 20-card hand; then
      select and deselect at least four cards with one continuous swipe. Record
      misses, unintended scrolling/dragging, and visible response latency.
- [ ] Verify every exposed rank/suit, both jokers, bottom cards, selected state,
      disabled state, role, current seat, and `剩2张`/`剩1张` warning are legible
      at the owner's normal viewing distance.
- [ ] Complete an offline round through bidding, a valid response, an invalid
      selection, `没有可以压过的牌`, a special-pattern label, exit cancel, and
      result/rematch. Confirm the final public play remains unobscured.
- [ ] Repeat the essential flow with reduced motion and increased system text
      scale; record any overlap or missing information rather than relaxing the
      automated baseline.
- [ ] Play continuously for at least 15 minutes and note visible stutter,
      delayed taps, unexpected reloads, battery drain, and uncomfortable heat.

For every failure, attach a screenshot or short screen recording, the exact
step, device/environment fields, and a reproducible issue. Keep device
identifiers, accounts, notifications, and other personal data out of evidence.

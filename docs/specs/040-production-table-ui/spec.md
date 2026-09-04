# Spec 040: Production Table UI

Status: Approved; visual refinement approved for implementation

Date: 2026-09-04

## Goal

Replace the architecture-validation debug table with the first complete,
production-quality match experience for one human and two local AI players.
From a quiet home screen, the player can start, bid, play a whole legal round,
understand necessary errors, see the result, and either play again or return
home without encountering debug language or unfinished controls.

The experience is designed for the product owner's parents: familiar enough to
operate from existing Dou Dizhu knowledge, unusually calm and legible, and
carefully responsive to touch. Its Apple-influenced qualities are hierarchy,
direct manipulation, precision, restraint, and humane timing. Materials follow
their meaning: physical cards feel opaque and tactile, static status stays
quiet, and interactive controls alone receive elevated response cues. The
design does not copy an Apple product or apply glass indiscriminately.

## Product and architecture boundary

Spec 040 connects the accepted Specs 010, 012, 013, 020, 021, 022, 030, and
031 through one authoritative application session. It does not change any
game rule, AI heuristic, or core transition contract.

The production session:

- owns the current full `GameState`, transient presentation state, human card
  selection, hint-cycle position, and any queued AI presentation step;
- accepts typed UI intents and submits ordinary commands through `transition`;
- runs both AI seats only through `runAiTurn` with `CASUAL_AI_STRATEGY`;
- receives shuffled decks and presentation scheduling through injected seams so
  deterministic tests do not use ambient randomness or wall-clock time;
- exposes a frozen read-only view and change subscription to Preact; and
- cancels obsolete scheduled work when a game is abandoned, restarted, or the
  session is disposed.

The UI view may expose the human hand, revealed bottom cards, public actions,
roles, remaining-card counts, and result. It must never expose either AI hand
or unrevealed bottom-card identities in props, DOM attributes, accessible text,
or test hooks. Preact owns only rendering and short-lived pointer/visual state;
it never mutates game state directly.

The production deck source uses a Web-platform random adapter at the composition
root and supplies a complete already-shuffled deck to the core. Unit and browser
fixtures inject deterministic deck sources. No dependency, server, request API,
remote asset, account, analytics, telemetry, or persistence is added.

## Experience principles

In descending priority:

1. The current game state and available action are immediately legible.
2. A familiar player can act directly without tutorials or routine prompts.
3. Touch feedback is immediate even when AI presentation is deliberately paced.
4. Hierarchy comes from position, spacing, contrast, type, and material—not
   ornament, badges, or a dense status bar.
5. Motion confirms causality and gives important plays weight; it never delays
   understanding or tries to manufacture excitement.
6. Every state remains understandable with motion reduced or absent.

The default is silence. The UI does not say `轮到你`, narrate AI thinking,
explain valid selections, announce the landlord in a redundant center banner,
or permanently display instructions. Text appears only when its absence would
materially harm play: an invalid selection, no legal response, all-pass redeal,
destructive exit confirmation, low-card warning, special public pattern, or
final result.

## Screen and match flow

### Home

The home screen contains only:

- the title `单机斗地主`;
- one quiet line, `一人 · 两位本地 AI · 完全离线`;
- an original static three-card-back composition; and
- one centered primary button, `开始游戏`.

There is no account, avatar, nickname, score, currency, activity, difficulty,
settings, rules, continue card, or promotional carousel. Rules and settings
arrive in Specs 041 and 042.

On start, the three hero card backs continue into the match as the actual
top-center bottom cards. The table and opponent seats appear, while the
player's 17-card hand opens from one compact group. The transition completes in
at most about 600 ms. It does not animate 51 individual cards.

### Bidding

The human always bids first with equal-width controls:

```text
[ 不叫 ] [ 叫地主 ]
```

`叫地主` is the right-hand primary action. Each seat's accepted `叫地主` or
`不叫` remains visible in that seat's local action zone until bidding ends.
During AI turns, no substitute buttons, spinner, countdown, or `思考中` text
appear.

When a seat calls:

1. bidding actions leave together;
2. the three bottom cards reveal in a short, ordered transition of about
   450 ms;
3. all three typographic role labels update to `地主` or `农民`;
4. the active landlord seat receives the ordinary turn emphasis; and
5. if the human is landlord, the three cards enter the fixed hand sort and are
   briefly emphasized in place.

There is no central `地主已确定`, crown, hat, wheat, gold treatment, particle,
or role character. If all seats decline, `都不叫，重新发牌` appears briefly;
the whole deal is then replaced automatically with a fresh shuffled deck.

### Playing

The landlord leads. Human controls depend only on the legal context:

| Context | Visible controls |
| --- | --- |
| Human leads | `[ 提示 ] [ 出牌 ]` |
| Human responds and has a playable response | `[ 不出 ] [ 提示 ] [ 出牌 ]` |
| Human cannot beat the current play | centered `[ 不出 ]` only |

When no response exists, the action area also says `没有可以压过的牌`. The game
does not auto-pass: the player confirms `不出`, retaining control and avoiding
an unexplained state change.

All cards in the current trick remain in their owner's local play zone. A
higher response does not remove earlier cards. A seat's new play replaces that
seat's prior local action if one exists. `不出` remains visible like a played
action. After two consecutive passes, all current-trick actions remain for
about 400 ms, then clear together before the last player begins the new trick.
No older discard pile, scrolling log, turn transcript, or replay control is
shown.

### Result

The final play first lands normally and remains in its original seat zone with
its applicable pattern label. After about 500–650 ms, the table becomes a
result state without placing an opaque settlement panel over the last play:

- other table content gently recedes in contrast;
- the final public play remains at full contrast and is not moved or cleared;
- opponents' remaining hidden cards are not revealed;
- the guaranteed empty center shows the large title `胜利` or `失败`;
- the subline says `地主获胜` or `农民获胜`; and
- the normal action area becomes `[ 返回首页 ] [ 再来一局 ]`.

The result buttons are equal in geometry; `再来一局` on the right is primary.
It performs the accepted core restart and begins a newly shuffled deal.
`返回首页` clears the match and its transient presentation state. There are no
coins, points, multiplier, statistics, awards, revealed losing hands, confetti,
or engagement prompts.

Victory and failure use the same quiet composition, type roles, spacing, and
motion; wording is the only difference. The title uses the system's standard
bold rather than an arbitrary extra-heavy weight, natural Chinese spacing, and
comfortable leading, and
sits on one continuous vertical rhythm with the subline, retained final play,
and actions. It arrives with only a 220 ms opacity and 4-pixel settle—no scale,
glow, bounce, or color-coded success/failure treatment.

## Table layout and information hierarchy

The game is landscape-only. The human sits at the bottom, `ai-one` at the
right, and `ai-two` at the left, matching the core order
`human -> ai-one -> ai-two -> human`. Each opponent is represented by a compact
two- or three-layer card-back stack, a large tabular remaining count, and—after
assignment—the typographic role `地主` or `农民`. There is no person-like
avatar, Q-style character, name, or permanent `电脑` label.

The match top bar contains:

- low-priority `返回` at the left;
- the three bottom cards fixed at the true horizontal center; and
- an empty balancing region at the right, reserved for Spec 041's future help
  entry but containing no disabled or placeholder control in Spec 040.

It does not contain the game title, offline badge, clock, turn text, score, or
multiplier. Before landlord assignment, bottom cards show only their backs.
After assignment, their faces remain visible for the rest of the match.

Each opponent uses one borderless status anchor. A slightly fanned physical
card-back stack explains the large tabular numeral optically centered on its
front card; the role sits directly below as secondary text. The group is not a
button: it has no generic rounded container, glass fill, enclosing border,
control shadow, pointer cursor, focus target, hover response, or press response.
The positional relationship already identifies the left and right seats, so no
visible `上家` or `下家` label is added. Its accessible name still states the
side, remaining count, and assigned role.

The current seat is indicated by one soft, diffuse tonal emphasis behind the
whole status anchor and by the spatial origin of its action. The emphasis does
not create a boundary or lift the anchor into the control layer. The UI does
not add an arrow, bouncing marker, glowing ring, or duplicate turn sentence.

The human hand is always one upright row. Card size stays stable as cards leave
the hand: the group—not each card—becomes narrower and remains centered. From
one through 17 cards, adjacent origins target about 68–72% of card width, which
keeps two remaining cards visibly related instead of stretching them across
the table. At 18–20 cards the step compresses only when the safe viewport or
desktop stage requires it. The hand never scrolls horizontally or wraps into
two rows. Every exposed rank and suit remains readable.

The entire exposed vertical strip participates in that card's hit region. A
small vertical corridor around the visual hand makes continuous selection
forgiving without turning the whole table into a hit target. Leaving the
corridor pauses hit detection while retaining already selected cards; re-entry
continues the same gesture and pointer-up commits it.

At desktop trial widths, the match uses an invisible centered table stage of
about 1180 CSS pixels rather than stretching meaningful content to the browser
edges. The hand is centered within a maximum span of about 1040 pixels; cards
are about 78–86 pixels wide and intentionally overlap at both 17 and 20 cards.
Opponent anchors move inward with the same stage. At phone landscape widths the
stage becomes fluid, and the hand continues to use the available safe width.
The breakpoint changes density, not state, order, or interaction.

The fixed hand order is descending strength:

```text
大王, 小王, 2, A, K, Q, J, 10 ... 3
```

Suits use one stable documented order inside a rank. The player cannot drag or
manually reorder cards.

## Card and material design

The table is a clean, untextured deep emerald field. A very low-contrast tonal
falloff may establish depth across large desktop areas, but it must not resemble
felt, wood, a casino spotlight, or a glossy game lobby. Cards use warm ivory
faces with a subtle paper-tonal transition, restrained layered graphite
shadows, graphite suits, and a deep vermilion for hearts, diamonds, and the
most important destructive text. Card backs use low-saturation deep ink blue
with one warm-ivory inner line and an original three-arc motif. There is no gold
palette.

Physical cards and status content remain opaque and quiet. Restrained
translucency may distinguish an actual control or clarify temporary depth, such
as the exit confirmation scrim, only when contrast survives. Frosted cards,
glass status anchors, stacked blur layers, reflective highlights, neon glows,
and decorative gradients are excluded.

Standard cards have familiar paper proportions, a large corner rank and suit,
and one subtle central suit mark. J, Q, and K remain typographic instead of
using illustrated court figures. Hearts/diamonds use one project-owned deep
vermilion, clubs/spades one graphite. Suit shapes are consistent project-owned
inline SVG geometry rather than operating-system emoji or font-dependent glyphs.

Both jokers combine familiar international and Chinese cues:

- a vertical central `JOKER` word;
- a large corner `大` or `小` with the smaller `王` beneath it;
- deep vermilion for the big joker and graphite for the small joker; and
- accessible names `大王` and `小王`.

They do not use a clown, crown, portrait, or decorative character illustration.

Typography uses the local system stack only, including ranks, J/Q/K, and joker
text. Five consistent roles govern the screen: large result/home titles, key
tabular numerals, action labels, transient feedback, and secondary role/meta
labels. Hierarchy comes primarily from size, standard system weights, line
height, color, and proximity; Chinese copy does not use arbitrary aggressive
positive or negative tracking. Primary game information uses medium,
semibold, or bold weights rather than thin text, while secondary labels remain
comfortably readable instead of becoming decorative low-contrast gray.
Opponent counts target about 24–28 pixels on phone landscape and 28–32 pixels
on desktop. Important normal text meets at least 4.5:1 contrast; large text and
meaningful control boundaries meet at least 3:1.

## Direct selection, validation, and hints

Cards are semantic buttons. Pointer down gives immediate pressed feedback. A
tap commits selection on pointer up. After the existing movement threshold is
crossed, the gesture becomes continuous selection: the first card's initial
state fixes select versus deselect, each visited card changes at most once, and
the active pointer retains capture. Reversing direction does not toggle a card
a second time. The UI consumes coalesced pointer samples when available and
also intersects every segment between delivered samples with card hit regions,
so a fast movement cannot probabilistically skip intermediate cards merely
because the browser reduced `pointermove` frequency. A second touch is ignored
while one gesture is active. The gesture never starts native drag, reorders
cards, scrolls the hand, or submits a play.

Selected cards lift 10–12 pixels once and use a clear border/contrast change,
so selection does not depend on color. The transition is a quiet 100 ms
ease-out; there is no checkmark, bounce, scale, pulse, or persistent glow.
Selection feedback begins within one frame and the accepted interaction
response is visible within 80 ms of touch release on target phones. With
reduced motion, the lift is removed and static border/contrast carries the
same state.

After each completed selection gesture, the session validates the complete
selection with the accepted rules seam:

- no selection: `出牌` remains disabled and no error text appears;
- unsupported shape or count: `这些牌不能这样出`;
- a valid pattern that cannot beat the table: `这手牌压不过桌上的牌`;
- a stale ownership or other unexpected engine rejection:
  `这手牌暂时不能出，请重新选择`.

The concise message appears next to the human action area, uses a polite live
announcement, and disappears as soon as the selection changes or the context
is resolved. `出牌` remains present but disabled whenever selection is not a
legal current action; disabling is conveyed by contrast and semantics, not
movement.

`提示` consumes `rankCasualPlayActions` and never reimplements hand strategy.
It selects the highest-ranked playable action but does not submit it. Repeated
taps cycle deterministically through every playable candidate and then wrap.
A manual card-selection gesture, accepted play/pass, trick change, or new round
resets the cycle. If no playable response exists, `提示` and `出牌` are absent
and only the centered `不出` control remains.

## Public pattern feedback

Routine single, pair, triple, triple-with-single, and triple-with-pair plays use
only the common card landing and no text label. The following patterns add a
short label next to the current leading play:

| Engine pattern | Visible label |
| --- | --- |
| `straight` | `顺子` |
| `consecutive-pairs` | `连对` |
| any airplane variant | `飞机` |
| either four-with-two variant | `四带二` |
| `bomb` | `炸弹` |
| `rocket` | `王炸` |

Only the current leading play displays a pattern label. When that play is
beaten, its cards remain until the trick ends but its label leaves; the new
leading play receives the applicable label. Pass labels remain. The winning
play's label remains through the result state.

The label uses plain warm-ivory system text with no exclamation mark, praise,
ribbon, badge, icon, or light streak. It arrives with a very small opacity and
up-to-4-pixel movement. It is feedback and rhythm, not a tutorial.

## Buttons, exit, and destructive actions

All gameplay action buttons share one height, corner radius, type scale, and
width within a group. Geometry follows one rule:

- one action is centered;
- two actions are equal-width and symmetric;
- three actions are equal-width and centered.

For left-to-right Chinese UI, the auxiliary/cancel action is on the left and
the normal commit/default action is on the right. The right action may use the
solid warm-ivory primary style. Secondary controls use a quiet tonal or fine
border treatment. Press feedback lasts about 80 ms with no bounce or glow.

`返回` during an active round opens a semantic custom confirmation with:

```text
[ 继续游戏 ] [ 结束本局 ]
```

The buttons are equal and symmetric. `结束本局` is on the right because it is
the commit action, but it uses restrained destructive vermilion text/fine
outline rather than the primary fill. `继续游戏` safely dismisses the
confirmation. No game state advances while it is open. The confirmation is the
only routine overlay allowed to obscure the table.

## Motion and temporal behavior

Animation uses shared tokens and transform/opacity wherever practical. There
are two card-play weights, not bespoke choreography for every hand type:

1. normal and grouped patterns share a whole-group 180–220 ms settle;
2. bombs and the rocket use the same settle plus a restrained 98%-to-100%
   weight response and briefly deeper local card shadow. Their label is one
   type step stronger; the rocket may be at most about 40 ms stronger than a
   bomb.

There is no per-card straight cascade, per-pair sequence, airplane body/wing
split, literal plane/bomb/rocket image, particle, screen shake, whole-table
dimming flash, or camera movement.

AI evaluation starts immediately when an AI turn becomes eligible. Its command
is held privately and presented after the preceding state has settled, normally
about 450–600 ms. Consecutive AI actions remain separate readable beats; a pass
also occupies one beat. Human controls appear only after the last AI action has
settled. The UI never adds random delay, spinner, fake thought process, or
countdown.

When an opponent reaches two or one cards, the numeral remains dominant on the
card stack and receives one brief tonal settle; the card-stack context and
polite accessible announcement supply the remaining-card meaning. It then
remains static and high-contrast. It does not flash, bounce, speak, or repeatedly
animate.

After an accepted human play reduces the hand, remaining cards regroup over
180 ms using horizontal transform only and the shared smooth ease-in-out curve
`cubic-bezier(0.77, 0, 0.175, 1)`. This motion exists solely to preserve spatial
continuity between old and new card positions. It does not run for selection,
hints, or other renders, does not move vertically, and becomes an immediate
layout update under reduced motion.

When the operating system/browser requests reduced motion, the app keeps the
same states, order, labels, and reading intervals but removes nonessential
movement: selection uses static contrast/border, card and bottom-card changes
crossfade or update directly, and the portrait symbol is static. Reduced motion
never removes information or causes AI actions to collapse into an unreadable
instant.

There is no vibration or haptic call. Spec 050 may later add a coherent family
of short local paper/table sounds, including restrained bomb/rocket sounds, but
Spec 040 contains no audio code, asset, toggle, or placeholder.

## Orientation, responsive layout, and lifecycle

Landscape view fits without page or hand scrolling at these automated baseline
viewports:

- 800 × 360;
- 900 × 400; and
- 640 × 340.

Desktop trial acceptance also covers 1366 × 768 and 1440 × 900. At those
viewports the hand is centered, cards overlap instead of separating, card width
stays within the desktop target range, and opponent anchors remain tied to the
centered stage rather than the outer window edges.

Layout includes all four safe-area insets and must also be reviewed against the
landscape CSS viewport reported by the Redmi K60E and Redmi K70 Pro. At the
narrowest baseline, all 20 human cards, exposed ranks/suits, local public plays,
remaining counts, messages, and currently available controls stay inside the
viewport without overlap that changes meaning.

Portrait hides and deactivates the entire home or match surface and shows only
`请旋转手机` with the shorter supporting line `横屏后即可继续`. A restrained
device outline may tilt once per application run, then remains static. With
reduced motion it is static from the start. Rotating back resumes the exact
in-memory match, selection, and presentation step; it never redeals, restarts,
or consumes an AI turn solely because orientation changed.

Reload recovery is not claimed. Until Spec 042, a browser reload begins at the
home screen and does not expose a misleading `继续游戏` entry.

## Accessibility and semantic behavior

- Important controls use Chinese text and a minimum 48 × 48 CSS-pixel hit area;
  primary gameplay actions target a larger 56-pixel height where the viewport
  permits.
- Cards, actions, exit confirmation, status, and result use native semantic
  elements and concise accessible names.
- Selection exposes `aria-pressed`; hidden cards are described as backs, not by
  hidden identities.
- Necessary error, redeal, low-card, and result messages are announced politely;
  routine turn and animation changes do not flood a live region.
- Selected state, disabled state, role, turn, and destructive intent never rely
  on color alone.
- Browser zoom and the system text scale remain usable; Spec 040 adds no custom
  font-size setting.
- Per ADR 0010 there is no dedicated keyboard model, shortcut, focus navigation,
  keyboard instruction, or complete-keyboard-match acceptance. Native behavior
  of semantic controls is not blocked.

## Acceptance and test plan

### Deterministic application tests

Tests drive the public session with fixed deck sources and a controllable
presentation scheduler. They prove:

- start/deal, human call, human decline plus either AI caller, and all-pass
  automatic redeal;
- full games in human-landlord and human-farmer roles, including consecutive AI
  turns and termination;
- no AI command is exposed before its presentation beat and stale scheduled
  work cannot affect an abandoned/restarted/disposed game;
- human selection validation, legal submission, pass restrictions, hint order,
  wraparound, and reset conditions;
- current-trick action retention/replacement, current-label ownership, delayed
  two-pass clearing, and winning-play retention;
- low-card one-time emphasis and exact result/exit/restart/home behavior;
- view freezing and the absence of AI hands/unrevealed bottom IDs; and
- deterministic output, listener cleanup, and input non-mutation.

### Chromium acceptance

Playwright exercises the production app rather than the debug screen:

- home-to-bidding and both bid buttons;
- a complete match driven by `提示` plus `出牌`/`不出` until `胜利` or `失败`;
- tap and continuous select/deselect without hand reordering;
- a one-step fast swipe that crosses several cards without skipping any,
  including corridor exit/re-entry and direction reversal semantics;
- invalid-selection feedback and the cannot-beat single-button state;
- bidding-action retention, bottom-card reveal, role/count changes, current-trick
  retention/clear, a special-pattern label, and unobscured final play;
- exit cancellation and destructive return-home confirmation;
- rematch with a fresh deal;
- reduced-motion behavior;
- portrait-only rotate gate and exact landscape resume;
- no overflow at 800×360, 900×400, and 640×340; and
- naturally compact centered 1-, 2-, and 17-card hands, viewport-compressed
  18- and 20-card hands, post-play spatial regrouping, and inward opponent
  anchors at 1366×768 and 1440×900;
- noninteractive opponent status semantics and the absence of button-like
  enclosing material; and
- installed-build offline relaunch to the home screen.

Browser review records screenshots for home, bidding, human landlord, human
farmer, narrow 20-card hand, 1366- and 1440-pixel desktop tables, normal
response, cannot-beat, bomb/rocket feedback, exit confirmation, victory,
failure, and portrait. Review checks hierarchy, contrast, clipping, card
readability, opponent-status affordance, button symmetry, final-play visibility,
and absence of unintended motion or debug copy.

### Quality and device handoff

Acceptance requires the complete project-local quality gate with Node 24.20.0
and pnpm 11.24.0. Self-review covers state authority, AI redaction, timer
cancellation, reduced motion, privacy, boundaries, bundle/output changes, and
all player-facing strings.

Spec 040 also produces a short physical-phone checklist for Redmi K60E and
Redmi K70 Pro covering one-handed taps, swipe selection across 20 cards, corner
legibility, safe areas/cutouts, heat, smoothness, orientation resume, and a
complete offline round. Recorded physical-device acceptance and resulting
tuning belong to Spec 043; they are not silently claimed from desktop emulation.

## Research and design provenance

The design is project-owned. Reference material informed principles and
comparison only; no external artwork, audio, code, or proprietary layout is
copied.

- [Apple Human Interface Guidelines: Motion](https://developer.apple.com/design/human-interface-guidelines/motion)
  and [Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback)
  support purposeful, interruptible feedback instead of decorative motion.
- [Apple Human Interface Guidelines: Typography](https://developer.apple.com/design/human-interface-guidelines/typography)
  and [Layout](https://developer.apple.com/design/human-interface-guidelines/layout)
  support system type, readable standard weights, alignment, proximity, and
  consistent spacing as the primary hierarchy tools.
- [Apple Human Interface Guidelines: Gestures](https://developer.apple.com/design/human-interface-guidelines/gestures/)
  and [Game controls](https://developer.apple.com/design/human-interface-guidelines/game-controls)
  support responsive direct manipulation, comfortable hit regions, and clear
  feedback throughout a gesture.
- [W3C Pointer Events Level 3](https://www.w3.org/TR/pointerevents3/) documents
  browser coalescing of pointer movement; coalesced samples plus geometric
  segment recovery make the intended card path deterministic.
- [Apple Human Interface Guidelines: Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons)
  and [Alerts](https://developer.apple.com/design/human-interface-guidelines/alerts)
  inform coherent groups and restrained destructive confirmation.
- [Apple Human Interface Guidelines: Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
  informs the separation of quiet content/status from elevated interactive
  controls instead of applying glass to both.
- Nielsen Norman Group guidance on [recognizable clickable elements](https://www.nngroup.com/articles/clickable-elements/)
  and the [similarity principle](https://www.nngroup.com/articles/gestalt-similarity/)
  informs removal of the generic rounded status container and notification-like
  count badge.
- Public 欢乐斗地主 and JJ斗地主 play/result captures were used to compare
  centered compact hands, stable card scale, spatial action persistence, and
  the visibility of the last play; this spec retains only the broadly familiar
  table grammar.
- [JJ斗地主's public App Store notes](https://apps.apple.com/cn/app/jj%E6%96%97%E5%9C%B0%E4%B8%BB-%E4%B8%93%E4%B8%9A%E6%A3%8B%E7%89%8C%E5%90%88%E9%9B%86/id472885640)
  show that sequence, airplane, and bomb feedback are expected game moments;
  this product deliberately reduces them to labels and two motion weights.
- A large [game-feel study](https://www.sciencedirect.com/science/article/pii/S1875952118300879)
  supports a moderate feedback level rather than no feedback or maximal juice.
- An [older-adult interface review](https://pmc.ncbi.nlm.nih.gov/articles/PMC10557006/)
  informs large targets, contrast, and restrained cognitive load.

## Rollout and recovery

Implementation replaces the temporary debug application, tests, and styles in
reviewable vertical slices. The accepted pure core, AI strategies, Web/PWA
delivery, and offline boundary remain intact. All source changes are ordinary
version-controlled text; generated `dist`, screenshots used only for review,
browser binaries, device data, and private configuration are not committed.

If the production UI cannot meet the narrow landscape or interaction acceptance
criteria, revert the Spec 040 implementation as a unit while retaining this
approved spec and the prior engine commits. Do not weaken core rules, AI
redaction, privacy checks, or orientation constraints to make the UI pass.

## Non-goals

No rules viewer, resume/recovery, settings, audio, vibration, difficulty choice,
score, coin, multiplier, task, reward, statistics, history viewer, replay,
opponent-hand reveal, avatar, nickname, skin, custom font, remote asset, complete
keyboard play, Android wrapper, or new dependency is included. These exclusions
are not placeholders in the UI.

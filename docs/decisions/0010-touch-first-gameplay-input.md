# ADR 0010: Touch-First Gameplay Input

Status: Accepted
Date: 2026-09-04

## Context

ADR 0008 and the completed Spec 004 migration slice treated keyboard activation
as a complete alternative to pointer input. That was useful while validating a
general-purpose semantic Web interface, but it was not reconfirmed for the
actual product.

The intended release experience is a landscape game used directly on Android
phones. The Web build also supports normal browser use, while desktop browsers
remain development and trial targets. Designing and accepting a complete
keyboard model would add focus movement, hand navigation, selection, bidding,
play, pass, dialog, and recovery contracts that the target family does not need.
It would also complicate a touch interaction model whose quality is central to
Spec 040.

## Decision

The formal game UI is touch-first:

- Android touch interaction is the release input baseline.
- Mouse click remains supported for development and ordinary browser trials.
- There is no dedicated gameplay keyboard model, custom key binding, card-focus
  navigation scheme, or requirement that a complete match be playable by
  keyboard.
- Semantic HTML remains required for structure, control meaning, browser
  interoperability, and assistive-technology labeling.
- Native browser keyboard behavior on semantic controls is not deliberately
  blocked, but it is incidental rather than a promised or separately enhanced
  product path.
- Continuous card selection remains a pointer interaction. Discrete tap/click
  and continuous selection continue to emit the same selection intents.

This decision supersedes only the keyboard-completeness sentence in ADR 0008's
interaction boundary and the keyboard portion of Spec 004's selection contract.
It does not supersede the semantic DOM or continuous pointer-selection
decisions.

## Consequences

- Spec 040 can optimize card selection, action controls, timing, and feedback
  around direct touch without inventing desktop-style focus navigation.
- Browser acceptance must cover the touch/pointer path and may use mouse input
  as a practical automation mechanism.
- The UI must not add keyboard-only instructions or expose keyboard support as
  a product feature.
- Keeping semantic controls preserves their platform defaults and leaves room
  for a future accessibility decision without committing to an incomplete
  custom keyboard layer now.
- Keyboard-specific glue in the temporary Spec 004 debug screen is removed;
  Spec 040 must not reintroduce it without a new product decision.

## Reconsider when

- desktop browsers become a supported release platform rather than a trial
  environment;
- an actual family user needs keyboard, switch, or other focus-driven input; or
- device testing shows that a broader input contract materially improves
  accessibility without compromising the touch experience.

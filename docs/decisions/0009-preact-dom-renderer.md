# ADR 0009: Preact DOM Renderer

Status: Accepted  
Date: 2026-09-01

## Context

ADR 0008 requires semantic DOM but deliberately leaves Vanilla DOM versus a
small renderer open. The application will grow from one hand and three actions
into bidding, play, rules help, invalid-move feedback, recovery, and result
views. Continuous selection also requires card DOM nodes to keep their identity
while selected state changes during pointer capture.

An equivalent disposable spike implemented an external authoritative session,
17 semantic card buttons, three action buttons, selected state, continuous
pointer selection, and listener cleanup in both approaches. Both variants
passed strict TypeScript checking and Vite production builds.

## Evidence

| Measure | Vanilla DOM | Preact |
| --- | ---: | ---: |
| Renderer source | 87 lines | 60 lines |
| Production JavaScript | 2.73 kB | 15.41 kB |
| Gzipped JavaScript | 1.21 kB | 6.48 kB |
| Explicit DOM creation/synchronization | required | declarative JSX |
| Listener registration/removal | five paired handlers plus session cleanup | component handlers plus effect cleanup |
| Card identity across updates | must preserve nodes manually | keyed nodes preserved by renderer |

The Vanilla implementation could rebuild markup on every update, but doing so
during a pointer gesture would replace the element holding pointer capture. It
therefore retained card nodes and explicitly looped over all cards to synchronize
`aria-pressed`, alongside manual status and listener lifecycle code. Preact
expressed the same relationship from state in one render tree while the session
remained external.

## Decision

Use Preact 10.29.8 with `@preact/preset-vite` 2.10.6 for DOM composition.

- Application session and formal game state remain outside components.
- Components receive read-only views, subscribe at the composition boundary,
  and emit typed intents.
- Preact hooks may own only presentation/transient interaction state.
- No `preact/compat`, router, Signals, Redux, Zustand, context-based service
  locator, UI component library, or CSS framework is introduced.
- Semantic HTML and native CSS remain the presentation contract.

The disposable spike is removed after this record; its measurements and
decision-relevant findings are preserved here.

## Consequences

- The build pays approximately 5.27 kB additional gzip in this minimal spike.
- Declarative updates remove a growing set of manual synchronization points and
  reduce the risk of replacing pointer-captured elements.
- JSX and component lifecycle become concepts contributors must understand.
- Renderer upgrades require bundle, compatibility, and interaction review.
- Core and application tests remain independent of Preact.

## Reconsider when

Measured production performance or size on the target family phones becomes a
problem, Preact stops being maintained, the renderer boundary leaks into core or
session authority, or the UI remains so small that the lifecycle benefit does
not materialize.

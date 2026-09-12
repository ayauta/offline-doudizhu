# Execution Plan 022: Bounded Hand Planning Experiment

Status: Completed — candidate rejected, shipped behavior restored

Started: 2026-09-12

Completed: 2026-09-12

Spec: `docs/specs/053-ai-hand-planning/spec.md`

## Authorized scope

Improve one challenging level before deciding final tier count. Preserve the
family-validated Default and its initial selection. This first experiment only
changes the enhanced hand analyzer's partition estimate, with a reject/revert
decision if the change fails to improve play.

## Steps

1. [x] Read product, architecture, ADRs, Specs 051/052 and prior research.
2. [x] Record the owner's agreed direction and the one-variable contract.
3. [x] Capture shipped discovery baseline and unchanged control per deal.
4. [x] Add regression/oracle tests and prove the current implementation fails.
5. [x] Implement bounded feasible-partition estimates and verify correctness.
6. [x] Run same-seed comparison; reject without consuming held-out seeds.
7. [x] Review delivery impact, run the full gate and applicable browser checks.
8. [x] Record outcome and leave only evidence-supported changes.

## Evidence and decision

- All five new regressions failed before the change, including the two/three-play
  fixtures and exhausted-node behavior. With the candidate, all 34 focused tests
  passed, including unchanged Default/enhanced/handler tests.
- Both configurations completed 400 discovery deals per pairing. Expert vs
  Default went from 49.625% to 50.375%; paired change +0.750 percentage points,
  95% CI [-0.167, +1.708]. Neither superiority over Default nor improvement over
  the previous Expert is established. Reject adoption, not the broader idea.
- The casual/default control's per-deal outcomes and complete command hashes
  match exactly. Four complete runs total 9600 games; arrays, win totals, rates,
  and unchanged control hashes were independently checked.
- The candidate and its tests are archived in Spec 053's `candidate.patch`;
  `git apply --check` succeeds against the restored source. Detailed results and
  all per-deal arms are retained in the same spec directory. `src/**` and
  `tests/**` have no final changes. Existing Spec 052 work is preserved.
- Final `pnpm check` passed: 265 deterministic tests, production build,
  Android delivery source checks, boundaries, privacy, and 30 Chromium cases.
  Sandbox localhost EPERM initially blocked browser startup; the same activated
  project-local command passed with permission for the local server/browser.
- Gzip sizes remain main 19.67 KiB, CSS 5.32 KiB, worker 8.16 KiB, within the
  unchanged budgets. No dependency, runtime capability, or persisted data change.
- The opt-in benchmark's three selected self-checks (statistics, one strong
  seat, deterministic replay/world-cap structure) also passed separately;
  they are not claimed as part of `pnpm check`.
- No held-out, new Master-strength, bidding-quality, or physical-phone evidence
  is claimed. No release, deployment, or commit was made for this experiment.

## Protection and recovery

Existing changes from Spec 052 belong to the prior stage and are preserved.
The starting analyzer, enhanced tests, and roadmap have task-local backups.
Production edits are also protected by Git. No destructive cleanup or external
publication is authorized by this experiment.

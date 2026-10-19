# Implementation plan

## Implemented

1. Canonical fixture mapping (`fixtures/simulators.json`) and a loader that
   reads the shared `simulators/fixtures/` set.
2. Four cross-system smoke journeys with contract assertions:
   reinsurance, finance, bank, and notification/document/screening.
3. Stdlib-only runner (`run-smoke.mjs`) that starts the aggregate simulator on
   an ephemeral port, or targets an existing local or Compose stack.
4. Deterministic start state via each simulator's `POST /admin/reset`.

## Remaining

1. Playwright configuration for the shell and federated remotes
   (`playwright.config.ts`, projects per book and vertical).
2. Page objects under `pages/` for Cession, Retrocession, Payment, and
   Notifications workbenches.
3. Rule-to-test matrix mapping `CES-*`, `RET-*`, `PAY-*`, and other rule IDs to
   Playwright specs (SPEC §15.3 PW-07).
4. Cross-book denial tests for every book-scoped endpoint (PW-05).
5. Evidence packaging: HTML report, traces, coverage, and the matrix for the
   release evidence pack (PW-10).

Playwright is test-only tooling and is not imported by application code.

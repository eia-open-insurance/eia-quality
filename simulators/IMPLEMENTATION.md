# Implementation plan

## Implemented

1. Deterministic HTTP simulators for FS-RI, SAP S/4HANA, bank, email, OCR, and
   sanctions, using Node standard library only.
2. FS-RI contract master, cession/retro hand-off, confirmation, recoverable,
   statement, and reconciliation endpoints with idempotency and book wall.
3. S/4 journal, AR/AP invoice, payment advice, cash application, reversal, GL
   balance, and reconciliation endpoints with SAP-style duplicate checks.
4. Bank `camt.053.001.08` statements with matched, partial, and returned
   entries; email delivery/bounce/suppression; OCR completion, low confidence,
   and failure; sanctions clear/potential/confirmed/fail-closed.
5. Shared JSON fixture set in `fixtures/`, a deterministic fault catalog, and a
   stdlib smoke runner (`run-tests.mjs`) with at least one suite per simulator.
6. Aggregate service on one port for the SPEC §15.3 endpoint, plus Dockerfiles
   and a Compose stack.

## Remaining

1. Contract tests against the real SAP FS-RI and S/4HANA sandboxes when the
   production interfaces are scoped (SPEC §17.10 gates 2 and 3).
2. Optional response recording from the sandboxes to refresh fixtures; must not
   introduce real data into the repository.
3. Coverage reporting for simulator handlers (informational; these are test
   doubles, not production services).

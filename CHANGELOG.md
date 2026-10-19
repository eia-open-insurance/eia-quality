# Changelog

## [Unreleased]

### Added

- Deterministic FS-RI simulator: contract master, cession and retro hand-off,
  confirmation, recoverable, statement, and reconciliation endpoints with
  idempotency keys, payload-hash validation, book wall, and reject/partial/
  timeout/duplicate/mismatch fault modes.
- Deterministic SAP S/4HANA simulator: journal entries, AR and supplier
  invoices, payment advices, cash applications, reversals, GL balances, and
  expected-vs-posted reconciliation with closed-period and FX-difference modes.
- Bank simulator with payment instructions and ISO 20022 `camt.053.001.08`
  statements covering matched, partial, returned, and duplicate behaviour.
- Email relay, OCR, and sanctions simulators with accept/bounce/suppress,
  complete/low-confidence/fail, and clear/potential/confirmed/fail-closed
  behaviour.
- Aggregate simulator service hosting all six systems on one port, matching the
  SPEC §15.3 `/sim/{system}/v1` endpoint shape.
- Shared JSON fixture set, deterministic fault catalog, and a Node
  standard-library test runner with 34 smoke tests across the six simulators and
  the aggregate service.
- Cross-system E2E smoke journeys over the shared fixtures, plus OpenAPI 3.1
  documents for every simulator, Dockerfiles, and a Compose stack.

### Changed

- Expanded the repository and simulator READMEs with start commands, ports,
  endpoint catalogs, fault modes, configuration, and test evidence.
- Documented that the simulators are test doubles only and refuse to start in a
  production environment.

## [0.1.0] - 2026-10-19

### Added

- Consolidated repository baseline.

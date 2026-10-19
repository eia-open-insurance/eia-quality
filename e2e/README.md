# eia-quality/e2e

- GitHub organization: `eia-open-insurance`
- Repository URL: https://github.com/eia-open-insurance/eia-quality/tree/main/e2e
- Type: Test infrastructure
- Deployable: No
- Owner: Quality
- Runtime: Node.js 20+ (standard library only); Playwright for the front-end suites
- Data store: Ephemeral
- Depends on: eia-frontend/shell, eia-quality/simulators, eia-contracts

## Purpose

Cross-vertical test assets: the shared simulator fixture mapping and the
cross-system smoke journeys that prove the external-system contracts before
Playwright drives the federated front-end.

## What is here

| Path | Purpose |
|---|---|
| `fixtures/simulators.json` | Host ports, base paths, container URLs, environment overrides |
| `fixtures/index.mjs` | Loads the canonical `simulators/fixtures/` set and resolves simulator URLs |
| `smoke/journeys.mjs` | Four cross-system journeys with contract assertions |
| `run-smoke.mjs` | Stdlib-only runner: starts the aggregate simulator on an ephemeral port, or targets an existing stack |
| `IMPLEMENTATION.md` | Remaining Playwright work and the current state |

There is no second fixture copy. `fixtures/index.mjs` reads
`../../simulators/fixtures/*.json` directly, so a fixture change is visible to
the simulator smoke tests and the E2E layer at once.

## Run

```powershell
# Self-contained: starts the aggregate simulator, runs all journeys, stops it
node e2e/run-smoke.mjs

# Against a local stack on the documented host ports (8181-8186)
node e2e/run-smoke.mjs   # with no environment variables it starts its own instead

# Against the aggregate service on host port 8180
$env:EIA_SIM_BASE_URL = "http://127.0.0.1:8180"
node e2e/run-smoke.mjs
```

Per-system overrides use the full base path, for example:

```powershell
$env:EIA_SIM_FSRI_URL = "http://127.0.0.1:8181/sim/fsri/v1"
$env:EIA_SIM_S4_URL    = "http://127.0.0.1:8182/sim/s4/v1"
node e2e/run-smoke.mjs
```

The runner calls each simulator's `POST /admin/reset` first, so a run starts
from a clean, deterministic state.

## Journeys and assertions

1. **Reinsurance** — FS-RI contract master → cession hand-off → confirmation →
   recoverable → statement → balanced reconciliation. Asserts
   `fsriContractRef`, confirmed amount `240000.00`, recoverable split
   (paid `144000.00`, unpaid `72000.00`, IBNR `24000.00`), statement net due
   `60000.00`, and reconciliation invariant `sent = accepted + partial +
   rejected + pending`.
2. **Finance** — S/4 journal → AR invoice → supplier invoice → payment advice →
   cash application → reconciliation → GL balance. Asserts balanced journal,
   gross amounts, clearing, `MATCHED` reconciliation with zero breaks, and the
   `120100` receivable balance.
3. **Bank** — payment → `camt.053` statement → XML content checks → returned
   payment with `AC04` reason.
4. **Notification, document, screening** — email delivered and bounced, OCR
   completed and low confidence, sanctions clear and confirmed match.

Evidence from the latest local run is in the repository history; the runner
prints one `PASS` line per assertion and a summary such as
`22 assertions passed … PASS all journeys (22 checks, 6 systems)`.

## Playwright relationship

`smoke/journeys.mjs` is a contract-level smoke layer, not a replacement for
Playwright. It uses the same fixtures and simulator URLs that the Playwright
specs will use, so a test can move from API-level contract proof to a UI
transaction without redefining data. Per SPEC §15.3, Playwright remains the
mandatory tool for front-end behaviour and full UI → domain → expert → database
journeys; those suites run against the shell and federated remotes, with only
these external systems simulated.

## Conventions

- Standard library only: `fetch`, `node:assert`, `node:fs`.
- Every scenario starts with an explicit admin reset and uses fixed IDs.
- Assertions target the integration contract (amounts, statuses, invariant,
  XML content), not only HTTP 200.
- Fault modes are covered by the per-simulator smoke suites; this layer covers
  the cross-system happy paths that the front-end needs.

## License

Apache License 2.0. See [LICENSE](../LICENSE) and [NOTICE](../NOTICE).

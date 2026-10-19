# eia-quality/simulators

- GitHub organization: `eia-open-insurance`
- Repository URL: https://github.com/eia-open-insurance/eia-quality/tree/main/simulators
- Type: Test infrastructure
- Deployable: No
- Owner: Quality
- Runtime: Node.js 20+ (standard library only)
- Data store: Ephemeral, in-memory
- Depends on: none at runtime

## Purpose

Deterministic HTTP test doubles for the six external systems exercised by the
Cession, Retrocession, Payment, Notifications, Document, and Party verticals:

| Simulator | Systems of record stood in for | SPEC |
|---|---|---|
| FS-RI | Contract master, cession, retrocession, confirmation, recoverable, statement, reconciliation | §7.17, §7.18, §7.23.5, §15.3 |
| S/4HANA | AR/AP invoice, GL journal, payment advice, cash application, reversal, GL balance, reconciliation | §7.13, §7.23.6, §15.3 |
| Bank | Payment instruction and ISO 20022 `camt.053.001.08` statements | §13.4, §15.3 |
| Email relay | Notification delivery, bounce, suppression | §7.8, §15.3 |
| OCR | Document extraction, low confidence, failure | §7.8, §15.3 |
| Sanctions | Screening: clear, potential, confirmed, provider error | §7.8, §15.3 |

> **These are test doubles, never production adapters.** They have no real
> FS-RI, SAP, bank, relay, OCR, or watchlist connectivity, no production
> credentials, and permissive test-control endpoints. They refuse to start when
> `NODE_ENV` or `SIM_ENV` is `production` (`common/guard.mjs`).

## Quick start

Run from the repository root (`repos/eia-quality`). No `npm install` is needed:
every simulator uses Node built-ins only.

```powershell
# Aggregate: all six systems on one port, matching SPEC §15.3
node simulators/all/server.mjs
# → http://127.0.0.1:8180/sim/fsri/v1, /sim/s4/v1, ...

# Standalone services (each on its own port)
node simulators/fsri/server.mjs
node simulators/s4/server.mjs
node simulators/bank/server.mjs
node simulators/email/server.mjs
node simulators/ocr/server.mjs
node simulators/sanctions/server.mjs
```

```bash
# bash equivalent
node simulators/all/server.mjs
curl http://127.0.0.1:8180/health
curl http://127.0.0.1:8180/sim/fsri/health
curl http://127.0.0.1:8180/sim/fsri/openapi.yaml
```

Every service prints a banner with the test-double warning, its base path, its
health URL, and its OpenAPI URL.

## Ports and URLs

Container port is **8080** for every image; host ports are only for local tools.
Inside Docker Compose the aggregate service is named `simulators`, so the SPEC
§15.3 URL resolves unchanged: `http://simulators:8080/sim/fsri/v1`.

| Simulator | Host port | Container port | Base path | Health | OpenAPI |
|---|---|---|---|---|---|
| Aggregate (all six) | 8180 | 8080 | `/sim/{system}/v1` | `/health` | `/sim/{system}/openapi.yaml` |
| FS-RI | 8181 | 8080 | `/sim/fsri/v1` | `/sim/fsri/health` | `/sim/fsri/openapi.yaml` |
| S/4HANA | 8182 | 8080 | `/sim/s4/v1` | `/sim/s4/health` | `/sim/s4/openapi.yaml` |
| Bank | 8183 | 8080 | `/sim/bank/v1` | `/sim/bank/health` | `/sim/bank/openapi.yaml` |
| Email relay | 8184 | 8080 | `/sim/email/v1` | `/sim/email/health` | `/sim/email/openapi.yaml` |
| OCR | 8185 | 8080 | `/sim/ocr/v1` | `/sim/ocr/health` | `/sim/ocr/openapi.yaml` |
| Sanctions | 8186 | 8080 | `/sim/sanctions/v1` | `/sim/sanctions/health` | `/sim/sanctions/openapi.yaml` |

## Contract conventions

Every write follows SPEC §7.23:

- **Envelope** (sibling fields): `messageId`, `tenantId`, `sourceSystem`,
  `targetSystem`, `schemaVersion`, `createdAt`, optional `correlationId`,
  `causationId`, `businessBook`, `payloadHash`, `signature`.
  FS-RI routes require `businessBook` (`DIRECT` or `ASSUMED`).
- **Idempotency**: `Idempotency-Key` header or envelope `idempotencyKey`,
  required on every write. A replay returns the stored status and body with
  `Idempotent-Replayed: true` and `X-Sim-Duplicate: true`. Reusing a key with a
  different payload returns `409 EIA-SIM-IDEMPOTENCY-CONFLICT`. Transient
  failures (5xx, 429) are never stored, so a retry can succeed.
- **Business duplicates**: a second request with the same business key but a
  new idempotency key returns `200` with `duplicate: true`; conflicting content
  returns `409` with a `meta.reasonCode`.
- **Payload hash**: optional `payloadHash` is the SHA-256 of canonical JSON for
  the business payload with envelope fields removed. A mismatch is rejected.
- **Errors**: `application/problem+json` with the SPEC §12.2 shape
  (`type`, `title`, `status`, `detail`, `instance`, `code`, `category`,
  `retryable`, `correlationId`, `errors`, `meta`) and the §7.23.4 categories.
- **Headers on every response**: `X-Sim-System`, `X-Sim-Mode: TEST_DOUBLE`,
  `X-Sim-Scenario`, `X-Sim-Scenario-Source`, `X-Sim-Request-Id`,
  `X-Correlation-Id`, `Cache-Control: no-store`.
- **Money** is always an exact decimal string, never a JSON number. Internal
  arithmetic uses BigInt at `numeric(19,4)` and rounds half-up at cents.
- **Collections** use the SPEC §7.6 cursor shape:
  `{ data, page: { size, hasMore, nextCursor, total }, _links }`.
- **Book wall**: a cession payload on an `ASSUMED` envelope (or vice versa)
  returns `403 EIA-SIM-BOOK-WALL` and records a security event.

### Determinism

- The clock is fixed at `2026-10-19T12:00:00.000Z` unless `SIM_CLOCK=live`.
- IDs are sequential per simulator and reset with `POST /admin/reset`:
  `FSRI-CTR-DIRECT-000001`, `FSRI-CES-DIRECT-000001`,
  `S4-JE-2026-000001`, `BNK-PAY-000001`, `EML-000001`, `OCR-000001`,
  `SCR-000001`.
- The same request sequence against a fresh process produces byte-identical
  bodies; the FS-RI and S/4 smoke suites assert this.
- No random values, no wall-clock timestamps in responses, and no ordering
  dependence on database state.

## Endpoint catalog

### FS-RI (`/sim/fsri/v1`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/contracts` | Contract master hand-off → `fsriContractRef` |
| GET | `/contracts`, `/contracts/{ref}` | Contract master queries |
| POST | `/cessions` | Cession hand-off (`DIRECT` only) |
| GET | `/cessions`, `/cessions/{id}` | Cession queries |
| POST | `/cessions/{id}/confirmation` | Confirmation query/replay |
| POST | `/retros` | Retro hand-off (`ASSUMED` only) |
| GET | `/retros`, `/retros/{id}` | Retro queries |
| POST | `/retros/{id}/confirmation` | Retro confirmation |
| GET | `/recoverables`, `/recoverables/{id}` | Paid, unpaid, IBNR, due date |
| POST | `/statements`; GET `/statements`, `/statements/{id}` | Period statement with lines and totals |
| GET | `/reconciliations` | Sent/accepted/partial/rejected/pending and amount variance |
| GET | `/admin/state`; POST `/admin/reset`; GET/POST `/admin/scenarios` | Test control |

Cession hand-off returns the FS-RI cession ID, confirmed amount, variance,
confirmation, and recoverable link. A partial hand-off returns `207` with
`status: PARTIAL` and stores the accepted 60% only. Reject and mismatch scenarios
record an exception/reconciliation break; they never silently correct.

### S/4HANA (`/sim/s4/v1`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/journal-entries`; GET list/detail | Balanced GL journal, FX difference |
| POST | `/ar-invoices`; GET list/detail | AR invoice with gross, tax, open amount |
| POST | `/supplier-invoices`; GET list/detail | AP supplier invoice with duplicate check |
| POST | `/payment-advices`; GET list/detail | AP payment advice and payment document |
| POST | `/cash-applications`; GET list/detail | Applied, partial, or unallocated cash |
| POST | `/reversals`; GET list/detail | Reversal document; original is never edited |
| GET | `/gl-balances` | In-memory GL aggregates by company code/period/account |
| POST | `/reconciliations`; GET list/detail | Expected vs posted with §7.13.5 break reasons |
| GET | `/admin/state`; POST `/admin/reset`; GET/POST `/admin/scenarios` | Test control |
| GET | `/admin/periods`; POST `/admin/periods/{period}/close`, `/open` | Fiscal period control |

Posting creates accounting lines:

| Document | Debit | Credit |
|---|---|---|
| Journal entry | Supplied accounts | Supplied accounts |
| AR invoice | `120100` gross | `400100` net; `220100` tax |
| Supplier invoice | `610100` net; `140100` tax | `200100` gross |
| Payment advice | `200100` amount | `100100` amount |
| Cash application | `100100` applied | `120100` applied |
| Reversal | Swaps the original lines | Swaps the original lines |

### Bank (`/sim/bank/v1`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/payments`; GET list/detail | Outgoing credit transfer; matched, partial, returned |
| POST | `/statements`; GET list/detail | Statement metadata and entries |
| GET | `/statements/{id}/camt053` | ISO 20022 `camt.053.001.08` XML |
| GET | `/admin/state`; POST `/admin/reset`; GET/POST `/admin/scenarios` | Test control |

### Email relay (`/sim/email/v1`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/messages`; GET list/detail | Deliver, bounce, suppress |
| GET | `/admin/state`; POST `/admin/reset`; GET/POST `/admin/scenarios` | Test control |

### OCR (`/sim/ocr/v1`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/documents`; GET list/detail | Extraction job (completed, low confidence, failed) |
| GET | `/admin/state`; POST `/admin/reset`; GET/POST `/admin/scenarios` | Test control |

### Sanctions (`/sim/sanctions/v1`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/screenings`; GET list/detail | Clear, potential, confirmed, fail-closed error |
| GET | `/lists`, `/lists/{code}` | **Fictional** simulated watchlists |
| GET | `/admin/state`; POST `/admin/reset`; GET/POST `/admin/scenarios` | Test control |

## Deterministic fault modes

Resolve order: `X-Sim-Scenario` header → `simulation.scenario` body field →
admin default → magic suffix in a business reference → `accept`.

| Scenario | HTTP | Problem code | Retry? | Trigger examples |
|---|---|---|---|---|
| `accept` | normal | — | — | default |
| `timeout` | 504 | `EIA-SIM-TIMEOUT` | yes | header, `-TIMEOUT` |
| `unavailable` | 503 | `EIA-SIM-UNAVAILABLE` | yes | header, `-UNAVAILABLE` |
| `throttled` | 429 | `EIA-SIM-THROTTLED` | yes | header, `-THROTTLED` |
| `malformed` | 400 | `EIA-SIM-MALFORMED-PAYLOAD` | no | header, `-MALFORMED` |
| `reject` | 422 | `EIA-SIM-BUSINESS-REJECT` | no | header, `-REJECT` |
| `partial` | 207 | body `status: PARTIAL` | no | FS-RI hand-offs; bank payments return a partial amount |
| `duplicate` | 200 / 404 | `EIA-SIM-NO-PRIOR-MESSAGE` | no | replay an existing key |
| `closed_period` | 422 | `EIA-SIM-CLOSED-PERIOD` | no | S/4, `-CLOSED` |
| `fx_difference` | 201 | body `fxDifference` | — | S/4, `-FX` |
| `mismatch` | 200 | body `status: MISMATCH` | — | FS-RI confirmation, `-MISMATCH` |
| `return` | 201 | body `settlementStatus: RETURNED` | — | bank, `-RETURN` |
| `bounce` | 201 | body `status: BOUNCED` | — | email, `-BOUNCE`, `bounce@` |
| `suppress` | 201 | body `status: SUPPRESSED` | — | email, `-SUPPRESS`, `suppressed@` |
| `fail` | 201 | body `status: FAILED` | — | OCR, `-FAIL` |
| `low_confidence` | 201 | body confidence `0.42` | — | OCR, `-LOWCONF` |
| `potential` | 201 | `POTENTIAL_MATCH` | — | sanctions, `-POTENTIAL` |
| `confirmed` | 201 | `CONFIRMED_MATCH` | — | sanctions, `-CONFIRMED` |
| `error` | 503 | `EIA-SIM-UNAVAILABLE` + `failClosed` | yes | sanctions, `-SCRERR` |

`X-Sim-Delay-Ms` overrides the timeout delay (capped at 30 s;
`SIM_TIMEOUT_MS` default 1500). The full catalog is
[`fixtures/faults.json`](fixtures/faults.json).

## Fixtures

The single canonical fixture set is [`fixtures/`](fixtures/README.md). It is
shared with `e2e/fixtures/index.mjs`; there is no second copy. Each fixture
embeds the envelope and fixed identifiers, so it can be posted as-is:

```powershell
$body = Get-Content simulators/fixtures/fsri-cession.json -Raw
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8181/sim/fsri/v1/cessions `
  -ContentType 'application/json' -Body $body
```

(`fsri-cession.json` requires the contract from `fsri-contract.json` first.)

## Tests

Node's built-in test runner only; no dependency and no `package.json`.

```powershell
node simulators/run-tests.mjs          # all simulators: 34 tests
node simulators/run-tests.mjs fsri     # filter by directory name
node e2e/run-smoke.mjs                 # cross-simulator journeys: 22 checks
```

Each simulator has `test/smoke.test.mjs` covering health, OpenAPI, the happy
path, idempotent replay, business duplicates, and its fault modes. The FS-RI
and S/4 suites also prove byte-identical responses across fresh processes.

## Docker

Build from the repository root so the build context contains `simulators/`:

```bash
docker build -f simulators/fsri/Dockerfile -t eia/fsri-simulator .
docker build -f simulators/s4/Dockerfile -t eia/s4-simulator .
docker build -f simulators/bank/Dockerfile -t eia/bank-simulator .
docker build -f simulators/email/Dockerfile -t eia/email-simulator .
docker build -f simulators/ocr/Dockerfile -t eia/ocr-simulator .
docker build -f simulators/sanctions/Dockerfile -t eia/sanctions-simulator .
docker build -f simulators/all/Dockerfile -t eia/simulators .
```

Or start the whole stack:

```bash
docker compose -f simulators/docker-compose.yml up --build
```

Inside the Compose network: `http://simulators:8080/sim/fsri/v1`. From the host:
`http://127.0.0.1:8180/sim/fsri/v1` (aggregate) or the per-simulator ports in
the table above.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `SIM_PORT` | per simulator | Listen port; container images use 8080 |
| `HOST` | `127.0.0.1` | Bind address; images set `0.0.0.0` |
| `SIM_CLOCK` | `2026-10-19T12:00:00.000Z` | Fixed instant, or `live` |
| `SIM_TIMEOUT_MS` | `1500` | Timeout-scenario delay |
| `SIM_ADMIN_ENABLED` | `true` | Set `false` to disable `/admin/*` |
| `SIM_AUTH_TOKEN` | unset | Require `Authorization: Bearer <token>` |
| `SIM_HMAC_SECRET` | unset | Require `X-EIA-Signature: sha256=<HMAC>` on writes |
| `SIM_LOG_REQUESTS` | unset | `true` logs one JSON line per request |
| `S4_CLOSED_PERIODS` | `2025-12` | Comma-separated closed periods |
| `NODE_ENV` / `SIM_ENV` | unset | `production`/`prod` refuses to start |

## Safety and scope

- Test doubles only; no production adapter code and no vendor SDKs.
- Bind to loopback by default; only the container image sets `HOST=0.0.0.0`.
- Synthetic data only; the sanctions lists and parties are fictional.
- Admin endpoints are test control, can be disabled, and are protected by the
  same optional token as the business endpoints.
- Not a substitute for contract tests against the real target sandbox
  (SPEC §7.23.7). They prove the *platform side* of the contract.

## Layout

```text
simulators/
  common/       envelope, idempotency, problems, money, router, server, testkit
  fixtures/     shared JSON fixtures and fault catalog
  fsri/         app, server, OpenAPI, Dockerfile, smoke test
  s4/           app, server, OpenAPI, Dockerfile, smoke test
  bank/         app, server, OpenAPI, Dockerfile, smoke test
  email/        app, server, OpenAPI, Dockerfile, smoke test
  ocr/          app, server, OpenAPI, Dockerfile, smoke test
  sanctions/    app, server, OpenAPI, Dockerfile, smoke test
  all/          aggregate server on one port, Dockerfile, smoke test
  docker-compose.yml
  run-tests.mjs
```

## License

Apache License 2.0. See [LICENSE](../LICENSE) and [NOTICE](../NOTICE).

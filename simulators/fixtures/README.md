# Shared fixtures

One canonical JSON fixture set for the simulators and the Playwright/E2E layer.
The files are plain data: no fixture is generated, and no hash is hardcoded, so
editing a payload never invalidates a fixture.

| File | Used by | Purpose |
|---|---|---|
| `envelope.json` | all | Example SPEC §7.23.2 message envelope |
| `fsri-contract.json` | FS-RI | Contract master hand-off |
| `fsri-cession.json` | FS-RI | Cession hand-off for the DIRECT book |
| `fsri-retro-contract.json` | FS-RI | Retro contract master hand-off for the ASSUMED book |
| `fsri-retro.json` | FS-RI | Retro hand-off |
| `fsri-statement.json` | FS-RI | Statement generation request |
| `s4-journal-entry.json` | S/4 | Balanced GL journal entry |
| `s4-ar-invoice.json` | S/4 | AR invoice instruction |
| `s4-supplier-invoice.json` | S/4 | AP supplier invoice |
| `s4-payment-advice.json` | S/4 | AP payment advice |
| `s4-cash-application.json` | S/4 | Cash application against an AR invoice |
| `s4-reconciliation.json` | S/4 | Expected-vs-posted reconciliation |
| `s4-reversal.json` | S/4 | Reversal of the first journal document |
| `bank-payment.json` | Bank | Outgoing credit transfer |
| `bank-statement.json` | Bank | `camt.053` statement request |
| `email-message.json` | Email relay | Notification delivery |
| `ocr-document.json` | OCR | Document extraction job |
| `sanctions-screening.json` | Sanctions | Party screening |
| `faults.json` | all | Deterministic scenario catalog |

## Envelope fields

Every write fixture embeds the transport envelope as sibling fields:
`messageId`, `idempotencyKey`, `correlationId`, `tenantId`, `businessBook`
(where the domain is book-scoped), `sourceSystem`, `targetSystem`,
`schemaVersion`, `createdAt`. The remaining fields are the business payload.

`payloadHash` is optional. It is the SHA-256 of the canonical business payload
with envelope fields removed. Compute it at runtime (`payloadHash` in
`simulators/common/testkit.mjs`); never hardcode it in a fixture.

## Loading

```js
import { fixture, withKey } from '../../common/testkit.mjs';

const body = withKey(fixture('fsri-cession'), 'smoke-fsri-cession-1');
```

The E2E layer loads the same files through `e2e/fixtures/index.mjs`; there is no
second copy. Fixtures use fixed identifiers and the simulator clock is fixed, so
a request built from a fixture produces the same response body on every run.

## Faults

`faults.json` is the human-readable catalog. The authoritative implementation is
`simulators/common/scenarios.mjs` plus each app's `magicScenarios` array; the
smoke tests prove the header, admin-default and magic-suffix paths.

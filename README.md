# eia-quality

Quality engineering monorepo: external-system simulators and cross-vertical Playwright suites.

- GitHub organization: `eia-open-insurance`
- Repository URL: https://github.com/eia-open-insurance/eia-quality
- Type: Platform product area
- Deployable: No (contains multiple deployable components)

## Components

| Component | Path | Type | Deployable |
|---|---|---|---|
| FS-RI simulator | `simulators/fsri/` | Test service | No |
| S/4HANA simulator | `simulators/s4/` | Test service | No |
| Bank simulator | `simulators/bank/` | Test service | No |
| Email relay simulator | `simulators/email/` | Test service | No |
| OCR simulator | `simulators/ocr/` | Test service | No |
| Sanctions simulator | `simulators/sanctions/` | Test service | No |
| Aggregate simulator | `simulators/all/` | Test service | No |
| Playwright suites and E2E assets | `e2e/` | Test suite | No |

## Local simulators

Deterministic external-system test doubles, Node standard library only. See
[`simulators/README.md`](simulators/README.md) for the endpoint catalog, fault
modes, environment variables, and Docker instructions.

```powershell
node simulators/all/server.mjs     # all six systems on http://127.0.0.1:8180
node simulators/run-tests.mjs      # 34 simulator smoke tests
node e2e/run-smoke.mjs             # 22 cross-system E2E checks
```

| System | Host port | Base path |
|---|---|---|
| Aggregate | 8180 | `/sim/{system}/v1` |
| FS-RI | 8181 | `/sim/fsri/v1` |
| S/4HANA | 8182 | `/sim/s4/v1` |
| Bank | 8183 | `/sim/bank/v1` |
| Email relay | 8184 | `/sim/email/v1` |
| OCR | 8185 | `/sim/ocr/v1` |
| Sanctions | 8186 | `/sim/sanctions/v1` |

## Verification

Run the project baseline check from the repository root:

```powershell
pwsh ../verify.ps1
```

No hosted CI is used. Component builds and tests run locally.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

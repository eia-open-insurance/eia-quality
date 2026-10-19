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
| S/4 simulator | `simulators/s4/` | Test service | No |
| Bank simulator | `simulators/bank/` | Test service | No |
| Email/OCR/sanctions simulators | `simulators/` | Test services | No |
| Playwright suites | `e2e/` | Test suite | No |

## Verification

Run the project baseline check from the repository root:

```powershell
pwsh ../verify.ps1
```

No hosted CI is used. Component builds and tests run locally.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

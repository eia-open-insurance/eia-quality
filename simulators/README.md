# eia-quality/simulators

- GitHub organization: `eia-open-insurance`
- Repository URL: https://github.com/eia-open-insurance/eia-quality/tree/main/simulators
- Type: Test infrastructure
- Deployable: No
- Owner: Quality
- Runtime: Spring Boot and Node.js
- Data store: Ephemeral
- Depends on: eia-contracts

## Purpose

FS-RI, S/4, bank, email, OCR, and sanctions simulators with deterministic and fault behavior.

## Responsibilities

- Keep this repository focused on one deployable component or one platform concern.
- Follow the repository standard in `../CONVENTIONS.md` and the specification in `../../SPEC.md`.
- Publish and consume contracts through `eia-contracts`.
- Maintain README, CODEOWNERS, SECURITY, CHANGELOG, tests, and local verification.
- Contain no business logic in shared libraries or front-end remotes.

## Verification

- Lint and format
- Unit tests with 100% business-logic coverage where applicable
- Contract tests
- Integration or Playwright tests where applicable
- Security scan and SBOM
- Build and publish

## Notes

Used by integration and Playwright tests only.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

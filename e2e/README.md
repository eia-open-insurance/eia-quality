# eia-quality/e2e

- GitHub organization: `eia-open-insurance`
- Repository URL: https://github.com/eia-open-insurance/eia-quality/tree/main/e2e
- Type: Test infrastructure
- Deployable: No
- Owner: Quality
- Runtime: Playwright
- Data store: Ephemeral
- Depends on: eia-frontend/shell, eia-quality/simulators, eia-contracts

## Purpose

Cross-vertical Playwright suites, fixtures, page objects, and test data orchestration.

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

Every business rule maps to at least one E2E test.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

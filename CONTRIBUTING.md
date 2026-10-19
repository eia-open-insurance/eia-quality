# Contributing to EIA Open Insurance

Thank you for contributing.

## License and certificate of origin

By contributing, you agree that your contribution is licensed under the Apache License 2.0 and that you have the right to submit it.

Every commit must be signed off under the Developer Certificate of Origin:

```bash
git commit -s -m "feat: add policy coverage validation"
```

The sign-off certifies that you wrote the change or have the right to submit it. There is no Contributor License Agreement.

## Code of conduct

All participants must follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Before you start

- Read [SPEC.md](SPEC.md) and the relevant vertical chapter.
- Check [REPOSITORIES.md](REPOSITORIES.md) for the owning repository.
- Open an issue or discussion for significant design changes.
- For a security issue, follow [SECURITY.md](SECURITY.md); do not open a public issue.

## Workflow

1. Fork the repository.
2. Create a short-lived branch from `main`.
3. Make a focused change with tests.
4. Update `CHANGELOG.md`.
5. Run the repository checks locally.
6. Sign off your commits.
7. Open a pull request with a clear description and evidence.
8. Address review comments.
9. Squash merge after approval and local verification and review.

## Standards

- One deployable component per repository.
- Business logic belongs in the domain service, not the front-end.
- No business logic in shared libraries.
- Contracts are published from `eia-contracts`.
- Every business rule needs a Playwright test through the front-end and a full transactional flow.
- Business logic requires 100% line and branch coverage.
- Do not commit secrets, production data, or personal data.

## Pull requests

A pull request should include:

- what changed and why;
- the specification section or issue it implements;
- test evidence;
- contract changes;
- security and privacy impact;
- rollback or migration notes;
- changelog entry.

## Review

Maintainers review for correctness, security, operability, and fit with the specification. A change that alters a `MUST` requires an ADR or a specification change first.

## Community

Be direct, be kind, and assume good intent. Disagreement about design is welcome; personal attacks are not.

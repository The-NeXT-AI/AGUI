# Contributing

Thanks for helping improve AGUI Desktop. This project is an Electron, React, and pnpm workspace application, so please keep changes small, tested, and easy to review.

## Development

Use Node.js 22.12.0 or newer and pnpm 9.15.1 or newer.

```bash
pnpm install
pnpm dev
```

The docs site lives in `docs/`:

```bash
pnpm docs:dev
```

## Checks

Before opening a pull request, run:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:asp
pnpm docs:build
pnpm audit --audit-level high
```

For extension-facing changes, also run:

```bash
pnpm test:extension-contracts
```

For Electron shell or UI behavior changes, run the relevant e2e tests when possible:

```bash
pnpm test:e2e
```

## Pull Requests

- Describe the user-visible behavior change and the reason for it.
- Include screenshots or short recordings for UI changes.
- Keep generated artifacts out of commits unless the package explicitly tracks them.
- Update README or docs when changing public commands, configuration, extension APIs, or provider behavior.
- Never include real tokens, local credentials, private transcripts, or personal workspace data.

## Security

Do not open public issues with exploit details or secrets. Follow `SECURITY.md` for vulnerability reports.

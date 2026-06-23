# Contributing

Thanks for your interest in Mailcove.

## Getting started

1. Fork and clone the repo.
2. `npm install`.
3. Copy `.dev.vars.example` to `.dev.vars` and set an `AUTH_TOKEN`.
4. Run `npm run dev` (Worker) and `npm run dev:web` (SPA) side by side.

## Before you open a pull request

Run the full local check and make sure it passes:

```bash
npm run typecheck && npm run test && npm run build
```

Add or update tests for anything you change. The Worker tests live in `src/test/` and the
SPA tests in `app/test/`.

## Guidelines

- Keep changes focused. One topic per pull request.
- Match the existing style. Do not reformat unrelated code.
- Never commit secrets. `.dev.vars` is gitignored for a reason.
- For security issues, follow [SECURITY.md](SECURITY.md) instead of opening a public
  issue.

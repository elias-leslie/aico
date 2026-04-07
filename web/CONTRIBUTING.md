# Contributing

Thanks for taking the time to look at A-Term.

This repository is published primarily as a working public codebase, not as a
high-volume community project. Contributions are welcome, but review and merge
decisions are handled on a best-effort basis.

## Before You Start

- Open an issue before larger changes so direction stays aligned.
- Keep pull requests small, focused, and easy to review.
- Preserve existing architecture and coding patterns unless the change is
  intentionally restructuring them.
- Add or update tests when behavior changes.

## Development

Project setup and service commands are documented in [README.md](README.md).

Validate A-Term against the native host services. The public install path is:

```bash
bash scripts/install.sh --no-start
bash scripts/start.sh
```

Use standard project tooling for checks:

```bash
uv run pytest
uv run ruff check .
uv run ty check
corepack pnpm --dir frontend lint
corepack pnpm --dir frontend exec tsc --noEmit
corepack pnpm --dir frontend test
```

## Licensing

By submitting a contribution, you represent that you have the right to license
it and agree that your contribution will be provided under the Apache License
2.0 for this repository.

No CLA is required at this time.

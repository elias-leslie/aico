# Contributing

Thanks for taking a look at Aico.

## Development setup

```bash
scripts/aico-install.sh
npm run check
```

Use focused changes and keep the public install path working from a fresh clone.

## Pull request expectations

- Explain the user-visible change.
- Include or update tests for behavior changes.
- Run `npm run check` before submitting.
- Do not commit secrets, local state, screenshots with private data, generated caches, or machine-specific paths.

## Optional tooling

Aico can integrate with local agent/project tooling when it is installed, but contributions should not make private tooling mandatory for normal install, test, or run paths.

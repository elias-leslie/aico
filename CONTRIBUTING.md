# Contributing

Thanks for taking a look at Aico.

## Development setup

```bash
scripts/aico-install.sh
npm run check
```

Use focused changes and keep the public install path working from a fresh clone.

Running Aico needs a Tether daemon (the installer checks `tether --json version`);
`npm run check` does not, because its tests use a fake Tether socket. Session
lifecycle changes (tmux servers, launch, End, roots) belong in the Tether repo;
Aico keeps windows, view state, the renderer and the sidecar. The `st aico`
client lives in Tether; `scripts/aico-root-watch.py` here is only the entry
SummitFlow runs, and it execs Tether's installed copy.

## Pull request expectations

- Explain the user-visible change.
- Include or update tests for behavior changes.
- Run `npm run check` before submitting.
- Do not commit secrets, local state, screenshots with private data, generated caches, or machine-specific paths.

## Optional tooling

Aico can integrate with local agent/project tooling when it is installed, but contributions should not make private tooling mandatory for normal install, test, or run paths.

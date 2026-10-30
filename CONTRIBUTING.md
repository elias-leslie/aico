# Contributing

Thanks for taking a look at Aico.

## Development setup

```bash
scripts/install.sh
npm run check
uv sync --locked --directory tether/scripts   # Tether's operator-script tests
tether/scripts/.venv/bin/pytest -q
```

Use focused changes and keep the public install path working from a fresh clone.

The repo holds the whole product: the desktop at the root (`electron/`),
Tether in `tether/` and the web app in `web/`. Running Aico needs
a Tether daemon; the tests do not, because they use a fake Tether socket.
Session lifecycle changes (tmux servers, launch, End, roots) go in `tether/`;
the front ends keep views, view state and rendering. The `st aico` client lives
in `tether/scripts/`; SummitFlow runs `tether/scripts/aico-root-watch.py`
from this checkout.

## Pull request expectations

- Explain the user-visible change.
- Include or update tests for behavior changes.
- Run `npm run check` and the Python tests before submitting.
- Do not commit secrets, local state, screenshots with private data, generated caches, or machine-specific paths.

## Optional tooling

Aico can integrate with local agent/project tooling when it is installed, but contributions should not make private tooling mandatory for normal install, test, or run paths.

## Licensing

By submitting a contribution, you agree that it is provided under the Apache
License 2.0 for this repository. No CLA is required.

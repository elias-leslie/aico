# Python ST SDK

This wheel keeps the `st_sdk` imports used by standalone Python extensions. The
distribution name remains `summitflow-st-sdk` so existing dependency declarations
can install the Aico-owned replacement without a package rename.

Project selection uses the validated `ST_EXTENSION_CONTEXT` v1 contract, an
explicit project override, environment selection, checkout metadata, or
`aico projects list/show --json`. Registry reads run the installed `aico` command;
`AICO_CLI` may select an executable explicitly. They never contact SummitFlow.
HTTP clients send no implicit identity headers or credentials. A caller can
provide its own HTTP endpoint. Without one, the API URL comes from Aico's
registered runtime identity or `AICO_API_BASE` / `AICO_WEB_URL`. The legacy
`ST_API_BASE` override and v1 context URL fields remain supported.

`STClient.create_task()` uses Aico's local task command when no custom HTTP base
was passed. The legacy credential helpers prefer explicit process values and retain the approved
local identity file for standalone owners. They never read retired SF owner-token files
or print identity values. The source path and recognized fields live in credentials-policy.json.

`tools_run.py --label TEXT -- COMMAND ARGS...` uses the existing same-user
advisory admission locks, `ST_HEAVY_LEASE`, nested descriptor verification,
worker caps, host-pressure decisions, and owned-child cancellation. It runs with
standard-library Python, including before the wheel's dependencies are installed.
Admission policy values live in `st_sdk/admission-policy.json`; the defaults
match the former admission implementation so old and new callers share lanes.

Prepare and verify from the repository root:

```sh
st tools run --label 'Prepare SDK environment' -- uv sync --locked --directory native/st-sdk
st check --native --stage python-st-sdk --no-reuse
st tools run --label 'Build SDK wheel' -- uv build --wheel --directory native/st-sdk
```

Consumers install `dist/summitflow_st_sdk-0.2.10-py3-none-any.whl` in their existing
environment. The check stage runs Ruff, ty, and every test in `tests/`.

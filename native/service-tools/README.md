# Project service tools

`native/service-tools/st-service SUBCOMMAND ...` owns the CLI-local service
lifecycle after the ST alias moves to Aico. The parent CLI routes Aico's own
rebuilds to `aico deploy`; other service operations come here. `result` and
`wait` return exit 3 without output for `aico-*` jobs.

Prepare with `uv sync --locked --directory native/service-tools`; a fresh
launcher prepares its runtime through managed admission on first use. The SDK is
installed from the adjacent `native/st-sdk`; no SummitFlow backend, API,
database, checkout or Python environment supplies code. The launcher uses its
own Python environment and preserves the caller's working directory.

Project discovery uses `aico projects list/show`. A registered root's versioned
`project.identity.json` supplies its service set and build layout. Aico's
`check --acceptance --sha COMMIT` accepts the exact selected commit in its own
clean worktree; retained service descriptors, source exports, forward-deploy
checks, deployment locks, unit attestation and deployment receipts preserve
the previous service contract. Supplied legacy receipts select a source commit
and go through Aico acceptance again. Heavy builds and acceptance use the
SDK's managed admission.

The observation-only mappings in `aico_service/lib/service-policy.json` let
status use a registry row and installed units without accessing that project's
source. Neri's coordinator supplied its backend unit mapping for that purpose;
service mutations still require the separate versioned source identity.

Existing deployment state stays at `$SUMMITFLOW_SERVICE_STATE_ROOT` or
`~/.summitflow/services`. Existing job ids, unit names, deployment receipt
environment (`SUMMITFLOW_DEPLOYMENT_RESULT`), remote-unit timeout overrides
and migration key grants remain compatible. `AICO_BIN` and `AICO_HOOK_BIN`
override the owning public commands; `AICO_REPO_ROOT` identifies the CLI
checkout for detail files. Runtime targets stay in project identity metadata.

Run the declared native check stage through `st check --native --stage
python-service-tools`. Its command is `bash native/service-tools/check.sh`;
the prepared input is `native/service-tools/.venv` and lock inputs are
`pyproject.toml` and `uv.lock` in this directory. Tests use isolated temporary
repositories and stub runtime mutations. Live non-Aico rebuild proof belongs
to the cutover coordinator; preparing this package changes no running unit.

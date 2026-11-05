# Independent review

Two fresh Codex reviews used the configured review route: gpt-6.1-sol, xhigh. The native API accepted that route; separate delivered-model attestation was not available.

The CLI review found root output/project flags, passive help, stale manifest guidance, snapshot project spelling, cancellation, and Codex's filtered asking-session environment. Regressions were reproduced before fixes. The CLI uses the existing public widget recovery, owns cancellation as a process group, preserves the v1 output envelope, and lists only supported commands.

The added service-port review found detached native identity loss and options-before-project dispatch. Both were reproduced and fixed: service-tools retains native caller metadata, parses the project itself, and returns exit 3 for the Aico deployment owner. Its status-only Neri mapping does not read the repository. The independent stage passed 96 tests before the fixes; the final worker stage passed Ruff and 103 tests afterward.

Integration regressions also cover SDK standalone identity compatibility, focused/native check dispatch, native-suite ownership, prompt JSON/revisions, CLI-only deployment, and distinct installed-runtime/source-checkout roots. SDK final gate: Ruff, ty, 30 tests. Mockup focused tests: 16. Final pre-checkpoint scoped quick: 58 stages passed, with the package checks, Python suites, Go and related Vitest tests. Live proof and final acceptance are recorded separately after deployment.

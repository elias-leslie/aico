# M9-1 fixes — Codex evidence

Implemented the ten findings from `review-codex.md` under `briefs/M9-1-fixes.md`. Dependencies are checkpointed in aico `4bba6cb7`; SummitFlow changes are committed as `014256418`. The remaining Aico source and regression tests accompany this report. No service deploy was performed; the launcher rebuilt its CLI bundles for live verification.

| Review item | Fix and regression coverage |
| --- | --- |
| R1, P1 | Runs and ask share `roleEgress()` and `transportRefusal()`. Tests check allowed/forbidden resolved endpoints, missing profiles, and refusal of native CLI transports before invocation for restricted roles. Existing agent egress tests pass. |
| R2, P2 | Ajv validates only own JSON properties (`ownProperties:true`); required `constructor` and unexpected `toString` regression cases pass. |
| R3, P2 | Ajv checks object const/enum equality independently of key order and measures Unicode string lengths by code point. Both valid and invalid cases are tested. |
| R4, P2 | Strict Ajv 2020-12 compilation happens before model invocation. Bad regexes, schema types and unknown keywords yield typed `bad_input`; fake CLI invocation files remain absent. Async schemas are explicitly refused. |
| R5, P2 | Unsupported Bing text recency filters and yearly news filters fail explicitly. Tests cover d/w/m/y, absence of an unfiltered fallback request, and SearXNG news/recency propagation. |
| R6, P2 | Bing news failures never fall back to DuckDuckGo's ordinary text endpoint; regression asserts failure and the exact request count. |
| R7, P2 | `ipaddr.js` replaces the handwritten address-range list. Tests reject benchmark, documentation and local multicast addresses, permit ordinary public IPv4/IPv6, and assert no Jina request after a non-global direct failure. |
| R8, P2 | SummitFlow validates registration/grants first, tries Aico, then resolves Agent Hub only for rollback/NOT_HANDLED. Missing-owner, missing-entrypoint, denied-registration and rollback tests pass. |
| R9, P2 | The explicit trusted web environment allowlist preserves Aico data/cache/runtime/status configuration and `XDG_STATE_HOME`. Regression uses the real registry binding and verifies arbitrary secrets stay excluded. |
| R10, P3 | Search/research/fetch/refocus reject surplus positionals with exit 2 before I/O. Live `st web fetch URL URL --backend direct --raw` also exits 2. |

Verification: targeted webtools tests **27 passed**; agent ask/schema/run/rules tests **94 passed**; the managed check after formatting passed type checking, imports/boundaries, secret scanning and **186 related Vitest tests**. SummitFlow's quick gate passed **6,176 pytest tests** and **391 Vitest tests**; focused delegation tests passed **13/13**. A legacy operator test now explicitly selects rollback rather than depending on Aico's absence from PATH.

The final scoped owner gate, `aico check --quick --paths <the changed agent/webtools files and this report>`, passed in **5.3 s: 11 stages ran, 57 skipped, 186 related tests passed** (`.dev-tools/vitest-194120-details.txt`). The broad `st check --quick --paths ...` also ran **3,227 Vitest tests** and **1,151 pytest tests** successfully, but returned 1 on concurrent out-of-scope package stages, including dirty Tether `lifecycle/engine.ts:1109,1141` (`stdio` is not an `ExecFileOptions` property). These files were left to their owning lane. The original read-only review report remains uncommitted.

Live checks: `st web search --query 'RFC 9110 HTTP semantics' --limit 1 --raw` returned the RFC Editor result; `st web fetch --url https://example.com/ --backend direct --max-chars 300 --raw` returned HTTP 200 and the expected JSON shape. A surplus URL produced usage exit 2. `aico ask gpt-6.1-sol 'What is six times seven? Return the answer in the requested JSON object.' --schema /tmp/m9-ask-final.json --effort low --json` returned `done`, `data:{"answer":42}`, 91 input / 9 output tokens, in 2.8 s (exit 0).

A live malformed-pattern schema returned `bad_input` with exit **2**, zero input/output tokens and 25 ms wall time, confirming preflight rejection without a model call.

Deliberate limits: a provider unable to preserve recency returns a typed failure; SearXNG can serve news for every supported recency period. A native model CLI is available only to roles with unrestricted egress because its endpoint cannot be verified. Per the coordinator, the legacy benchmark remains unchanged until M12, and no unused HTTP route was added. No byte-sensitive consumer of `pyJson` was found; it and its formatting-only test were removed while parsed-JSON contract tests remain.

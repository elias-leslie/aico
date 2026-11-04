# M6b result: our agent slice against Pi

Date 2026-11-03. Harness: `packages/agent` (`aico agent run`), 1,518 lines including 382 lines of tests.
It runs on pi-ai, pi-agent-core and pi-coding-agent 1.4.0, which are exact-pinned and unmodified.
Commits: 2c664c1f (package), 6203b9bb (wiring), 51ce61ab (OSV overrides).

Acceptance on 51ce61ab passed. It counted pytest 1112 and Vitest 2795 passed / 6 skipped, against a baseline of 823 and 2711 / 6. The increase comes from other milestones' commits since c57f4178 plus this slice's 20 tests.

**Verdict: PASS on the brief's terms, with one cost caveat on long tasks.** Total tokens were below Pi on both tasks. Both sides passed the same checks. The refusal handoff works live, and the blocked-model and unreadable-rules cases fail closed. On the long task we used fewer tokens in total but more uncached input. At the pinned price that made us about 15% more expensive than Pi there; on the fixture we were about 31% cheaper. Pi's terminal app did not become the main harness.

## Setup

- **Model:** gpt-6.1-sol at high thinking through pi-ai's `openai` provider (openai-responses, ChatGPT sign-in), for both sides. All runs were served by gpt-6.1-sol; no model swap was seen.
- **Pi:** `pi --mode json -p --no-session --model openai/gpt-6.1-sol --thinking high --no-extensions --no-mcp --approve --tools read,bash,edit,write "<task>"`
- **Ours:** `aico agent run --role implementation --model codex/gpt-6.1-sol --effort high --json "<task>"`
- **Context:** both sides got the same task text, the same four tools and the same folder. Every run started from a fresh copy.
- **Fixture:** the 16-check fixture, graded by its own checks.
- **Long task:** add a turn limit (`maxTurns`, `--max-turns`, exit code 5, plus tests) to `packages/agent`, in a scratch clone of aico under /srv/scratch/m6b. It was graded by a hidden 5-test file, the package's own Vitest suite, and `tsc -b`. The hidden file was checked against a reference solution first.
- **Repeats:** every pair got its one allowed repeat, because the totals of every pair differed by more than 15%.
- **Cost:** pi-ai's pinned price for gpt-6.1-sol, per million tokens: input $2, cache read $0.10, output $10. No run reached the tier above 272k input.

## Results

Tokens are disjoint: input means uncached input. Cache write was 0 in every run.

| Run | Input | Cache read | Output | Total | Cost | Checks | Tool calls | Wall |
|---|---:|---:|---:|---:|---:|---|---:|---:|
| Fixture, ours 1 | 5,010 | 2,816 | 742 | 8,568 | $0.0177 | 16/16 | 9 | 31.5 s |
| Fixture, ours 2 | 3,451 | 4,480 | 945 | 8,876 | $0.0168 | 16/16 | 11 | 32.8 s |
| Fixture, Pi 1 | 7,618 | 23,168 | 691 | 31,477 | $0.0245 | 16/16 | 9 | 39.4 s |
| Fixture, Pi 2 | 7,913 | 17,664 | 806 | 26,383 | $0.0257 | 16/16 | 9 | 35.4 s |
| Long, ours 1 | 43,001 | 130,688 | 4,852 | 178,541 | $0.1476 | hidden 5/5, suite 36/36, tsc ok | 19 | 137.6 s |
| Long, ours 2 | 43,754 | 136,320 | 4,906 | 184,980 | $0.1502 | hidden 5/5, suite 38/38, tsc ok | 18 | 147.9 s |
| Long, Pi 1 | 25,376 | 241,664 | 5,482 | 272,522 | $0.1297 | hidden 5/5, suite 34/34, tsc ok | 20 (2 failed) | 157.2 s |
| Long, Pi 2 | 26,771 | 207,872 | 5,525 | 240,168 | $0.1296 | hidden 5/5, suite 37/37, tsc ok | 18 (1 failed) | 151.2 s |

Sums of both runs on each side:

| Task | Ours: total tokens / cost | Pi: total tokens / cost | Ours vs Pi |
|---|---|---|---|
| Fixture | 17,444 / $0.0345 | 57,860 / $0.0502 | 70% fewer tokens, 31% cheaper |
| Long | 363,521 / $0.2978 | 512,690 / $0.2593 | 29% fewer tokens, 15% more expensive |

## Why our uncached input is higher on the long task

Each of our long runs had one request where the provider returned no cache at all:

- In run 1, the request at message 16 sent 17,278 uncached tokens and read 0 from cache.
- In run 2, the request at message 30 sent 23,733 uncached tokens and read 0 from cache.

The requests on either side of these misses did read from the cache. I logged a hash of each request we sent. Every request extended the previous one: the prefix stayed the same and only grew. So the misses happened on the provider's side, and nothing our requests changed caused them. They are likely cache-node eviction or routing (inferred, not proven).

Pi had no full miss in its runs. Pi also sends a larger system prompt, about 2.5k tokens against our roughly 750. That puts Pi's prompt over the 1,024-token cache minimum from the first request, while our first two requests are too short to be cached. Pi made 14 requests per long run; we made 11 to 12.

Each full miss costs about $0.03 to $0.04 at this price, which is the whole cost gap. Both sides already send the same prompt cache key (the session id), so this is not a known difference between us and Pi.

## Refusal handoff (live, fixture)

I ran with `--test-refuse-at` so the first model's request returned a synthetic `cyber_policy` refusal mid-task. Run 61282b3d:

- **Handoff:** from codex/gpt-6.1-sol to opencode-go/deepseek-v4.1-flash, reason `cyber`.
- **Cost of the handoff:** the handoff note was 41 tokens. The 10 messages before it, about 1,148 tokens, were kept as they were.
- **Result:** the second model finished in the same conversation and passed 16/16 with 11 tool calls in 26.5 s.
- **Recorded:** the handoff and both models' turns are in agent.db (handoffs, messages, tool_calls).
- **Unit tests:** the handoff keeps the full context (3 messages and the tool output, without the refused response). The end of the chain gives `model_refused`. A plain HTTP error does not count as a refusal. The test hook is off unless it is set.

## Fail closed (live CLI, plus unit tests)

| Case | Outcome | Exit |
|---|---|---:|
| `--role hunting --model fable` | `model_denied`: "Owner 2026-11-01: Claude never for active hunting or recon" | 3 |
| `--role implementation --model fable` | `provider_not_allowed`: Claude is not registered and runs only through `claude -p` | 3 |
| Context database missing | `rules_unreadable` | 3 |
| Context database is not SQLite | `rules_unreadable`: "file is not a database" | 3 |
| Context database has no launch policy | `rules_unreadable` (unit test) | 3 |
| `--role hunting` (egress `contained`) | `unenforceable`: no sandbox in this slice | 3 |
| Guard hook missing, or it fails or prints unreadable output | role `unenforceable`; the bash call is blocked and the hook never runs (unit tests) | 3 |

Anthropic is never registered. The provider collection is built from pi-ai's `createModels` with only the providers the role's chain names.

## Pi API pain found

- **Anthropic gets registered:** `ModelRuntime` registers every built-in provider, including Anthropic. I built the collection with `createModels` plus the two allowed provider factories instead.
- **AuthStorage is not exported:** I used Pi's own stored-credential reader for the sign-in. Refresh stays with `pi auth check`. Our code never reads or logs the token.
- **Only "." is exported:** pi-coding-agent's exports map exposes only the full index, which takes about 520 ms to import, just to get `estimateTokens` and the context-file loader.
- **Wider message type:** `CustomAgentMessages` declaration merging widens `AgentMessage` for every importer.
- **Vulnerable dependencies:** pi-coding-agent 1.4.0 pins minimatch 10.2.6 and undici 8.10.2, which OSV flags. Root overrides now set the versions Pi 1.5.0 ships (minimatch 11.0.3, undici 8.12.3).
- **npm ignores new overrides on an existing lock:** the three lock entries had to match a fresh resolution.

## Not covered

- **No live guard block:** the guard hook ran on every live bash call, but no live call was blocked. The block path is covered only by unit tests.
- **Not wired in:** compaction and sandboxed (`contained`) egress, which this slice refuses.

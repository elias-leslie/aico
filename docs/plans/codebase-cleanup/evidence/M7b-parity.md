# M7b parity: Agent Hub's context delivery vs Aico's

Measured 2026-11-03 on a re-imported copy of context.db (`aico context import-agent-hub`), against
Agent Hub's own renderer: `agent-hub-context-client deliver --surface S --cwd /srv/workspaces/projects/P
--profile agent_startup --capability bash --emit json` vs `aico context deliver --tool T --project P
--format json`. Sections are split by heading; memories compared by id, prompts by title and bytes,
tool-usage by line.

## Section by section (3 projects x 3 tools)

| Project | Tool | Agent Hub bytes | Aico bytes | Prompts (set, order, bytes) | Memories AH/Aico (order) | Tool usage AH/Aico | Recent Activity AH/Aico |
|---|---|---|---|---|---|---|---|
| aico | claude-code | 24161 | 22777 | same, same, identical (7) | 20/20 (same) | 3863/3076 | 597/0 |
| aico | codex | 24161 | 22777 | same, same, identical (7) | 20/20 (same) | 3863/3076 | 597/0 |
| aico | pi | 24161 | 22777 | same, same, identical (7) | 20/20 (same) | 3863/3076 | 597/0 |
| summitflow | claude-code | 22054 | 21315 | same, same, identical (7) | 18/18 (same) | 3816/3076 | 0/0 |
| summitflow | codex | 22054 | 21315 | same, same, identical (7) | 18/18 (same) | 3816/3076 | 0/0 |
| summitflow | pi | 22054 | 21315 | same, same, identical (7) | 18/18 (same) | 3816/3076 | 0/0 |
| agent-hub | claude-code | 23934 | 23570 | same, same, identical (8) | 18/18 (same) | 3076/3076 | 364/0 |
| agent-hub | codex | 23934 | 23570 | same, same, identical (8) | 18/18 (same) | 3076/3076 | 364/0 |
| agent-hub | pi | 23934 | 23570 | same, same, identical (8) | 18/18 (same) | 3076/3076 | 364/0 |

Section order is the same in both: Safety Directive, guardrail memories, narration, web research,
mandate memories, project policy (agent-hub only), coding practice, product UI, platform context,
prompt practice, Recent Activity, tool-usage. No section was cut: the 32768-byte budget per tool
(`packages/context/data/delivery.json`) leaves about 9-10 KB of room in every case.

## Differences, each explained

- **Tool usage, `references:` lines (aico +787, summitflow +740 bytes in Agent Hub).** Agent Hub adds
  1-3 commands from its own usage scores (`st tools manifest --scores-file`): `st lease` and `st status`
  for aico, `st browser check` for summitflow. Aico renders the manifest without scores, so these stay
  out until usage scores move to Aico (M8). agent-hub has no scored extras, so both are identical.
- **Recent Activity (aico 597, agent-hub 364 bytes in Agent Hub).** Agent Hub writes lines from its
  chat summaries, which today are unrelated chats ("Lake Baikal...", "salinity of the oceans").
  Aico lists the project's other named Tether sessions, newest first; few live sessions carry a
  name, so it is empty in this measurement and fills as sessions are named.
- **Pi's optional context switch.** `st aico create --agent-hub-context off` (Pi) turns off Agent
  Hub's optional context. Aico has no optional section, so the switch has nothing to drop there.
- **Codex chosen instructions.** Agent Hub's launcher joins a session's chosen instructions after
  the context with a blank line; Aico does the same in its one `developer_instructions`.

Nothing else differs: same prompts byte for byte, same memories in the same order, same budget.

## Effective context bytes, before and after, per tool

Bytes of context each tool receives at launch, project aico. Claude Code reads it as a CLAUDE.md in an
added directory, Codex as its one `developer_instructions`, Pi as an appended system-prompt file; the
text is the same for all three, so the count is per tool and equal.

| Session | Tool | Before (Agent Hub) | After (Aico) | Why they differ |
|---|---|---|---|---|
| verification root (live, below) | claude-code | 21628 | 20244 | references -787, activity -597 |
| verification root (live, below) | codex | 21628 | 20244 | same |
| verification root (live, below) | pi | 21628 | 20244 | same |
| no work role (parity table) | all three | 24161 | 22777 | same |
| this coordinator's own launch (Agent Hub, 17:34) | claude-code | 24252 | - | started before the cutover |

"Before" for the verification root is Agent Hub's renderer with the same declared role
(`ST_WORK_ROLE=verification ST_WORK_ROLE_SOURCE=tether`): 14 memories, the same 14 in the same order
as Aico's. A verification root drops 6 coordinator memories (e.g. 3a547fbd, e5b6757e) by their own
audience tags in both systems.

## Cutover, one tool at a time

Each tool was switched on alone (`aico context delivery TOOL on`), then a fresh Tether session in
project aico, work role verification, was asked to quote its first rule heading and one memory line
without running tools. Each check session was ended after; its delivery folder went with it.

| Tool (model) | Session | Quoted | `aico context deliver` vs adapter file | Agent Hub stood down |
|---|---|---|---|---|
| claude-code (Haiku 5.5) | 98492512 | "## Safety Directive", "- [G:8aa412ac] Never estimate in human days...", and the path ~/.local/state/aico/deliveries/98492512/CLAUDE.md | CLAUDE.md 20244 bytes, hash 2d948822e8ca, text equal | no Agent Hub delivery folder for the session |
| codex (GPT-6.1 Sol, low) | 4710d1b9 | "- [G:8aa412ac] Never estimate..." verbatim; it declined to quote instruction headings (the model's own rule), so the rule header is shown by the process argv instead: one `developer_instructions`, starting "## Safety Directive" | config.toml value 20244 bytes, hash 2d948822e8ca, text equal | exactly one developer_instructions argument |
| pi (DeepSeek v4.1 Flash) | a313d860 | "## Safety Directive", "- [G:02c79821] The web/phone app is Aico..." | context.md 20244 bytes, hash 2d948822e8ca, text equal | one --append-system-prompt (Aico's file), no Agent Hub Pi delivery, no "AH:" status |

context.db's `deliveries` table holds one `launch` row per check session (bytes 20244, hash
2d948822e8ca), the per-item inventory for M9. Codex shows one startup warning, "command-line
configuration overrides (-c ...) requires embedded mode"; Agent Hub's launcher passed the same `-c`,
so it predates the cutover.

State after the cutover:
- `aico context delivery` reads: claude-code, codex, pi. Tether writes each launch's context to
  ~/.local/state/aico/deliveries/<session>/ and sets `AGENT_HUB_CONTEXT_BYPASS=1`, Agent Hub's own
  knob: its Claude and Codex launchers exec the tool unchanged, its bind hook prints `{}`, and its
  Pi extension adds nothing (agent-hub 5e10561b). Agent Hub's data is untouched and it keeps running.
- Sessions no launch delivered to (a tool started outside Tether and Agent Hub's launchers) get
  Aico's context from aico-hook at session start (`data/hook.json` runs the deployed release's
  `aico context deliver`). After a Tether or Agent Hub launch delivery it prints nothing, and for Pi
  it stays quiet while Agent Hub's extension still delivers, so no session gets two copies. Checked
  with the installed hook: no marker 23284 bytes of context (Safety Directive, G:8aa412ac);
  `AICO_CONTEXT_DELIVERED` or `AGENT_HUB_CONTEXT_PREINJECTED_HASH` set: 0 bytes; Pi without
  `AGENT_HUB_CONTEXT_BYPASS`: no context; with it: the delivery. A headless Claude Code session
  started outside any launcher quoted "## Safety Directive", but Claude Code itself cuts hook
  context to a 2KB preview and saves the rest to a file, so it did not see the memories. Hook
  delivery is therefore only the fallback; Claude Code's real route is the CLAUDE.md folder Tether
  adds. Claude Code and Codex started outside Tether still go through Agent Hub's launchers, which
  stay on for them. The Codex hook path was not run live.
- Roll back one tool: `aico context delivery TOOL off`; its next launch goes back to Agent Hub.

Not moved here: `st memory save` still writes to Agent Hub, so new memories reach Aico on the next
`aico context import-agent-hub` (run at this cutover); usage-score `references:` lines wait for M8.

## Checks

- `st check --acceptance` before: success on 52f3e143. After: the first run on 18342408 failed one
  stage (boundaries: packages/tether/biome.json not regenerated after Tether took @aico/context);
  fixed in dad7cc54, acceptance success on dad7cc54 and again (fresh, by the deploy) on 66f8cc93.
- `st check --quick --changed-only`: pass on every commit's paths (context 22 tests, tether
  delivery conformance 23 tests, go-hook vet and tests).
- Deployed: aico release 66f8cc93 (tether@default restarted onto dad7cc54; 66f8cc93 changes only the CLI and hook), aico-hook e54b76cc9ff5 installed.

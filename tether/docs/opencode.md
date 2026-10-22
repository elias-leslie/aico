# OpenCode free models

Aico and A-Term get these tools from Tether's shared registry:

| Tool | Native model |
| --- | --- |
| `opencode-deepseek-free` | `opencode/deepseek-v4.1-flash-free` |
| `opencode-glm-free` | `opencode/glm-5.3-flash-free` |

Install the official OpenCode v2 CLI and sign in using OpenCode. Install Agent Hub's
adapter with `python3 integrations/context-delivery/install.py --surface opencode`
from the Agent Hub checkout. Its source-linked launcher resolves `opencode` on PATH
or the official `~/.opencode/bin/opencode` installation.

The launcher uses the authenticated OpenCode service, allocates IDs through
`opencode api session.create`, and opens `opencode mini --model` for the selected
model. It never reads provider credentials or changes provider routing. An exact
native `--session` can resume; continue-last and fork are rejected because they can
change the native identity being recorded. These tools are ordinary sessions;
Tether's root resume contract does not yet include OpenCode.

The supported OpenCode v2 plugin appends Agent Hub's canonical context before each
agent model request. Context and ingestion failures leave a visible warning and
preserve native OpenCode operation. Agent Hub records the selection separately
from completed native response model labels and retains native token/cost fields.
A native label does not independently verify the upstream backend model.

Schema v7 widens the context-hook constraint and adds missing model tools. It
preserves all existing operator edits, including a preexisting conflicting slug,
and leaves the default tool as configured. Existing Aico sessions are unaffected.
OpenCode controls free-model availability and limits; these entries select only
the `-free` IDs. Official documentation describes them as free for a limited time.

// Aico's own agent harness (packages/agent): `aico agent run --interactive` in a pane.
// Tether starts it under a run id it picks (`--run-id`, TETHER_AGENT_SESSION_ID) and
// resumes it with `--resume ID`. The process names itself `aico-agent`. Its state is
// what it pushes to the session history (`PUT /v1/history/aico-agent/:run`): an open
// run while a prompt runs, an ended one while it waits for the next prompt. Tether
// never reads the agent's own database.

import type { AgentSignal } from '../../../agent-signal'
import {
  type AgentObservation,
  observeChosenSession,
  type ProcFs,
  UUID_RE,
} from '../../../proc-facts'
import type { AgentProbe, AgentRunLookup, TuiAdapter } from './contract'

const AICO_AGENT_PROCESS = 'aico-agent'

/** The run's state: no row yet is the agent at its first prompt, an open row a prompt running. */
function agentRunSignal(row: ReturnType<AgentRunLookup>, runId: string): AgentSignal {
  const base = { source: 'agent-push', detail: null, agentSessionId: runId }
  if (!row) return { ...base, state: 'idle', at: null }
  if (row.endedAt === null) return { ...base, state: 'working', at: row.startedAt }
  return { ...base, state: 'idle', at: row.endedAt }
}

/** The aico-agent process among `pids` and the run id Tether chose for it. */
function findAgentRun(fs: ProcFs, pids: number[]): AgentObservation | null {
  for (const pid of pids) {
    let comm: string
    try {
      comm = fs.readFile(`/proc/${pid}/comm`).trim()
    } catch {
      continue
    }
    if (comm !== AICO_AGENT_PROCESS) continue
    const chosen = observeChosenSession(fs, [pid])
    if (chosen) return chosen
  }
  return null
}

class AgentRunProbe implements AgentProbe {
  constructor(
    readonly pid: number,
    readonly runId: string,
    private readonly lookup: AgentRunLookup | undefined,
  ) {}

  poll(): AgentSignal | null {
    return this.lookup ? agentRunSignal(this.lookup(this.runId), this.runId) : null
  }
}

export const aicoAgent: TuiAdapter = {
  id: 'aico-agent',
  harness: 'aico-agent',
  seed: {
    slug: 'aico-agent',
    name: 'Aico agent',
    // The role comes from the root's ST_WORK_ROLE.
    argv: ['aico', 'agent', 'run', '--interactive'],
    processName: AICO_AGENT_PROCESS,
    description: "Aico's own harness: a role's non-Claude models",
    color: '#5FA8A0',
    displayOrder: 5,
    isDefault: false,
    enabled: true,
    aliases: [],
    contextHook: null,
  },
  launch: { ensureArgs: [] },
  spec: {
    resume: { sessionIdPattern: UUID_RE, arguments: ['--resume'], freshArguments: ['--run-id'] },
    modelSelection: { model: ['--model'], reasoningEffort: { arguments: ['--effort'] } },
  },
  capabilities: {
    root: true,
    blankSlate: false,
    instructions: false,
    entry: false,
    entryDefault: false,
    rewind: false,
    stateHooks: false,
    modelWatch: false,
    transcriptFacts: false,
    threadSubagents: false,
    nativeAdmin: false,
    environmentSelection: false,
    delivery: { idlePaste: true, nextTurn: false, toolResult: false },
  },
  entryApiVersion: null,
  state: {
    find: (ctx) => {
      const found = findAgentRun(ctx.fs, ctx.pids)
      return found ? new AgentRunProbe(found.pid, found.resumeId, ctx.runs) : null
    },
    // `--resume ID` of a run that never got a prompt starts it fresh under that id.
    observe: (fs, _home, pids) => findAgentRun(fs, pids),
  },
  context: {
    // Never looked up: the tool row has no context hook. The agent loads the project's
    // context files itself.
    kind: { kind: 'blank-slate' },
    check: async () => ({
      state: 'not_applicable',
      detail: 'The Aico agent loads the project context files itself.',
    }),
  },
  hooks: { provider: null, rideAlong: [], stateReports: [], installs: [] },
  login: { signIn: null, signOut: null },
  models: null,
  sessionFile: null,
  displayName: 'Aico agent',
}

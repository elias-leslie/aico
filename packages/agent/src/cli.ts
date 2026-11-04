// `aico agent run --role R [--model M] [--effort E] [--json] "<task>"`, in the current folder.

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { contextDbPath } from '@aico/context'
import type { Models } from '@earendil-works/pi-ai'
import { loadRoleRules, type Refused, type RoleRules, type RulesRequest } from './rules'
import { type RunResult, runAgent } from './run'
import { agentDbPath, openAgentDb } from './transcript'

export const USAGE = `Usage: aico agent run --role ROLE [--model MODEL] [--effort LEVEL] [--json] "<task>"
Runs the task in the current folder on Aico's own harness. The role's rules in the context database
pick the model chain (or allow --model) and the tools; nothing runs if they can't be read.
  --role ROLE       a role from aico models route (implementation, review, ...)
  --model MODEL     a model the role allows (aico models list)
  --effort LEVEL    thinking level for every model (default: the role's effort)
  --json            print the result as JSON instead of the final answer
Settings: AICO_DATA_DIR (the context database and agent.db; default ~/.local/state/aico).
Test hook: --test-refuse-at N (or AICO_AGENT_TEST_REFUSE_AT=N) makes the Nth request to the
first model return a refusal, to exercise the handoff.`

/** Exit codes: 0 done, 1 error, 2 usage, 3 refused by the rules, 4 the model refused or was swapped. */
const EXIT: Record<string, number> = {
  done: 0,
  error: 1,
  refused: 3,
  model_refused: 4,
  model_swap: 4,
}

export function dataDir(env: NodeJS.ProcessEnv): string {
  return resolve(
    env.AICO_DATA_DIR?.trim() ||
      join(env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state'), 'aico'),
  )
}

/** What tests swap out: the rules source and the provider collection. */
export interface CliDeps {
  rules?: (dbPath: string, request: RulesRequest) => RoleRules | Refused
  models?: Models
  cwd?: string
}

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  deps: CliDeps = {},
): Promise<number> {
  let parsed: ReturnType<typeof parse>
  try {
    parsed = parse(argv)
  } catch (error) {
    process.stderr.write(`aico agent: ${(error as Error).message}\n${USAGE}\n`)
    return 2
  }
  const { values, positionals } = parsed
  if (values.help || positionals[0] !== 'run') {
    process.stderr.write(`${USAGE}\n`)
    return values.help ? 0 : 2
  }
  const task = positionals.slice(1).join(' ').trim()
  if (!values.role || !task) {
    process.stderr.write(`aico agent run: --role and a task are required\n${USAGE}\n`)
    return 2
  }
  const fromEnv = values['test-refuse-at'] === undefined && Boolean(env.AICO_AGENT_TEST_REFUSE_AT)
  const refuseAt =
    Number(values['test-refuse-at'] ?? env.AICO_AGENT_TEST_REFUSE_AT ?? 0) || undefined
  if (refuseAt && fromEnv)
    process.stderr.write(
      `aico agent: AICO_AGENT_TEST_REFUSE_AT=${refuseAt} is set: request ${refuseAt} to the first model gets a synthetic refusal\n`,
    )

  const dir = dataDir(env)
  const cwd = deps.cwd ?? process.cwd()
  const rules = (deps.rules ?? loadRoleRules)(contextDbPath(dir), {
    role: values.role,
    cwd,
    ...(values.model && { model: values.model }),
  })
  if ('kind' in rules) {
    const out = { outcome: rules }
    process.stdout.write(values.json ? `${JSON.stringify(out)}\n` : '')
    process.stderr.write(`aico agent: refused (${rules.reason}): ${rules.detail}\n`)
    return EXIT.refused as number
  }

  let result: RunResult
  try {
    const db = openAgentDb(agentDbPath(dir))
    try {
      result = await runAgent({
        rules,
        task,
        cwd,
        db,
        ...(values.effort && { effort: values.effort }),
        ...(refuseAt && { testRefuseAt: refuseAt }),
        ...(deps.models && { models: deps.models }),
        log: (line) => process.stderr.write(`· ${line}\n`),
      })
    } finally {
      db.close()
    }
  } catch (error) {
    const detail = (error as Error)?.message ?? String(error)
    if (values.json)
      process.stdout.write(`${JSON.stringify({ outcome: { kind: 'error', detail } })}\n`)
    process.stderr.write(`aico agent: error: ${detail}\n`)
    return EXIT.error as number
  }
  const { outcome } = result
  if (values.json) process.stdout.write(`${JSON.stringify(result)}\n`)
  else if (outcome.kind === 'done') process.stdout.write(`${outcome.text}\n`)
  const t = result.tokens
  process.stderr.write(
    `aico agent: ${outcome.kind}${'model' in outcome ? ` on ${outcome.model}` : ''}; run ${result.runId}; ` +
      `tokens in ${t.input} / cache ${t.cache_read} / out ${t.output}; ${result.toolCalls} tool calls; ` +
      `${(result.wallMs / 1000).toFixed(1)} s${result.handoffs.length ? `; ${result.handoffs.length} handoff(s)` : ''}\n`,
  )
  if (outcome.kind !== 'done') process.stderr.write(`aico agent: ${JSON.stringify(outcome)}\n`)
  return EXIT[outcome.kind] ?? 1
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      role: { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      'test-refuse-at': { type: 'string' },
    },
  })
}

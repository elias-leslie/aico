// `aico agent run|show`: a run in the current folder on Aico's own harness, resumed or
// branched from agent.db, and what a stored run did turn by turn.

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { contextDbPath } from '@aico/context'
import type { Database } from '@aico/store'
import type { Models } from '@earendil-works/pi-ai'
import { type NextPrompt, promptReader } from './prompt'
import { loadRoleRules, type Refused, type RoleRules, type RulesRequest } from './rules'
import { type RunOptions, type RunResult, runAgent } from './run'
import { type PushRun, tetherPush } from './tether'
import { agentDbPath, findRun, openAgentDb, runReport, type StoredRun } from './transcript'

export const USAGE = `Usage:
  aico agent run --role ROLE [--model MODEL] [--effort LEVEL] [--json] "<task>"
  aico agent run --resume RUN ["<prompt>"]      go on in a stored run (no prompt: finish its last turn)
  aico agent run --branch RUN@TURN "<prompt>"   a new run from RUN's conversation up to the end of TURN
  aico agent run --interactive [--role ROLE] ["<task>"]  after each answer, wait for the next prompt
                                                (Enter or a paste); Ctrl-D ends. How Tether runs it.
  aico agent show RUN [--json]                  a stored run: outcome, tokens, and which model ran each turn
Runs the task in the current folder (a resumed or branched run: in its own folder) on Aico's
own harness. The role's rules in the context database pick the model chain (or allow --model)
and the tools; nothing runs if they can't be read. A refused or failed turn goes to the next
model in the chain. RUN is a run id or its start (printed after every run).
  --role ROLE       a role from aico models route (implementation, review, hunting, ...);
                    default $ST_WORK_ROLE, or the stored run's role
  --model MODEL     a model the role allows (aico models list)
  --effort LEVEL    thinking level for every model (default: the role's effort)
  --run-id UUID     the id of a new run (Tether picks one)
  --json            print the result as JSON instead of the final answer
Settings: AICO_DATA_DIR (the context database and agent.db; default ~/.local/state/aico).
Test hooks: --test-refuse-at N (or AICO_AGENT_TEST_REFUSE_AT=N) makes the Nth request to the
first model return a refusal, to exercise the handoff; --test-unreachable MODEL sends that
chain model to an address that refuses connections, to exercise the fallback.`

/** Exit codes: 0 done, 1 error, 2 usage, 3 refused by the rules, 4 the model refused or was swapped. */
const EXIT: Record<string, number> = {
  done: 0,
  error: 1,
  refused: 3,
  model_refused: 4,
  model_swap: 4,
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  /** The interactive prompt (default: stdin). */
  prompt?: NextPrompt
  /** Tells Tether about a run at its start and end (default: over Tether's socket). */
  push?: PushRun
}

class Usage extends Error {}

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
  const verb = positionals[0]
  if (values.help || (verb !== 'run' && verb !== 'show')) {
    process.stderr.write(`${USAGE}\n`)
    return values.help ? 0 : 2
  }
  const dir = dataDir(env)
  if (verb === 'show') return show(dir, positionals[1], Boolean(values.json))

  const task = positionals.slice(1).join(' ').trim()
  const usage = usageError(values, task, env)
  if (usage) {
    process.stderr.write(`aico agent run: ${usage}\n${USAGE}\n`)
    return 2
  }
  let db: Database
  try {
    db = openAgentDb(agentDbPath(dir))
  } catch (error) {
    return failed(values.json, error)
  }
  try {
    let request: Omit<RunOptions, 'rules' | 'db' | 'cwd'> & { role: string; cwd: string }
    try {
      request = runRequest(values, task, env, db, deps)
    } catch (error) {
      if (!(error instanceof Usage)) throw error
      process.stderr.write(`aico agent run: ${error.message}\n${USAGE}\n`)
      return 2
    }
    const rules = (deps.rules ?? loadRoleRules)(contextDbPath(dir), {
      role: request.role,
      cwd: request.cwd,
      ...(values.model && { model: values.model }),
    })
    if ('kind' in rules) {
      process.stdout.write(values.json ? `${JSON.stringify({ outcome: rules })}\n` : '')
      process.stderr.write(`aico agent: refused (${rules.reason}): ${rules.detail}\n`)
      return EXIT.refused as number
    }
    const log = (line: string) => process.stderr.write(`· ${line}\n`)
    const push = deps.push ?? tetherPush(env, log)
    const tell = (runId: string) => push(runReport(db, runId))
    const once = async (task: string | null) => {
      const result = await runAgent({
        ...request,
        task,
        rules,
        db,
        ...(deps.models && { models: deps.models }),
        log,
        onStart: tell,
      })
      await tell(result.runId)
      return result
    }
    if (!values.interactive) return report(await once(request.task), Boolean(values.json))
    return await interactive(request, once, db, deps.prompt)
  } catch (error) {
    return failed(values.json, error)
  } finally {
    db.close()
  }
}

/**
 * Runs, then waits for the next prompt and goes on in the same run, until the input ends.
 * A fresh run with no task waits for its first prompt; a resumed run whose last turn did
 * not finish (the process stopped mid-run) finishes it first.
 */
async function interactive(
  request: { task: string | null; resume?: StoredRun; runId?: string },
  once: (task: string | null) => Promise<RunResult>,
  db: Database,
  prompt?: NextPrompt,
): Promise<number> {
  const reader = prompt ? null : promptReader(process.stdin, process.stdout)
  const next = prompt ?? (reader as NonNullable<typeof reader>).next
  let task = request.task
  let pending = task !== null || (request.resume !== undefined && request.resume.ended_at === null)
  let code = 0
  try {
    for (;;) {
      if (!pending) {
        task = await next()
        if (task === null) return code
      }
      pending = false
      const result = await once(task)
      code = report(result, false)
      // Every later prompt goes on in this run.
      const run = db.prepare('SELECT 1 FROM runs WHERE id = ?').get(result.runId)
      if (run) {
        request.resume = findRun(db, result.runId)
        delete request.runId
        delete (request as { branch?: unknown }).branch
      }
    }
  } finally {
    reader?.close()
  }
}

function failed(json: boolean | undefined, error: unknown): number {
  const detail = (error as Error)?.message ?? String(error)
  if (json) process.stdout.write(`${JSON.stringify({ outcome: { kind: 'error', detail } })}\n`)
  process.stderr.write(`aico agent: error: ${detail}\n`)
  return EXIT.error as number
}

const BRANCH = /^(.+)@(\d+)$/

/** What is wrong with the command line before anything is opened, or null. */
function usageError(
  values: ReturnType<typeof parse>['values'],
  task: string,
  env: NodeJS.ProcessEnv,
): string | null {
  if (values.resume && values.branch) return '--resume and --branch do not go together'
  if (values.interactive && values.json) return '--interactive and --json do not go together'
  if (values['run-id'] && !UUID.test(values['run-id'])) return '--run-id takes a UUID'
  if (values.branch && !BRANCH.test(values.branch)) return '--branch takes RUN@TURN'
  if (!task && !values.resume && !values.interactive) return '--role and a task are required'
  if (!values.role && !values.resume && !values.branch && !env.ST_WORK_ROLE?.trim())
    return '--role and a task are required'
  return null
}

/** The run to start from the command line: new, resumed or branched. */
function runRequest(
  values: ReturnType<typeof parse>['values'],
  task: string,
  env: NodeJS.ProcessEnv,
  db: Database,
  deps: CliDeps,
): Omit<RunOptions, 'rules' | 'db' | 'cwd'> & { role: string; cwd: string } {
  let stored: StoredRun | undefined
  let branchTurn: number | undefined
  // Tether resumes a session by the run id it chose; a run that never got a prompt has no
  // row yet, so it starts fresh under that id.
  const unstarted =
    values.interactive &&
    values.resume !== undefined &&
    UUID.test(values.resume) &&
    !db.prepare('SELECT 1 FROM runs WHERE id = ?').get(values.resume)
  if (values.resume && !unstarted) stored = findRun(db, values.resume)
  else if (values.branch) {
    const match = BRANCH.exec(values.branch) as RegExpExecArray
    stored = findRun(db, match[1] as string)
    branchTurn = Number(match[2])
  }
  const role = (values.role || stored?.role || env.ST_WORK_ROLE?.trim()) as string
  if (stored && role !== stored.role)
    throw new Usage(`run ${stored.id} is a '${stored.role}' run; it goes on in that role`)

  const fromEnv = values['test-refuse-at'] === undefined && Boolean(env.AICO_AGENT_TEST_REFUSE_AT)
  const refuseAt =
    Number(values['test-refuse-at'] ?? env.AICO_AGENT_TEST_REFUSE_AT ?? 0) || undefined
  if (refuseAt && fromEnv)
    process.stderr.write(
      `aico agent: AICO_AGENT_TEST_REFUSE_AT=${refuseAt} is set: request ${refuseAt} to the first model gets a synthetic refusal\n`,
    )
  return {
    role,
    cwd: stored?.cwd ?? deps.cwd ?? process.cwd(),
    task: task || null,
    ...(values.resume && stored && { resume: stored }),
    ...(branchTurn !== undefined && stored && { branch: { from: stored, turn: branchTurn } }),
    ...(values['run-id'] && { runId: values['run-id'] }),
    ...(unstarted && { runId: values.resume }),
    ...(values.effort && { effort: values.effort }),
    ...(refuseAt && { testRefuseAt: refuseAt }),
    ...(values['test-unreachable'] && { testUnreachable: values['test-unreachable'] }),
  }
}

function report(result: RunResult, json: boolean): number {
  const { outcome } = result
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`)
  else if (outcome.kind === 'done') process.stdout.write(`${outcome.text}\n`)
  const t = result.tokens
  const extra = [
    result.handoffs.length && `${result.handoffs.length} handoff(s)`,
    result.compactions && `${result.compactions} compaction(s)`,
  ].filter(Boolean)
  process.stderr.write(
    `aico agent: ${outcome.kind}${'model' in outcome ? ` on ${outcome.model}` : ''}; run ${result.runId}; ` +
      `tokens in ${t.input} / cache ${t.cache_read} / out ${t.output}; ${result.toolCalls} tool calls; ` +
      `${(result.wallMs / 1000).toFixed(1)} s${extra.length ? `; ${extra.join('; ')}` : ''}\n`,
  )
  if (outcome.kind !== 'done') process.stderr.write(`aico agent: ${JSON.stringify(outcome)}\n`)
  return EXIT[outcome.kind] ?? 1
}

/** `aico agent show RUN`: the run, then one line per turn with the model that ran it. */
function show(dir: string, id: string | undefined, json: boolean): number {
  if (!id) {
    process.stderr.write(`aico agent show: a run id is required\n${USAGE}\n`)
    return 2
  }
  let db: Database
  try {
    db = openAgentDb(agentDbPath(dir))
  } catch (error) {
    return failed(json, error)
  }
  try {
    const run = findRun(db, id) as StoredRun & Record<string, unknown>
    const turns = db
      .prepare(
        "SELECT turn, model, stop_reason, outcome FROM messages WHERE run_id = ? AND role = 'assistant' ORDER BY seq",
      )
      .all(run.id) as {
      turn: number | null
      model: string
      stop_reason: string
      outcome: string | null
    }[]
    const handoffs = db
      .prepare(
        'SELECT from_model, to_model, reason, at FROM handoffs WHERE run_id = ? ORDER BY seq',
      )
      .all(run.id)
    const compactions = (
      db
        .prepare("SELECT count(*) AS n FROM messages WHERE run_id = ? AND role = 'compaction'")
        .get(run.id) as { n: number }
    ).n
    if (json) {
      process.stdout.write(`${JSON.stringify({ run, turns, handoffs, compactions })}\n`)
      return 0
    }
    const lines = [
      `run ${run.id} (${run.role}) in ${run.cwd}`,
      run.parent_id ? `branched from ${run.parent_id} at turn ${run.branch_turn}` : null,
      `outcome ${run.outcome ?? 'running'}; tokens in ${run.input} / cache ${run.cache_read} / out ${run.output}; ${run.tool_calls} tool calls; ${compactions} compaction(s)`,
      ...turns.map((row) => {
        const outcome = row.outcome ? (JSON.parse(row.outcome) as { kind?: string }).kind : null
        return `  turn ${row.turn ?? '?'}  ${row.model}  ${row.stop_reason}${outcome ? ` (${outcome})` : ''}`
      }),
      ...(handoffs as { from_model: string; to_model: string; reason: string }[]).map(
        (row) => `  handoff ${row.from_model} -> ${row.to_model} (${row.reason})`,
      ),
    ].filter(Boolean)
    process.stdout.write(`${lines.join('\n')}\n`)
    return 0
  } catch (error) {
    return failed(json, error)
  } finally {
    db.close()
  }
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      role: { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
      resume: { type: 'string' },
      branch: { type: 'string' },
      'run-id': { type: 'string' },
      json: { type: 'boolean' },
      interactive: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      'test-refuse-at': { type: 'string' },
      'test-unreachable': { type: 'string' },
    },
  })
}

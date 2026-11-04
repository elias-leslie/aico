// `aico ask MODEL "question"`: one question to one model, no tools, an answer or a typed
// failure. The model goes through the same rules as a run (route() deny rows for the
// role and project, the harness's provider allowlist). Claude runs only as `claude -p`
// with tools off and never with an Anthropic API key; Gemini runs as `agy -p`; Codex and
// the OpenCode Go models run through pi-ai with the harness's providers. The only time
// bound is on wire silence (data/harness.json, `ask`): that long with no bytes from the
// model means a dead connection and the call stops. With --schema the answer is checked
// against the schema (src/schema.ts) and a mismatch is a failure, not an answer.

import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { Catalog, contextDbPath, route } from '@aico/context'
import type { AssistantMessage, Models } from '@earendil-works/pi-ai'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { dataDir } from './cli'
import { type ModelRefusal, type ModelSwap, refusalOf, swapOf } from './outcomes'
import { allowedModels, sessionHeaders } from './providers'
import {
  type ContextRules,
  HARNESS,
  type Harness,
  projectFor,
  projectGap,
  type Refused,
  readPolicy,
} from './rules'
import { thinking } from './run'
import { jsonIn, schemaErrors, unsupportedKeywords } from './schema'
import { credentialMarkers } from './tools'

export const ASK_USAGE = `Usage: aico ask MODEL "question" [--schema FILE] [--files FILE...] [--role ROLE] [--effort LEVEL] [--json]
Asks one model one question, with no tools. The answer goes to stdout.
  MODEL           a model from aico models list (an alias works)
  question        the question; "-" reads it from stdin
  --schema FILE   a JSON Schema file: the answer must be JSON that fits it, or the call fails
  --files FILE... text files put in front of the question (credential files are refused)
  --role ROLE     the role whose launch rules and deny rows apply (default: lookup)
  --effort LEVEL  thinking level (default: the model's own; pi-ai models: medium)
  --json          print the whole outcome as JSON
Claude runs as claude -p with tools off, Gemini as agy, Codex through Aico's harness; the
Anthropic API is never called. The only time limit is wire silence (5 min with no bytes).
Exit: 0 answered, 1 error or silent connection, 2 usage, 3 refused by the rules,
4 the model refused or was swapped, 5 the answer did not fit --schema.`

export type AskOutcome =
  | { kind: 'done'; model: string; text: string; data?: unknown }
  | Refused
  | { kind: 'model_refused'; model: string; refusal: ModelRefusal }
  | ModelSwap
  | { kind: 'silent'; model: string; seconds: number }
  | { kind: 'tool_denied'; model: string; detail: string }
  | { kind: 'schema_invalid'; model: string; errors: string[]; text: string }
  | { kind: 'bad_input'; detail: string }
  | { kind: 'error'; model: string; detail: string }

export interface AskResult {
  outcome: AskOutcome
  tokens: { input: number; output: number }
  wallMs: number
}

export interface AskRequest {
  model: string
  question: string
  schema?: unknown
  files?: string[]
  role?: string
  effort?: string
  cwd: string
}

/** What tests swap out. */
export interface AskDeps {
  /** The launch policy and projects (default: the context database). */
  context?: ContextRules | Refused
  /** The pi-ai providers (default: the harness's allowed ones with Pi's credentials). */
  models?: Models
  /** The claude and agy commands. */
  bins?: { claude?: string; agy?: string }
  harness?: Harness
  catalog?: Catalog
  /** Wire silence in ms (default: harness.json). */
  silenceMs?: number
}

const NO_TOKENS = { input: 0, output: 0 }

/** The CLI path of a claude call must never reach the Anthropic API: these variables would send it there. */
const API_ENV = /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH)/

/** Whether `path` is a file whose content must not go to a model: a credential path or an env/key file. */
function credentialFile(path: string, markers: readonly string[]): boolean {
  const name = basename(path)
  if (name === '.env' || name.startsWith('.env.') || /\.(pem|key|p12|pfx)$/i.test(name)) return true
  return markers.some(
    (marker) => resolve(marker) === path || path.startsWith(`${resolve(marker)}${sep}`),
  )
}

/** The files as text blocks, or why one cannot be sent. */
export function fileBlocks(
  files: readonly string[],
  cwd: string,
  harness: Harness,
): { text: string } | { error: string } {
  const markers = credentialMarkers([getAgentDir(), ...harness.credential_paths], homedir()).filter(
    (marker) => marker.startsWith('/'),
  )
  const blocks: string[] = []
  let total = 0
  for (const file of files) {
    const asked = resolve(cwd, file)
    if (credentialFile(asked, markers))
      return { error: `${file}: a credential or key file is never sent to a model` }
    let real: string
    try {
      real = realpathSync(asked)
    } catch {
      return { error: `${file}: no such file` }
    }
    if (credentialFile(real, markers))
      return { error: `${file}: a credential or key file is never sent to a model` }
    if (!statSync(real).isFile()) return { error: `${file}: not a file` }
    const data = readFileSync(real)
    total += data.length
    if (total > harness.ask.max_file_bytes)
      return { error: `the files are over ${harness.ask.max_file_bytes} bytes together` }
    if (data.includes(0)) return { error: `${file}: not a text file` }
    blocks.push(`<file path="${file}">\n${data.toString('utf8')}\n</file>`)
  }
  return { text: blocks.join('\n\n') }
}

interface CliRun {
  lines: string[]
  code: number | null
  silent: boolean
  stderr: string
  missing: boolean
}

/** Runs a command and keeps its output lines; no byte on stdout or stderr for `silenceMs` kills it. */
function runCli(
  bin: string,
  args: string[],
  stdin: string | null,
  env: NodeJS.ProcessEnv,
  cwd: string,
  silenceMs: number,
): Promise<CliRun> {
  return new Promise((done) => {
    const out: CliRun = { lines: [], code: null, silent: false, stderr: '', missing: false }
    let child: ChildProcess
    try {
      child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    } catch (error) {
      out.missing = true
      out.stderr = (error as Error).message
      done(out)
      return
    }
    let timer: NodeJS.Timeout
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        out.silent = true
        // The whole group: the command's own children hold its pipes open.
        try {
          process.kill(-(child.pid as number), 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
        done(out)
      }, silenceMs)
    }
    arm()
    let buffer = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      arm()
      buffer += chunk.toString('utf8')
      const parts = buffer.split('\n')
      buffer = parts.pop() as string
      out.lines.push(...parts)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      arm()
      out.stderr = (out.stderr + chunk.toString('utf8')).slice(-4000)
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      out.missing = error.code === 'ENOENT'
      out.stderr = error.message
      done(out)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (buffer) out.lines.push(buffer)
      out.code = code
      done(out)
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(stdin ?? '')
  })
}

const jsonLines = (lines: readonly string[]): Record<string, unknown>[] =>
  lines.flatMap((line) => {
    try {
      const value = JSON.parse(line)
      return value && typeof value === 'object' ? [value as Record<string, unknown>] : []
    } catch {
      return []
    }
  })

const num = (value: unknown) => (typeof value === 'number' ? value : 0)

interface Answer {
  outcome: { text: string; data?: unknown } | Exclude<AskOutcome, { kind: 'done' }>
  tokens: { input: number; output: number }
}

function failed(model: string, detail: string, tokens = NO_TOKENS): Answer {
  return { outcome: { kind: 'error', model, detail }, tokens }
}

function silentOutcome(model: string, ms: number): Answer {
  return { outcome: { kind: 'silent', model, seconds: Math.round(ms / 1000) }, tokens: NO_TOKENS }
}

/** `claude -p` with tools, settings, MCP and sessions off, and no API key in its environment. */
async function viaClaude(
  entry: { id: string },
  prompt: string,
  req: AskRequest,
  schema: unknown,
  deps: AskDeps,
  silenceMs: number,
  scratch: string,
): Promise<Answer> {
  const args = [
    '-p',
    '--model',
    entry.id,
    '--output-format',
    'stream-json',
    '--verbose',
    '--safe-mode',
    '--disable-slash-commands',
    '--exclude-dynamic-system-prompt-sections',
    '--tools',
    '',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
  ]
  if (req.effort) args.push('--effort', req.effort)
  if (schema !== undefined) args.push('--json-schema', JSON.stringify(schema))
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !API_ENV.test(k)))
  const run = await runCli(deps.bins?.claude ?? 'claude', args, prompt, env, scratch, silenceMs)
  if (run.silent) return silentOutcome(entry.id, silenceMs)
  if (run.missing) return failed(entry.id, 'the claude command is not installed')
  const result = jsonLines(run.lines)
    .reverse()
    .find((line) => line.type === 'result')
  if (!result)
    return failed(
      entry.id,
      `claude -p ended without a result (exit ${run.code}): ${run.stderr.trim()}`,
    )
  const usage = (result.usage ?? {}) as Record<string, unknown>
  const tokens = {
    input: num(usage.input_tokens) + num(usage.cache_read_input_tokens),
    output: num(usage.output_tokens),
  }
  if (result.is_error || result.subtype !== 'success')
    return failed(
      entry.id,
      `claude -p: ${String(result.result ?? result.subtype ?? 'failed')}`,
      tokens,
    )
  if (result.stop_reason === 'refusal')
    return {
      outcome: {
        kind: 'model_refused',
        model: entry.id,
        refusal: { kind: 'refusal', category: 'refusal', detail: String(result.result ?? '') },
      },
      tokens,
    }
  const served = Object.keys((result.modelUsage ?? {}) as object)
  const swap =
    served.length &&
    served.every((name) => swapOf({ responseModel: name } as AssistantMessage, entry.id))
      ? swapOf({ responseModel: served[0] } as AssistantMessage, entry.id)
      : null
  if (swap) return { outcome: swap, tokens }
  const text = String(result.result ?? '')
  return { outcome: { text, data: result.structured_output }, tokens }
}

/** `agy -p`: its tools are denied in headless mode, so an answer that needed one is a typed failure. */
async function viaAgy(
  entry: { id: string },
  prompt: string,
  req: AskRequest,
  schema: unknown,
  deps: AskDeps,
  silenceMs: number,
  scratch: string,
): Promise<Answer> {
  const args = ['-p', prompt, '--model', entry.id, '--output-format', 'stream-json']
  if (req.effort) args.push('--effort', req.effort)
  if (schema !== undefined) args.push('--json-schema', JSON.stringify(schema))
  const run = await runCli(deps.bins?.agy ?? 'agy', args, null, process.env, scratch, silenceMs)
  if (run.silent) return silentOutcome(entry.id, silenceMs)
  if (run.missing) return failed(entry.id, 'the agy command is not installed')
  const found = jsonLines(run.lines)
    .reverse()
    .find((line) => line.event === 'result')
  const result = found?.result as Record<string, unknown> | undefined
  if (!result)
    return failed(entry.id, `agy ended without a result (exit ${run.code}): ${run.stderr.trim()}`)
  const usage = (result.usage ?? {}) as Record<string, unknown>
  const tokens = { input: num(usage.input_tokens), output: num(usage.output_tokens) }
  const response = String(result.response ?? '')
  const denied = result.denied_actions as { display_name?: string; action?: string }[] | undefined
  if (!response.trim() && denied?.length)
    return {
      outcome: {
        kind: 'tool_denied',
        model: entry.id,
        detail: `the model tried to use a tool (${denied.map((d) => d.display_name ?? d.action).join(', ')}) and has none here`,
      },
      tokens,
    }
  if (result.status !== 'SUCCESS')
    return failed(entry.id, `agy: ${String(result.status ?? 'failed')} ${response}`.trim(), tokens)
  return { outcome: { text: response, data: result.structured_output }, tokens }
}

const CLAUDE_API = 'anthropic-messages'

/** pi-ai: a stream with no event for `silenceMs` is aborted. */
async function viaPi(
  entry: { id: string; provider: string },
  prompt: string,
  system: string,
  req: AskRequest,
  deps: AskDeps,
  harness: Harness,
  silenceMs: number,
): Promise<Answer> {
  const provider = (harness.providers as Record<string, string>)[entry.provider] as string
  const name = entry.id.startsWith(`${entry.provider}/`)
    ? entry.id.slice(entry.provider.length + 1)
    : entry.id
  const models = deps.models ?? allowedModels([provider])
  const model = models.getModel(provider, name)
  if (!model) return failed(entry.id, `provider ${provider} has no model ${name}`)
  if (model.api === CLAUDE_API)
    return {
      outcome: {
        kind: 'refused',
        reason: 'provider_not_allowed',
        detail: `${entry.id}: it speaks ${CLAUDE_API}; Claude runs only through claude -p`,
      },
      tokens: NO_TOKENS,
    }
  const level = thinking(model, req.effort ?? 'medium')
  const controller = new AbortController()
  let silent = false
  let timer: NodeJS.Timeout | undefined
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      silent = true
      controller.abort()
    }, silenceMs)
  }
  arm()
  try {
    const stream = models.streamSimple(
      model,
      {
        systemPrompt: system,
        messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      },
      {
        signal: controller.signal,
        headers: sessionHeaders(provider, randomUUID()),
        ...(level !== 'off' && { reasoning: level }),
      },
    )
    for await (const _event of stream) arm()
    const message = await stream.result()
    if (silent) return silentOutcome(entry.id, silenceMs)
    const tokens = {
      input: message.usage.input + message.usage.cacheRead,
      output: message.usage.output,
    }
    const refusal = refusalOf(message, harness)
    if (refusal) return { outcome: { kind: 'model_refused', model: entry.id, refusal }, tokens }
    if (message.stopReason === 'error' || message.stopReason === 'aborted')
      return failed(entry.id, message.errorMessage ?? message.stopReason, tokens)
    const swap = swapOf(message, name)
    if (swap) return { outcome: swap, tokens }
    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('')
    return { outcome: { text }, tokens }
  } catch (error) {
    if (silent) return silentOutcome(entry.id, silenceMs)
    return failed(entry.id, (error as Error).message)
  } finally {
    clearTimeout(timer)
  }
}

/** The refusal for a model this role may not ask, or the catalog entry and how it runs. */
function resolveModel(
  context: ContextRules,
  catalog: Catalog,
  harness: Harness,
  role: string,
  project: string | undefined,
  model: string,
): { entry: NonNullable<ReturnType<Catalog['get']>>; run: string } | Refused {
  const refuse = (reason: Refused['reason'], detail: string): Refused => ({
    kind: 'refused',
    reason,
    detail,
  })
  const { policy } = context
  if (!policy.jobs.some((job) => job.name === role || job.workRoles.includes(role)))
    return refuse('unknown_role', `unknown role '${role}'`)
  if (!project) {
    const gap = projectGap(policy, role)
    if (gap) return gap
  }
  const entry = catalog.get(model)
  if (!entry) return refuse('model_unknown', `'${model}' is not in Aico's model list`)
  const row = route(policy, catalog, {
    role,
    tool: harness.launch_tool,
    model: entry.id,
    ...(project && { project }),
  }).rows[0]
  if (!row) return refuse('rules_unreadable', `no launch row for role '${role}'`)
  if (row.deny_reason) return refuse('model_denied', `${entry.id}: ${row.deny_reason}`)
  const via = (harness.ask.via as Record<string, { run: string }>)[entry.provider]
  if (!via)
    return refuse(
      'provider_not_allowed',
      `${entry.id}: aico ask does not run ${entry.provider} models`,
    )
  const claude = policy.providers[harness.claude_provider]
  const names = [entry.id, model].map((name) => name.toLowerCase())
  const isClaude =
    entry.provider === harness.claude_provider ||
    claude?.nameTokens.some((token) => names.some((name) => name.includes(token)))
  // Claude only runs through claude -p; a Claude-named model on another route is refused.
  if (isClaude !== (via.run === 'claude'))
    return refuse(
      'provider_not_allowed',
      `${entry.id}: Claude runs only through claude -p, and claude -p runs only Claude`,
    )
  return { entry, run: via.run }
}

/** One question. Never throws: every failure is an outcome. */
export async function ask(
  req: AskRequest,
  deps: AskDeps = {},
  env = process.env,
): Promise<AskResult> {
  const started = Date.now()
  const harness = deps.harness ?? HARNESS
  const catalog = deps.catalog ?? new Catalog()
  const finish = (outcome: AskOutcome, tokens = NO_TOKENS): AskResult => ({
    outcome,
    tokens,
    wallMs: Date.now() - started,
  })
  const bad = (detail: string) => finish({ kind: 'bad_input', detail })

  if (req.schema !== undefined) {
    const unsupported = unsupportedKeywords(req.schema)
    if (unsupported.length)
      return bad(`the schema uses keywords aico ask does not check: ${unsupported.join(', ')}`)
  }
  let files = ''
  if (req.files?.length) {
    const blocks = fileBlocks(req.files, req.cwd, harness)
    if ('error' in blocks) return bad(blocks.error)
    files = blocks.text
  }

  const context = deps.context ?? readPolicy(contextDbPath(dataDir(env)))
  if ('kind' in context) return finish(context)
  const role = req.role ?? harness.ask.default_role
  const project = projectFor(context.projects, req.cwd)
  const resolved = resolveModel(context, catalog, harness, role, project, req.model)
  if ('kind' in resolved) return finish(resolved)
  const { entry, run } = resolved

  const silenceMs = deps.silenceMs ?? harness.ask.wire_silence_seconds * 1000
  const system = [
    harness.ask.prompt,
    ...(req.schema !== undefined
      ? [
          `Reply with only one JSON value that fits this JSON Schema, and nothing else:\n${JSON.stringify(req.schema)}`,
        ]
      : []),
  ].join('\n\n')
  const user = [files, req.question].filter(Boolean).join('\n\n')
  const scratch = mkdtempSync(join(tmpdir(), 'aico-ask-'))
  let answer: Answer
  try {
    answer =
      run === 'claude'
        ? await viaClaude(entry, `${system}\n\n${user}`, req, req.schema, deps, silenceMs, scratch)
        : run === 'agy'
          ? await viaAgy(entry, `${system}\n\n${user}`, req, req.schema, deps, silenceMs, scratch)
          : await viaPi(entry, user, system, req, deps, harness, silenceMs)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  if ('kind' in answer.outcome) return finish(answer.outcome, answer.tokens)
  const { text, data } = answer.outcome
  if (req.schema === undefined)
    return finish({ kind: 'done', model: entry.id, text }, answer.tokens)
  // The CLIs return the parsed JSON separately; a plain model reply is parsed from its text.
  const found = data !== undefined ? { value: data } : jsonIn(text)
  const errors = found ? schemaErrors(req.schema, found.value) : ['the answer is not JSON']
  if (!found || errors.length)
    return finish({ kind: 'schema_invalid', model: entry.id, errors, text }, answer.tokens)
  return finish(
    { kind: 'done', model: entry.id, text: JSON.stringify(found.value), data: found.value },
    answer.tokens,
  )
}

const EXIT: Record<string, number> = {
  done: 0,
  error: 1,
  silent: 1,
  tool_denied: 1,
  bad_input: 2,
  refused: 3,
  model_refused: 4,
  model_swap: 4,
  schema_invalid: 5,
}

function readStdin(): Promise<string> {
  return new Promise((done, fail) => {
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      text += chunk
    })
    process.stdin.on('end', () => done(text))
    process.stdin.on('error', fail)
  })
}

/** `aico ask ...`: parses the command line, asks, prints the answer (or the failure) and returns the exit code. */
export async function askMain(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  deps: AskDeps & { cwd?: string; stdin?: () => Promise<string> } = {},
): Promise<number> {
  // --files takes every argument up to the next option.
  const files: string[] = []
  const args: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--files') args.push(argv[i] as string)
    else
      while (i + 1 < argv.length && !(argv[i + 1] as string).startsWith('-'))
        files.push(argv[++i] as string)
  }
  let parsed: ReturnType<typeof parse>
  try {
    parsed = parse(args)
  } catch (error) {
    process.stderr.write(`aico ask: ${(error as Error).message}\n${ASK_USAGE}\n`)
    return 2
  }
  const { values, positionals } = parsed
  if (values.help) {
    process.stderr.write(`${ASK_USAGE}\n`)
    return 0
  }
  const cwd = deps.cwd ?? process.cwd()
  const [model, ...words] = positionals
  let question = words.join(' ').trim()
  if (question === '-') question = (await (deps.stdin ?? readStdin)()).trim()
  if (!model || !question) {
    process.stderr.write(`aico ask: a model and a question are required\n${ASK_USAGE}\n`)
    return 2
  }
  let schema: unknown
  if (values.schema) {
    try {
      schema = JSON.parse(readFileSync(resolve(cwd, values.schema), 'utf8'))
    } catch (error) {
      process.stderr.write(`aico ask: --schema ${values.schema}: ${(error as Error).message}\n`)
      return 2
    }
  }
  const result = await ask(
    {
      model,
      question,
      cwd,
      ...(schema !== undefined && { schema }),
      ...(files.length && { files }),
      ...(values.role && { role: values.role }),
      ...(values.effort && { effort: values.effort }),
    },
    deps,
    env,
  )
  const { outcome } = result
  if (values.json) process.stdout.write(`${JSON.stringify(result)}\n`)
  else if (outcome.kind === 'done') process.stdout.write(`${outcome.text}\n`)
  const t = result.tokens
  process.stderr.write(
    `aico ask: ${outcome.kind}${'model' in outcome ? ` on ${outcome.model}` : ''}; tokens in ${t.input} / out ${t.output}; ${(result.wallMs / 1000).toFixed(1)} s\n`,
  )
  if (outcome.kind !== 'done') process.stderr.write(`aico ask: ${JSON.stringify(outcome)}\n`)
  return EXIT[outcome.kind] ?? 1
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      schema: { type: 'string' },
      role: { type: 'string' },
      effort: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
}

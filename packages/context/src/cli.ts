// `aico memory | prompt | models | context`: context.db from the command line.
// Output matches `st memory`, `st prompt` and `st models route` line for line where
// agents read it.

import { readFileSync } from 'node:fs'
import { transaction } from '@aico/store'
import { routeFacts } from '@aico/usage'
import { startedBy } from './ancestry'
import { bindContextSession, estimatedTokens } from './cost'
import { type Database, openContext } from './db'
import {
  type Activity,
  DELIVERY,
  deliver,
  deliveryTools,
  recordDelivery,
  type Source,
  setDeliveryTool,
  toolId,
  UnknownTool,
} from './deliver'
import {
  formatLaunch,
  formatMemories,
  formatMemoryList,
  formatOptions,
  formatPrompt,
  formatPromptList,
  formatSearch,
} from './format'
import { loadPolicy } from './launch'
import {
  addMemory,
  getMemories,
  listMemories,
  putMemory,
  SCOPES,
  type Scope,
  searchMemories,
  TIERS,
  type Tier,
  type Where,
} from './memory'
import { Catalog } from './models'
import { getPrompt, listPrompts, promptRevisions, putPrompt } from './prompts'
import { route, UnknownLaunchKey } from './route'

export const CONTEXT_COMMANDS = ['memory', 'prompt', 'models', 'context'] as const

export interface ContextCliIo {
  out(text: string): void
  err(text: string): void
  /** context.db. */
  dbPath: string
  now(): Date
  /** Aico's data directory: usage.db there holds the usage facts `models route` shows. */
  dataDir?: string
  /** `context deliver`: the environment it reads (session, role, already-delivered
   * markers) and its two computed sources; absent, deliver has neither block. */
  delivery?: {
    env: NodeJS.ProcessEnv
    /** The parent of a process (default: Linux /proc); tests give a fake tree. */
    parentOf?(pid: number): number | null
    /** This process's pid (default: process.pid). */
    pid?: number
    toolUsage(project: string): Promise<Source<string>>
    /** The other sessions in a project, from Tether. */
    activity(project: string, except: string | null): Promise<Source<Activity[]>>
    /** Whether Aico's project registry lists the project (it then gets project scope). */
    registered?(project: string): boolean
  }
}

const USAGE = `Usage: aico <memory|prompt|models|context> ...

  aico memory search QUERY [-l N] [--min-score F] [-t TIER] [-s global|project|agent] [--scope-id ID]
  aico memory list [-l N] [--cursor N] [-t TIER] [-s SCOPE] [--scope-id ID] [--tag TAG]
  aico memory get ID [ID...]
  aico memory save CONTENT [-S SUMMARY] [-t TIER] [-s SCOPE] [--scope-id ID] [--tags a,b] [--content-file F]
  aico memory update ID (CONTENT | --content-file F) [-S SUMMARY] [-t TIER] [--reason R]
  aico prompt list [--global|--no-global]
  aico prompt get SLUG [--json]
  aico prompt revisions SLUG [--limit N] [--json]
  aico prompt update SLUG --content-file F [--reason R]
  aico prompt measure [SLUG...]   (none: the global prompts)
  aico models route --role R [--tool T] [--model M] [--project P] [--json]
  aico context deliver --tool T [--project P] [--session S] [--role R] [--coordinator]
                       [--event E] [--format text|json|claude|codex|pi] [--force]
  aico context delivery [TOOL on|off]
`

/** The usage lines of one command (`aico memory --help` shows memory's, not prompt's). */
function commandUsage(command: string): string {
  const lines: string[] = []
  let mine = false
  for (const line of USAGE.split('\n').slice(2)) {
    if (/^ {2}aico \S/.test(line)) mine = line.startsWith(`  aico ${command} `)
    if (mine && line.trim()) lines.push(line)
  }
  return lines.length ? `Usage: aico ${command} <command>\n\n${lines.join('\n')}\n` : USAGE
}

class UsageError extends Error {}

interface Parsed {
  args: string[]
  flags: Map<string, string | true>
}

/** Positional words and flags; `valued` flags take the next word (or `=value`). */
function parse(argv: string[], valued: Record<string, string>, bare: readonly string[]): Parsed {
  const args: string[] = []
  const flags = new Map<string, string | true>()
  for (let index = 0; index < argv.length; index++) {
    const word = argv[index] as string
    if (word === '--') {
      args.push(...argv.slice(index + 1))
      break
    }
    if (!word.startsWith('-') || word === '-') {
      args.push(word)
      continue
    }
    const [flag, inline] = word.includes('=') ? word.split(/=(.*)/s) : [word, undefined]
    const name = valued[flag as string]
    if (name) {
      const value = inline ?? argv[++index]
      if (value === undefined) throw new UsageError(`${flag} needs a value`)
      flags.set(name, value)
    } else if (bare.includes(flag as string)) flags.set(flag as string, true)
    else throw new UsageError(`unknown option ${flag}`)
  }
  return { args, flags }
}

const str = (parsed: Parsed, name: string) => {
  const value = parsed.flags.get(name)
  return typeof value === 'string' ? value : undefined
}

function int(parsed: Parsed, name: string, fallback: number, min: number, max: number): number {
  const text = str(parsed, name)
  if (text === undefined) return fallback
  const value = Number(text)
  if (!Number.isInteger(value) || value < min || value > max)
    throw new UsageError(`--${name} must be a whole number from ${min} to ${max}`)
  return value
}

function oneOf<T extends string>(
  parsed: Parsed,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const text = str(parsed, name)
  if (text === undefined) return undefined
  if (!allowed.includes(text as T))
    throw new UsageError(`--${name} must be one of: ${allowed.join(', ')}`)
  return text as T
}

const MEMORY_FLAGS = {
  '-l': 'limit',
  '--limit': 'limit',
  '--min-score': 'min-score',
  '-t': 'tier',
  '--tier': 'tier',
  '-s': 'scope',
  '--scope': 'scope',
  '--scope-id': 'scope-id',
  '--tag': 'tag',
  '--cursor': 'cursor',
  '-S': 'summary',
  '--summary': 'summary',
  '--tags': 'tags',
  '--content-file': 'content-file',
  '--reason': 'reason',
}

function where(parsed: Parsed): Where {
  const scope = oneOf<Scope>(parsed, 'scope', SCOPES)
  const scopeId = str(parsed, 'scope-id')
  if (scope && scope !== 'global' && !scopeId)
    throw new UsageError(`--scope ${scope} needs --scope-id`)
  const result: Where = {}
  const tier = oneOf<Tier>(parsed, 'tier', TIERS)
  if (tier) result.tier = tier
  if (scope) result.scope = scope
  if (scopeId) result.scopeId = scopeId
  const tag = str(parsed, 'tag')
  if (tag) result.tag = tag
  return result
}

function memory(db: Database, argv: string[], io: ContextCliIo): number {
  const [sub, ...rest] = argv
  const parsed = parse(rest, MEMORY_FLAGS, ['--pinned'])
  if (sub === 'search') {
    const query = parsed.args.join(' ')
    if (!query) throw new UsageError('memory search needs a query')
    const minScore = Number(str(parsed, 'min-score') ?? 0)
    if (!(minScore >= 0 && minScore <= 1)) throw new UsageError('--min-score must be from 0 to 1')
    const found = searchMemories(db, query, where(parsed), {
      limit: int(parsed, 'limit', 10, 1, 300),
      minScore,
    })
    io.out(`${formatSearch(query, found)}\n`)
    return 0
  }
  if (sub === 'list') {
    const page = listMemories(db, where(parsed), {
      limit: int(parsed, 'limit', 20, 1, 300),
      offset: int(parsed, 'cursor', 0, 0, Number.MAX_SAFE_INTEGER),
    })
    io.out(`${formatMemoryList(page.memories, page.next)}\n`)
    return 0
  }
  if (sub === 'get') {
    if (!parsed.args.length) throw new UsageError('memory get needs an id')
    const { found, missing } = getMemories(db, parsed.args)
    if (!found.length) {
      io.err(`Not found: ${missing.join(', ')}\n`)
      return 1
    }
    io.out(`${formatMemories(found, missing)}\n`)
    return 0
  }
  if (sub === 'save' || sub === 'add') {
    const file = str(parsed, 'content-file')
    const content = file ? readFileSync(file, 'utf8') : parsed.args.join(' ')
    const scope = oneOf<Scope>(parsed, 'scope', SCOPES)
    const tier = oneOf<Tier>(parsed, 'tier', TIERS)
    const summary = str(parsed, 'summary')
    const scopeId = str(parsed, 'scope-id')
    const tags = str(parsed, 'tags')
    const saved = addMemory(
      db,
      {
        content,
        ...(summary !== undefined && { summary }),
        ...(tier && { tier }),
        ...(scope && { scope }),
        ...(scopeId && { scopeId }),
        ...(tags && {
          tags: tags
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
        }),
        pinned: parsed.flags.has('--pinned'),
      },
      io.now().toISOString(),
    )
    io.out(
      `SAVED:${saved.id.slice(0, 8)} [${saved.tier}] ${saved.scope}${saved.scopeId ? `:${saved.scopeId}` : ''}\n`,
    )
    return 0
  }
  if (sub === 'update') {
    const [id, ...words] = parsed.args
    if (!id) throw new UsageError('memory update needs an id')
    const file = str(parsed, 'content-file')
    const content = file ? readFileSync(file, 'utf8') : words.join(' ')
    const summary = str(parsed, 'summary')
    const tier = oneOf<Tier>(parsed, 'tier', TIERS)
    if (!content && summary === undefined && !tier)
      throw new UsageError('memory update needs new content, --summary or --tier')
    const { found } = getMemories(db, [id])
    if (found.length !== 1) {
      io.err(found.length ? `'${id}' names ${found.length} memories.\n` : `No memory '${id}'.\n`)
      return 1
    }
    const before = found[0] as (typeof found)[number]
    const at = io.now().toISOString()
    const next = {
      ...before,
      ...(content && { content }),
      ...(summary !== undefined && { summary }),
      ...(tier && { tier }),
      version: before.version + 1,
      updatedAt: at,
    }
    transaction(db, () => putMemory(db, next, str(parsed, 'reason') ?? 'aico memory update', at))
    io.out(`UPDATED:${next.id.slice(0, 8)} [${next.tier}] v${next.version}\n`)
    return 0
  }
  throw new UsageError(`unknown memory command ${sub ?? '(none)'}`)
}

function prompt(db: Database, argv: string[], io: ContextCliIo): number {
  const [sub, ...rest] = argv
  const parsed = parse(
    rest,
    { '--limit': 'limit', '--content-file': 'content-file', '--reason': 'reason' },
    ['--global', '--no-global', '--json'],
  )
  if (sub === 'update') {
    const slug = parsed.args[0]
    const file = str(parsed, 'content-file')
    if (!slug || !file) throw new UsageError('prompt update needs a slug and --content-file')
    const found = getPrompt(db, slug)
    if (!found) {
      io.err(`No prompt '${slug}'.\n`)
      return 1
    }
    const content = readFileSync(file, 'utf8')
    transaction(db, () =>
      putPrompt(
        db,
        { ...found, content, updatedAt: io.now().toISOString() },
        str(parsed, 'reason') ?? 'aico prompt update',
      ),
    )
    io.out(`UPDATED:${slug} v${getPrompt(db, slug)?.version}\n`)
    return 0
  }
  if (sub === 'measure') {
    const prompts = parsed.args.length
      ? parsed.args.map((slug) => {
          const found = getPrompt(db, slug)
          if (!found) throw new UsageError(`no prompt '${slug}'`)
          return found
        })
      : listPrompts(db, { global: true })
    const rows = prompts.map((found) => {
      const bytes = Buffer.byteLength(found.content)
      return {
        slug: found.slug,
        bytes,
        lines: found.content.split('\n').length,
        tokens: estimatedTokens(bytes),
      }
    })
    io.out(
      parsed.flags.has('--json')
        ? `${JSON.stringify({ prompts: rows })}\n`
        : rows.map((r) => `${r.slug} ${r.bytes}B ${r.lines}L ~${r.tokens}tok\n`).join(''),
    )
    return 0
  }
  if (sub === 'list') {
    const filter = parsed.flags.has('--global')
      ? { global: true }
      : parsed.flags.has('--no-global')
        ? { global: false }
        : {}
    const prompts = listPrompts(db, filter)
    io.out(
      `${parsed.flags.has('--json') ? JSON.stringify({ prompts }) : formatPromptList(prompts)}\n`,
    )
    return 0
  }
  if (sub === 'get') {
    const slug = parsed.args[0]
    if (!slug) throw new UsageError('prompt get needs a slug')
    const found = getPrompt(db, slug)
    if (!found) {
      io.err(`No prompt '${slug}'.\n`)
      return 1
    }
    io.out(`${parsed.flags.has('--json') ? JSON.stringify(found) : formatPrompt(found)}\n`)
    return 0
  }
  if (sub === 'revisions') {
    const slug = parsed.args[0]
    if (!slug) throw new UsageError('prompt revisions needs a slug')
    const limit = Number(str(parsed, 'limit') || 100)
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new UsageError('--limit needs a positive integer')
    const revisions = promptRevisions(db, slug, limit)
    if (!revisions) {
      io.err(`No prompt '${slug}'.\n`)
      return 1
    }
    io.out(`${JSON.stringify({ revisions })}\n`)
    return 0
  }
  throw new UsageError(`unknown prompt command ${sub ?? '(none)'}`)
}

function models(db: Database, argv: string[], io: ContextCliIo): number {
  const [sub, ...rest] = argv
  if (sub !== 'route') throw new UsageError(`unknown models command ${sub ?? '(none)'}`)
  const parsed = parse(
    rest,
    { '--role': 'role', '--tool': 'tool', '--model': 'model', '--project': 'project' },
    ['--json'],
  )
  const role = str(parsed, 'role')
  if (!role) throw new UsageError('models route needs --role')
  const policy = loadPolicy(db)
  if (!policy) {
    io.err('context.db has no launch policy; restore context.db from a backup.\n')
    return 1
  }
  const tool = str(parsed, 'tool')
  const model = str(parsed, 'model')
  const project = str(parsed, 'project')
  const now = io.now().toISOString()
  const found = io.dataDir
    ? routeFacts(io.dataDir, now)
    : { error: 'Aico has no usage folder configured' }
  const facts = 'facts' in found ? found.facts : null
  const factsError = 'error' in found ? found.error : null
  let payload: ReturnType<typeof route>
  try {
    payload = route(
      policy,
      new Catalog(),
      { role, ...(tool && { tool }), ...(model && { model }), ...(project && { project }) },
      facts,
      now,
    )
  } catch (error) {
    if (error instanceof UnknownLaunchKey) {
      io.err(`${error.message}\n`)
      return 2
    }
    throw error
  }
  if (factsError !== null) payload.facts_error = factsError
  if (parsed.flags.has('--json')) io.out(`${JSON.stringify(payload, null, 2)}\n`)
  else if (tool) io.out(`${formatLaunch(payload)}\n`)
  else io.out(`${formatOptions(payload, role, project)}\n`)
  return 0
}

const DELIVER_FLAGS = {
  '--tool': 'tool',
  '--project': 'project',
  '--session': 'session',
  '--role': 'role',
  '--event': 'event',
  '--format': 'format',
}
const FORMATS = ['text', 'json', 'claude', 'codex', 'pi'] as const
const HOOK_FORMATS: readonly string[] = ['claude', 'codex', 'pi']

/** `context deliver`: contracts/context-delivery.schema.json is the contract. */
async function deliverCommand(db: () => Database, rest: string[], io: ContextCliIo) {
  const parsed = parse(rest, DELIVER_FLAGS, ['--coordinator', '--force'])
  const env = io.delivery?.env ?? {}
  const format = oneOf(parsed, 'format', FORMATS) ?? 'text'
  const name = str(parsed, 'tool')
  if (!name) throw new UsageError('context deliver needs --tool')
  let tool: string
  try {
    tool = toolId(name)
  } catch (error) {
    if (error instanceof UnknownTool) throw new UsageError(error.message)
    throw error
  }
  // A hook never adds a second copy of what the launch already delivered.
  // The launch's marker counts only for the agent it started (AICO_CONTEXT_PID is
  // that agent's pid, a few parents up from a hook): a session that agent starts
  // inherits the variables but not the pid, and gets its own delivery.
  const launched = Number(env.AICO_CONTEXT_PID)
  const marked =
    Boolean(env.AICO_CONTEXT_DELIVERED) &&
    Number.isInteger(launched) &&
    launched > 0 &&
    startedBy(launched, DELIVERY.markerHops, io.delivery?.pid, io.delivery?.parentOf)
  if (HOOK_FORMATS.includes(format) && marked && !parsed.flags.has('--force')) {
    // Startup knows both ids while the agent is alive. Keep the link so the
    // nightly pass can observe this exact conversation after its session ends.
    // A subagent's start carries the subagent's id, not the conversation's: never bind it.
    const native = str(parsed, 'session')
    if (marked && env.AICO_SESSION_ID && native && str(parsed, 'event') !== 'SubagentStart')
      try {
        bindContextSession(db(), tool, env.AICO_SESSION_ID, native)
      } catch (error) {
        io.err(`Context session link was not saved: ${(error as Error).message}\n`)
      }
    return 0
  }
  // No --project: the pane's. Either way deliver() gives project scope only to a
  // project in the registry, and a folder name the hook guessed gets global context.
  const project = str(parsed, 'project') ?? env.AICO_PROJECT_ID ?? ''
  const session = str(parsed, 'session') ?? env.AICO_SESSION_ID ?? null
  const [toolUsage, activity] = await Promise.all([
    io.delivery?.toolUsage(project),
    project ? io.delivery?.activity(project, session) : undefined,
  ])
  let result: ReturnType<typeof deliver>
  let opened: Database
  try {
    opened = db()
    result = deliver(opened, {
      tool,
      project,
      session,
      role: str(parsed, 'role') ?? env.ST_WORK_ROLE ?? null,
      coordinator: parsed.flags.has('--coordinator'),
      hook: HOOK_FORMATS.includes(format),
      ...(toolUsage === undefined ? {} : { toolUsage }),
      ...(activity === undefined ? {} : { activity }),
      ...(io.delivery?.registered ? { registered: io.delivery.registered } : {}),
      now: io.now(),
    })
  } catch (error) {
    io.err(`aico context deliver: ${(error as Error).message}\n`)
    return 1
  }
  // The inventory is a record, not the delivery: a busy or broken file costs the
  // record, never the context that was built.
  if (HOOK_FORMATS.includes(format) && result.text)
    try {
      recordDelivery(opened, result, `hook:${format}`, io.now())
    } catch (error) {
      io.err(`aico context deliver: delivery not recorded: ${(error as Error).message}\n`)
    }
  for (const gap of result.missing) io.err(`aico context deliver: no ${gap.id}: ${gap.reason}\n`)
  if (format === 'json') io.out(`${JSON.stringify(result, null, 2)}\n`)
  else if (format === 'claude' || format === 'codex') {
    if (result.text)
      io.out(
        `${JSON.stringify({ hookSpecificOutput: { hookEventName: str(parsed, 'event') ?? 'SessionStart', additionalContext: result.text } })}\n`,
      )
  } else io.out(result.text ? `${result.text}\n` : '')
  return 0
}

function deliverySwitch(db: Database, rest: string[], io: ContextCliIo): number {
  const [tool, state, ...extra] = rest
  if (tool !== undefined) {
    if (extra.length || (state !== 'on' && state !== 'off'))
      throw new UsageError('context delivery takes TOOL on|off')
    try {
      setDeliveryTool(db, tool, state === 'on')
    } catch (error) {
      if (error instanceof UnknownTool) throw new UsageError(error.message)
      throw error
    }
  }
  const tools = deliveryTools(db)
  io.out(
    `Tether delivers Aico's context to: ${tools.length ? tools.join(', ') : 'none'} (the rest only get their aico-hook's)\n`,
  )
  return 0
}

function context(db: Database, argv: string[], io: ContextCliIo): number {
  const [sub, ...rest] = argv
  if (sub === 'delivery') return deliverySwitch(db, rest, io)
  throw new UsageError(`unknown context command ${sub ?? '(none)'}`)
}

/** One `aico` command against context.db; its exit status. */
export async function runContextCli(
  command: string,
  argv: string[],
  io: ContextCliIo,
): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv.includes('--help')) {
    io.out(commandUsage(command))
    return argv.length === 0 ? 2 : 0
  }
  let db: Database | null = null
  try {
    // Deliver opens the file itself, after its fast already-delivered check, and
    // answers a broken file with one line instead of a stack.
    if (command === 'context' && argv[0] === 'deliver')
      return await deliverCommand(
        () => {
          db = openContext(io.dbPath)
          return db
        },
        argv.slice(1),
        io,
      )
    db = openContext(io.dbPath)
    if (command === 'memory') return memory(db, argv, io)
    if (command === 'prompt') return prompt(db, argv, io)
    if (command === 'models') return models(db, argv, io)
    if (command === 'context') return context(db, argv, io)
    throw new UsageError(`unknown command ${command}`)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    io.err(`${error.message}\n\n${commandUsage(command)}`)
    return 2
  } finally {
    ;(db as Database | null)?.close()
  }
}

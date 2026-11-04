// `aico web search|research|fetch|batch|refocus`: the flags and JSON output `st web` had.
// Exit 0 done, 1 the answer carries an error, 2 usage, 3 not handled here (doctor,
// benchmark, Lightpanda: `st web` then runs Agent Hub's own code, as before).

import { parseArgs } from 'node:util'
import type { StatusRow } from '@aico/status'
import { count, counterRow, openCounter, today } from './counter'
import {
  BACKENDS,
  DEFAULT_MAX_CHARS,
  DEFAULT_TIMEOUT,
  fetchBatch,
  fetchPage,
  refocus,
  research,
  searchWeb,
} from './fetch'
import { pyJson } from './json'

export const NOT_HANDLED = 3

export interface WebIo {
  out(text: string): void
  err(text: string): void
  dataDir: string
  env: NodeJS.ProcessEnv
  fetch: typeof fetch
  now(): Date
  machine: string
  /** aico-web's POST /api/status/rows, or null to skip the row. */
  statusUrl: string | null
}

export const USAGE = `Usage: aico web <command> [options]
  search [QUERY] [--query Q] [--max-results N|--limit N] [--search-type text|news] [--timelimit d|w|m|y]
  research [QUERY] [--query Q] [--max-results N] [--result-index N] [--search-type ..] [--timelimit ..]
           [--max-chars N] [--focus-query Q] [--backend auto|direct|jina] [--timeout S]
  fetch [URL] [--url U] [--max-chars N] [--focus-query Q] [--backend auto|direct|jina] [--timeout S]
  batch URL... [--max-chars N] [--focus-query Q] [--backend ..] [--timeout S]
  refocus [ARTIFACT] [--artifact A] [--max-chars N] [--focus-query Q]
Every command takes --compact (or --raw): one line of JSON instead of the indented view.
Search is keyless (DuckDuckGo, Bing; SearXNG when WEB_SEARCH_SEARXNG_URL is set). fetch --backend
auto reads the page directly and falls back to the Jina reader when it fails or comes back empty.
`

class UsageError extends Error {}

const OPTIONS = {
  query: { type: 'string' },
  url: { type: 'string' },
  artifact: { type: 'string' },
  'max-results': { type: 'string' },
  limit: { type: 'string' },
  'result-index': { type: 'string' },
  'search-type': { type: 'string' },
  timelimit: { type: 'string' },
  'max-chars': { type: 'string' },
  'focus-query': { type: 'string' },
  backend: { type: 'string' },
  timeout: { type: 'string' },
  selector: { type: 'string' },
  'wait-script': { type: 'string' },
  compact: { type: 'boolean' },
  raw: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

function integer(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!/^-?\d+$/.test(value))
    throw new UsageError(`argument --${name}: invalid int value: '${value}'`)
  return Number(value)
}

function choice(
  name: string,
  value: string | undefined,
  allowed: readonly string[],
): string | undefined {
  if (value !== undefined && !allowed.includes(value))
    throw new UsageError(
      `argument --${name}: invalid choice: '${value}' (choose from ${allowed.join(', ')})`,
    )
  return value
}

const VERBS = ['search', 'research', 'fetch', 'batch', 'refocus'] as const
type Verb = (typeof VERBS)[number]

function required(
  primary: string | undefined,
  positional: string | undefined,
  name: string,
): string {
  const value = (primary ?? positional ?? '').trim()
  if (!value) throw new UsageError(`${name} is required`)
  return value
}

async function run(
  verb: Verb,
  argv: string[],
  io: WebIo,
): Promise<{ payload: Record<string, unknown>; compact: boolean } | number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  })
  if (values.help) {
    io.out(USAGE)
    return 0
  }
  if (
    values.selector !== undefined ||
    values['wait-script'] !== undefined ||
    values.backend === 'lightpanda'
  )
    return NOT_HANDLED
  const compact = Boolean(values.compact || values.raw)
  const deps = { fetch: io.fetch, env: io.env }
  const fetchOptions = {
    maxChars: integer('max-chars', values['max-chars'], DEFAULT_MAX_CHARS),
    focusQuery: values['focus-query'],
    backend: choice('backend', values.backend, BACKENDS) ?? 'auto',
    timeout: values.timeout === undefined ? DEFAULT_TIMEOUT : Number(values.timeout),
  }
  if (values.timeout !== undefined && Number.isNaN(fetchOptions.timeout))
    throw new UsageError(`argument --timeout: invalid float value: '${values.timeout}'`)
  const searchOptions = {
    max: integer('max-results', values['max-results'] ?? values.limit, 5),
    type: choice('search-type', values['search-type'], ['text', 'news']) ?? 'text',
    timelimit: choice('timelimit', values.timelimit, ['d', 'w', 'm', 'y']),
  }
  const first = positionals[0]
  let payload: Record<string, unknown>
  if (verb === 'search')
    payload = await searchWeb(required(values.query, first, '--query'), searchOptions, deps)
  else if (verb === 'research')
    payload = await research(
      required(values.query, first, '--query'),
      {
        ...searchOptions,
        ...fetchOptions,
        resultIndex: integer('result-index', values['result-index'], 1),
      },
      deps,
    )
  else if (verb === 'fetch')
    payload = await fetchPage(required(values.url, first, '--url'), fetchOptions, deps)
  else if (verb === 'batch') {
    if (!positionals.length) throw new UsageError('the following arguments are required: urls')
    payload = await fetchBatch(positionals, fetchOptions, deps)
  } else
    payload = refocus(
      required(values.artifact, first, '--artifact'),
      { maxChars: fetchOptions.maxChars, focusQuery: fetchOptions.focusQuery },
      deps,
    )
  return { payload, compact }
}

const hasFallback = (payload: Record<string, unknown>): boolean => {
  if (
    Array.isArray(payload.provider_errors) &&
    payload.provider_errors.length &&
    !('error' in payload)
  )
    return true
  if (typeof payload.fallback_reason === 'string') return true
  const nested = [
    payload.page,
    payload.search,
    ...(Array.isArray(payload.results) ? payload.results : []),
  ]
  return nested.some(
    (item) => item && typeof item === 'object' && hasFallback(item as Record<string, unknown>),
  )
}

/** Counts the call and refreshes the Status row; neither may change the command's result. */
async function record(io: WebIo, verb: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const db = openCounter(io.dataDir)
    try {
      const at = io.now()
      count(db, at, { verb, failed: 'error' in payload, fallback: hasFallback(payload) })
      if (!io.statusUrl) return
      const row: StatusRow = counterRow(io.machine, today(db, at), at)
      await io.fetch(io.statusUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([row]),
        signal: AbortSignal.timeout(2_000),
      })
    } finally {
      db.close()
    }
  } catch (cause) {
    if (io.env.AICO_WEB_DEBUG) io.err(`counter: ${(cause as Error).message}\n`)
  }
}

export async function runWebCli(argv: string[], io: WebIo): Promise<number> {
  const verb = argv[0]
  if (!verb || verb === '-h' || verb === '--help' || verb === 'help') {
    io.out(USAGE)
    return verb ? 0 : 2
  }
  if (!(VERBS as readonly string[]).includes(verb)) {
    if (verb === 'doctor' || verb === 'benchmark') return NOT_HANDLED
    io.err(`aico web: unknown command '${verb}'\n${USAGE}`)
    return 2
  }
  let done: Awaited<ReturnType<typeof run>>
  try {
    done = await run(verb as Verb, argv.slice(1), io)
  } catch (cause) {
    if (cause instanceof UsageError) io.err(`ERROR ${cause.message}\n`)
    else io.err(`aico web ${verb}: ${(cause as Error).message}\n`)
    return 2
  }
  if (typeof done === 'number') return done
  io.out(`${pyJson(done.payload, done.compact ? null : 2)}\n`)
  await record(io, verb, done.payload)
  return 'error' in done.payload ? 1 : 0
}

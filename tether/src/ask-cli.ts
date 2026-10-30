// `tether ask`: put a question to the owner once and read the answer
// (src/asks.ts). Plain shell, so every agent harness can use it.

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { callSocket } from './client'
import type { TetherPaths } from './config'

export const ASK_USAGE = `Usage:
  tether ask create "<question>" [--option TEXT]... [--recommend N] [--blocking]
                    [--body TEXT | --body-file PATH] [--command CMD] [--share ID]
                    [--session ID | --from LABEL]
      One line that stands alone. --option up to 5 choices, --recommend N marks
      choice N (from 1). --blocking: you stopped and wait on the answer (the
      owner gets a phone push). Asking the same open question again updates it.
  tether ask get <id>          the ask with the owner's answer
  tether ask list [--mine] [--all]
                               open and answered asks (--all: closed ones too);
                               --mine: this session's (or --from LABEL's)
  tether ask done <id>         close it once you have acted on the answer
  tether ask withdraw <id>     take back a question that no longer applies

The answer comes back to an Aico session (Claude Code, Codex, Pi, Agent Hub) as
a message once the agent is idle. Elsewhere (Antigravity, a script) read it
with tether ask get <id>.`

interface Asker {
  session?: string
  requester?: string
}

/** Who is asking: the pane's own Aico session (`AICO_WIDGET_ID`), else
 * `--from LABEL`, else this folder's name. `--session` overrides. */
export function askerOf(
  options: { session?: string; from?: string },
  env: NodeJS.ProcessEnv,
  cwd: string,
): Asker {
  if (options.session) return { session: options.session }
  if (options.from) return { requester: options.from }
  const session = /^(?:aico-widget-)?([0-9a-f]{8})$/.exec(env.AICO_WIDGET_ID ?? '')?.[1]
  return session ? { session } : { requester: basename(cwd) || 'shell' }
}

const VALUE_FLAGS = [
  'option',
  'recommend',
  'body',
  'body-file',
  'command',
  'share',
  'session',
  'from',
] as const
type ValueFlag = (typeof VALUE_FLAGS)[number]

interface ParsedFlags {
  positional: string[]
  values: Partial<Record<ValueFlag, string[]>>
  switches: Set<string>
}

function parseFlags(args: string[], switches: readonly string[]): ParsedFlags | string {
  const parsed: ParsedFlags = { positional: [], values: {}, switches: new Set() }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string
    const match = /^--([a-z-]+)(?:=(.*))?$/s.exec(arg)
    if (!match) {
      parsed.positional.push(arg)
      continue
    }
    const name = match[1] as string
    if (switches.includes(name)) {
      parsed.switches.add(name)
      continue
    }
    if (!(VALUE_FLAGS as readonly string[]).includes(name)) return `unknown option --${name}`
    let value = match[2]
    if (value === undefined) {
      index += 1
      value = args[index]
    }
    if (value === undefined) return `--${name} needs a value`
    const list = parsed.values[name as ValueFlag] ?? []
    list.push(value)
    parsed.values[name as ValueFlag] = list
  }
  return parsed
}

const last = (flags: ParsedFlags, name: ValueFlag) => flags.values[name]?.at(-1)

/** The `POST /v1/asks` body for `tether ask create`, or what is wrong. */
export function askCreateBody(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): Record<string, unknown> | string {
  const flags = parseFlags(args, ['blocking'])
  if (typeof flags === 'string') return flags
  if (flags.positional.length !== 1) return 'give the question as one argument (quote it)'
  const options = flags.values.option ?? []
  const recommend = last(flags, 'recommend')
  let recommended: number | undefined
  if (recommend !== undefined) {
    const n = Number(recommend)
    if (!Number.isSafeInteger(n) || n < 1 || n > options.length)
      return `--recommend takes a choice number from 1 to ${options.length || 'the number of --option'}`
    recommended = n - 1
  }
  let body = last(flags, 'body')
  const bodyFile = last(flags, 'body-file')
  if (body !== undefined && bodyFile !== undefined) return 'give --body or --body-file, not both'
  if (bodyFile !== undefined) {
    try {
      body = readFile(bodyFile)
    } catch (error) {
      return `cannot read --body-file: ${(error as Error).message}`
    }
  }
  const command = last(flags, 'command')
  const share = last(flags, 'share')
  return {
    ...askerOf({ session: last(flags, 'session'), from: last(flags, 'from') }, env, cwd),
    question: flags.positional[0],
    ...(options.length ? { options } : {}),
    ...(recommended === undefined ? {} : { recommended }),
    ...(body === undefined ? {} : { body }),
    ...(command === undefined ? {} : { command }),
    ...(share === undefined ? {} : { share }),
    ...(flags.switches.has('blocking') ? { blocking: true } : {}),
  }
}

/** `GET /v1/asks` query for `tether ask list`. */
export function askListPath(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): string | { error: string } {
  const flags = parseFlags(args, ['mine', 'all'])
  if (typeof flags === 'string') return { error: flags }
  if (flags.positional.length) return { error: `unexpected ${flags.positional[0]}` }
  const query = new URLSearchParams()
  if (!flags.switches.has('all')) query.set('state', 'open,answered')
  if (flags.switches.has('mine')) {
    const asker = askerOf({ session: last(flags, 'session'), from: last(flags, 'from') }, env, cwd)
    if (asker.session) query.set('session', asker.session)
    else query.set('requester', asker.requester as string)
  }
  const text = query.toString()
  return `/v1/asks${text ? `?${text}` : ''}`
}

interface AskJson {
  id: string
  session: string | null
  requester: string | null
  question: string
  options: string[]
  recommended: number | null
  body: string | null
  command: string | null
  share: string | null
  blocking: boolean
  state: string
  answer: string | null
  note: string | null
  delivery: string | null
}

const STATE_WORDS: Record<string, string> = {
  open: 'waiting for the owner',
  answered: 'answered',
  done: 'done',
  withdrawn: 'withdrawn',
}

export function formatAsk(ask: AskJson): string {
  const lines = [`${ask.id}  ${ask.question}`]
  lines.push(
    `  ${STATE_WORDS[ask.state] ?? ask.state}${ask.blocking && ask.state === 'open' ? ' (blocking)' : ''} · from ${ask.session ? `session ${ask.session}` : ask.requester}`,
  )
  ask.options.forEach((option, index) => {
    lines.push(`  ${index + 1}. ${option}${index === ask.recommended ? '  (recommended)' : ''}`)
  })
  if (ask.body) for (const line of ask.body.split('\n')) lines.push(`  | ${line}`)
  if (ask.command) lines.push(`  command: ${ask.command}`)
  if (ask.share) lines.push(`  share: ${ask.share}`)
  if (ask.answer !== null) lines.push(`  answer: ${ask.answer}`)
  if (ask.note !== null) lines.push(`  note: ${ask.note}`)
  if (ask.state === 'answered') lines.push(`  when handled: tether ask done ${ask.id}`)
  return lines.join('\n')
}

function listLine(ask: AskJson): string {
  const reply = ask.state === 'answered' ? `  → ${ask.answer ?? `note: ${ask.note}`}` : ''
  const mark = ask.blocking && ask.state === 'open' ? '!' : ' '
  return `${mark} ${ask.id}  ${ask.state.padEnd(9)} ${ask.question}${reply}`
}

export async function runAsk(
  io: { out(text: string): void; err(text: string): void },
  paths: TetherPaths,
  json: boolean,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<number> {
  const [sub, ...rest] = args
  let method = 'GET'
  let path: string
  let body: Record<string, unknown> | undefined
  if (sub === 'create') {
    const built = askCreateBody(rest, env, cwd)
    if (typeof built === 'string') {
      io.err(`tether ask: ${built}`)
      return 2
    }
    method = 'POST'
    path = '/v1/asks'
    body = built
  } else if (sub === 'list') {
    const built = askListPath(rest, env, cwd)
    if (typeof built !== 'string') {
      io.err(`tether ask: ${built.error}`)
      return 2
    }
    path = built
  } else if ((sub === 'get' || sub === 'done' || sub === 'withdraw') && rest.length === 1) {
    const id = encodeURIComponent(rest[0] as string)
    if (sub === 'get') path = `/v1/asks/${id}`
    else {
      method = 'POST'
      path = `/v1/asks/${id}/${sub}`
    }
  } else {
    io.err(ASK_USAGE)
    return 2
  }

  let response: { status: number; body: unknown }
  try {
    response = await callSocket(paths.socket, method, path, body)
  } catch (error) {
    io.err(
      `tether (${paths.instance}) is not reachable at ${paths.socket}: ${(error as Error).message}`,
    )
    return 2
  }
  const ok = response.status >= 200 && response.status < 300
  if (json) {
    io.out(JSON.stringify(response.body, null, 2))
    return ok ? 0 : 1
  }
  if (!ok) {
    const error = (response.body ?? {}) as Record<string, unknown>
    const detail = [error.field, error.detail].filter(Boolean).join(': ')
    io.err(`tether ask: ${error.error ?? response.status}${detail ? ` (${detail})` : ''}`)
    return 1
  }
  if (sub === 'list') {
    const items = ((response.body as { items?: AskJson[] }).items ?? []) as AskJson[]
    if (!items.length) io.out('No asks.')
    for (const item of items) io.out(listLine(item))
    return 0
  }
  const ask = response.body as AskJson
  if (sub === 'create') {
    if (response.status === 201)
      io.out(
        `Asked: ${ask.id}. The owner sees it in Aico under Needs you. In your reply, write just the question and "ask ${ask.id}". The answer comes to this session as a message when you are idle; or read it with tether ask get ${ask.id}.`,
      )
    else if (ask.state === 'answered')
      io.out(`Already answered (ask ${ask.id}):\n${formatAsk(ask)}`)
    else io.out(`Updated the open ask ${ask.id} (same question).`)
    return 0
  }
  if (sub === 'done') io.out(`Closed ask ${ask.id}.`)
  else if (sub === 'withdraw') io.out(`Withdrew ask ${ask.id}.`)
  else io.out(formatAsk(ask))
  return 0
}

// `aico declare` and `aico notify`: the agent-facing doors to the host check's declarations
// (host-steward, root) and to the owner notices in aico-web (contracts/notice.schema.json).
import { parseArgs } from 'node:util'

export const HOST_STEWARD = '/usr/local/bin/host-steward'

const NOTIFY_HELP = `Usage: aico notify --title T --body B [--severity critical|warning|info|ok] [--key K] [--open https://URL]
                   [--kind alert|todo|question|info] [--source NAME] [--cooldown SECONDS]
                   [--interrupt needs-you|security|data-risk|outage|reminder]
       aico notify --json            one notice v1 (contracts/notice.schema.json) as JSON on stdin
       aico notify resolve KEY --text T [--source NAME]   end your notice under KEY
Sends a notice to the owner through Aico web (this machine only). It goes to the tray and the morning digest.
It reaches the phone only with --interrupt (a warning or critical): an agent truly needs the owner, a security event,
a backup failing, or an always-on host or service down. Anything else is not a phone matter.
The owner's Settings > Notifications choice for the notice's type beats all of this. An agent's test stays off the phone;
to test the phone use --interrupt needs-you with a title starting 'Test: ', which still obeys the Tests switch.
A repeat of the same key from the same source stays quiet for the cooldown. Exits 2 when the notice breaks the contract and 1 when Aico web refuses or is down, with the server's reason.`

export interface NotifyContext {
  api: string
  source: string | null
  fetcher: typeof fetch
  readStdin: () => Promise<string>
  out: (line: string) => void
  err: (line: string) => void
}

async function post(
  ctx: NotifyContext,
  path: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const response = await ctx.fetcher(`${ctx.api}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let data: unknown = text
  try {
    data = JSON.parse(text)
  } catch {
    /* Not JSON: keep the text. */
  }
  return { ok: response.ok, status: response.status, data }
}

function refusal(status: number, data: unknown): string {
  const detail = (data as { detail?: unknown } | null)?.detail
  return `aico notify: refused (HTTP ${status}): ${typeof detail === 'string' ? detail : JSON.stringify(data)}`
}

export async function notify(args: string[], ctx: NotifyContext): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    ctx.out(NOTIFY_HELP)
    return 0
  }
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      title: { type: 'string' },
      body: { type: 'string' },
      severity: { type: 'string' },
      kind: { type: 'string' },
      key: { type: 'string' },
      open: { type: 'string' },
      source: { type: 'string' },
      cooldown: { type: 'string' },
      interrupt: { type: 'string' },
      text: { type: 'string' },
    },
  })
  const source = values.source ?? ctx.source ?? 'agent'
  let path = '/notices'
  let body: Record<string, unknown>
  if (positionals[0] === 'resolve') {
    if (!positionals[1] || !values.text) {
      ctx.err('aico notify resolve KEY --text T')
      return 2
    }
    path = '/notices/resolve'
    body = { source, key: positionals[1], text: values.text }
  } else if (positionals.length) {
    ctx.err(`aico notify: unexpected ${positionals[0]}; use --title and --body, or --json`)
    return 2
  } else if (values.json) {
    try {
      const parsed = JSON.parse(await ctx.readStdin())
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('not an object')
      body = { source, ...parsed }
    } catch (error) {
      ctx.err(`aico notify: stdin is not a JSON notice: ${(error as Error).message}`)
      return 2
    }
  } else {
    if (!values.title || !values.body) {
      ctx.err('aico notify needs --title and --body (or --json with a notice on stdin)')
      return 2
    }
    body = { v: 1, source, title: values.title, body: values.body }
    for (const name of ['severity', 'kind', 'key', 'open', 'interrupt'] as const)
      if (values[name]) body[name] = values[name]
    if (values.cooldown !== undefined) body.cooldown = Number(values.cooldown)
  }
  let result: Awaited<ReturnType<typeof post>>
  try {
    result = await post(ctx, path, body)
  } catch (error) {
    ctx.err(`aico notify: Aico web is not answering: ${(error as Error).message}`)
    return 1
  }
  if (!result.ok) {
    ctx.err(refusal(result.status, result.data))
    // 2: the notice itself is wrong (a bug in the sender); 1: nothing was taken for another reason.
    return result.status === 422 ? 2 : 1
  }
  ctx.out(typeof result.data === 'string' ? result.data : JSON.stringify(result.data))
  return 0
}

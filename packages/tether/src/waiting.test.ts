import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import {
  noticeFor,
  postAicoNotice,
  readWaitingState,
  WAIT_NOTICE_MS,
  type WaitingNotice,
  WaitingNotices,
  type WaitingState,
} from './waiting'

const ORIGIN = 'https://aico.example.dev'
const TOOLS = [
  { slug: 'claude-code', name: 'Claude Code', processName: 'claude', aliases: ['claude'] },
  { slug: 'codex', name: 'Codex', processName: 'codex', aliases: [] },
]

function harness(initial: WaitingState = { seen: {}, sent: {} }) {
  let clock = 1_000_000
  const timers = new Map<number, { at: number; fn: () => void }>()
  let next = 1
  const sent: WaitingNotice[] = []
  const resolved: string[] = []
  let saved = JSON.stringify(initial)
  const waiting = new WaitingNotices({
    origin: ORIGIN,
    tools: () => TOOLS,
    send: (notice) => sent.push(notice),
    resolve: (key) => resolved.push(key),
    state: { read: () => readWaitingState(saved), write: (s) => (saved = JSON.stringify(s)) },
    now: () => clock,
    setTimer: (fn, ms) => {
      timers.set(next, { at: clock + ms, fn })
      return next++
    },
    clearTimer: (handle) => timers.delete(handle as number),
  })
  const advance = (ms: number) => {
    clock += ms
    for (const [id, timer] of [...timers]) {
      if (timer.at <= clock) {
        timers.delete(id)
        timer.fn()
      }
    }
  }
  return { waiting, sent, resolved, advance, now: () => clock, saved: () => saved }
}

const blocked = (at: number, extra: Record<string, unknown> = {}) => ({
  id: 'abcd1234',
  tool: 'claude-code',
  label: 'aico',
  displayTitle: 'Disk merge',
  state: 'blocked',
  stateAt: at,
  stateSource: 'claude-status',
  ...extra,
})

describe('waiting notices', () => {
  it('sends one phone notice after 2 minutes blocked and unseen, and resolves it once answered', () => {
    const h = harness()
    h.waiting.session(blocked(h.now()))
    h.advance(WAIT_NOTICE_MS - 1)
    expect(h.sent).toHaveLength(0)
    h.advance(1)
    expect(h.sent).toEqual([
      {
        v: 1,
        source: 'aico',
        kind: 'todo',
        severity: 'warning',
        title: 'Claude Code waiting in Disk merge',
        body: 'Open it in Aico to answer.',
        key: 'aico-waiting:abcd1234',
        open: `${ORIGIN}/?session=abcd1234`,
        actions: ['open'],
        primary: 'open',
        push: 'phone',
      },
    ])
    // The same wait again (a re-published descriptor) sends nothing more.
    h.waiting.session(blocked(h.now() - WAIT_NOTICE_MS))
    h.advance(WAIT_NOTICE_MS * 3)
    expect(h.sent).toHaveLength(1)
    h.waiting.session({ ...blocked(h.now()), state: 'working' })
    h.waiting.session({ ...blocked(h.now()), state: 'idle' })
    expect(h.resolved).toEqual(['aico-waiting:abcd1234'])
  })

  it('sends nothing when the owner sees the session in time, and nothing later for that wait', () => {
    const h = harness()
    const at = h.now()
    h.waiting.session(blocked(at))
    h.advance(60_000)
    h.waiting.seen(['abcd1234'], h.now())
    h.waiting.session(blocked(at))
    h.advance(WAIT_NOTICE_MS * 2)
    expect(h.sent).toHaveLength(0)
  })

  it('a seen mark from before the wait does not count', () => {
    const h = harness()
    h.waiting.seen(['abcd1234'], h.now() - 1)
    h.waiting.session(blocked(h.now()))
    h.advance(WAIT_NOTICE_MS)
    expect(h.sent).toHaveLength(1)
  })

  it('resolves a sent notice when the owner opens the session, or when it ends', () => {
    const h = harness()
    h.waiting.session(blocked(h.now()))
    h.advance(WAIT_NOTICE_MS)
    h.waiting.seen(['abcd1234'], h.now())
    expect(h.resolved).toEqual(['aico-waiting:abcd1234'])
    h.waiting.session(blocked(h.now() + 10))
    h.advance(WAIT_NOTICE_MS + 10)
    expect(h.sent).toHaveLength(2)
    h.waiting.removed('abcd1234')
    expect(h.resolved).toHaveLength(2)
  })

  it('a restart neither repeats a sent notice nor forgets to resolve it', () => {
    const first = harness()
    const at = first.now()
    first.waiting.session(blocked(at))
    first.advance(WAIT_NOTICE_MS)
    const second = harness(JSON.parse(first.saved()))
    second.waiting.session(blocked(at))
    second.advance(WAIT_NOTICE_MS)
    expect(second.sent).toHaveLength(0)
    second.waiting.sweep()
    expect(second.resolved).toHaveLength(0)
    const third = harness(JSON.parse(first.saved()))
    third.waiting.sweep()
    expect(third.resolved).toEqual(['aico-waiting:abcd1234'])
  })

  it('names the agent the state came from', () => {
    const notice = noticeFor(
      { session: blocked(1, { tool: 'shell', stateSource: 'codex-status', displayTitle: '' }) },
      TOOLS,
      ORIGIN,
    )
    expect(notice.title).toBe('Codex waiting in aico')
  })
})

describe('notice contract v1', () => {
  // Aico's notify checks every notice against contracts/notice.schema.json.
  const schema = JSON.parse(
    readFileSync(new URL('../../../contracts/notice.schema.json', import.meta.url), 'utf8'),
  ) as {
    required: string[]
    properties: Record<string, { const?: unknown; enum?: unknown[]; pattern?: string }>
  }
  const AICO = 'https://aico.summitflow.dev'
  const notices: [string, WaitingNotice][] = [
    ['session', noticeFor({ session: blocked(1) }, TOOLS, AICO)],
  ]
  it.each(notices)('the %s notice fits the schema and reaches the phone', (_name, notice) => {
    for (const field of schema.required) expect(notice).toHaveProperty(field)
    for (const [field, value] of Object.entries(notice)) {
      const rule = schema.properties[field]
      expect(rule, field).toBeDefined()
      if (rule?.const !== undefined) expect(value).toBe(rule.const)
      if (rule?.enum) expect(rule.enum).toContain(value)
      if (rule?.pattern) expect(String(value)).toMatch(new RegExp(rule.pattern))
    }
    expect(notice.push).toBe('phone')
  })
})

describe('postAicoNotice', () => {
  it("posts the notice and its resolve to Aico's notify on loopback, never a CLI", async () => {
    const got: { url: string; body: unknown }[] = []
    const server = createServer((req, res) => {
      let text = ''
      req.on('data', (part: Buffer) => {
        text += part.toString('utf8')
      })
      req.on('end', () => {
        got.push({ url: req.url ?? '', body: JSON.parse(text) })
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ id: 'n1', repeat: false }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const env = { AICO_WEB_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` }
      const notice = noticeFor({ session: blocked(1) }, TOOLS, ORIGIN)
      await postAicoNotice(env, '/api/notices', notice, 'waiting_notice')
      const resolve = { source: 'aico', key: notice.key, text: 'No longer waits.' }
      await postAicoNotice(env, '/api/notices/resolve', resolve, 'waiting_resolve')
      expect(got).toEqual([
        { url: '/api/notices', body: notice },
        { url: '/api/notices/resolve', body: resolve },
      ])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('logs and swallows an unreachable Aico', async () => {
    await expect(
      postAicoNotice({ AICO_WEB_URL: 'http://127.0.0.1:9' }, '/api/notices', {}, 'x'),
    ).resolves.toBeUndefined()
  })
})

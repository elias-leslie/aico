import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  noticeFor,
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
  it('sends one tray notice after 2 minutes blocked and unseen, and resolves it once answered', () => {
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
        push: 'tray',
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

  it('a workflow run waiting for an answer gets its own notice, resolved when it leaves the list', () => {
    const h = harness()
    const run = {
      id: 'run:r1',
      kind: 'run',
      group: 'needs-you',
      at: h.now(),
      title: 'Nightly lint',
      headline: 'lint-fix needs a decision',
      url: 'https://hub.example.dev/runs/r1',
    }
    h.waiting.runs({ status: 'ok', items: [run] })
    h.advance(WAIT_NOTICE_MS)
    expect(h.sent[0]).toMatchObject({
      key: 'aico-run:run:r1',
      title: 'Workflow waiting: Nightly lint',
      body: 'lint-fix needs a decision',
    })
    expect(h.sent[0].open).toBeUndefined()
    h.waiting.runs({ status: 'unavailable', items: [] })
    expect(h.resolved).toHaveLength(0)
    h.waiting.runs({ status: 'ok', items: [] })
    expect(h.resolved).toEqual(['aico-run:run:r1'])
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

const hasNightshift = (() => {
  try {
    execFileSync('nightshift', ['push', '--schema'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe('notice contract v1', () => {
  // Nightshift only opens links on its allowed origins.
  const AICO = 'https://aico.summitflow.dev'
  const notices: [string, WaitingNotice][] = [
    ['session', noticeFor({ session: blocked(1) }, TOOLS, AICO)],
    [
      'run',
      noticeFor(
        {
          run: {
            id: 'run:r1',
            kind: 'run',
            group: 'needs-you',
            at: 1,
            title: 'Nightly lint',
            headline: null,
            url: `${AICO}/runs/r1`,
          },
        },
        TOOLS,
        AICO,
      ),
    ],
  ]
  it.skipIf(!hasNightshift).each(notices)('Nightshift accepts the %s notice', (_name, notice) => {
    const out = execFileSync('nightshift', ['push', '--json', '--dry-run'], {
      input: JSON.stringify(notice),
    })
    expect(String(out).length).toBeGreaterThan(0)
  })
})

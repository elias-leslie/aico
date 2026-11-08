import { describe, expect, it } from 'vitest'
import {
  actionsFor,
  askChain,
  type CaretakerDeps,
  type CaretakerEvent,
  emptyState,
  POLICY,
  type Policy,
  type ProblemRow,
  parseAnswer,
  pass,
  question,
  routeCheck,
} from './caretaker'

const POLICY_FOR_TEST: Policy = {
  ...POLICY,
  settle_minutes: 10,
  verify_minutes: 10,
  actions: [
    {
      id: 'rerun-x',
      what: 'Run it again',
      rows: ['jobs/x'],
      argv: ['aico', 'routines', 'run', 'x'],
    },
    { id: 'heal', what: 'Heal', rows: ['*/web'], argv: ['aico', 'service', 'heal', 'aico'] },
  ],
}
const MIN = 60_000

const job: ProblemRow = {
  id: 'jobs/x',
  what: 'Job X',
  kind: 'job',
  machine: 'here',
  shown: 'failed',
  meaning: 'It failed.',
}
const web: ProblemRow = { ...job, id: 'here/web', what: 'Web', kind: 'service' }

function harness(
  rows: ProblemRow[],
  answer: () => { diagnosis: string; action: string } | { failed: string },
) {
  let clock = 1_000_000 * MIN
  const events: CaretakerEvent[] = []
  const ran: string[][] = []
  const notices: Record<string, unknown>[] = []
  const resolved: string[] = []
  const questions: string[] = []
  const box = { rows, code: 0 }
  const deps: CaretakerDeps = {
    now: () => clock,
    rows: async () => box.rows,
    ask: async (text) => {
      questions.push(text)
      const out = answer()
      return 'failed' in out ? out : { ...out, model: 'm' }
    },
    run: async (argv) => {
      ran.push(argv)
      return { code: box.code, output: '' }
    },
    notify: async (notice) => {
      notices.push(notice)
    },
    resolve: async (key) => {
      resolved.push(key)
    },
    log: (event) => events.push(event),
  }
  const state = emptyState()
  return {
    box,
    deps,
    state,
    events,
    ran,
    notices,
    resolved,
    questions,
    advance: (minutes: number) => {
      clock += minutes * MIN
    },
    go: () => pass(POLICY_FOR_TEST, state, deps),
  }
}
const whats = (events: CaretakerEvent[]) => events.map((event) => event.what)

describe('caretaker pass', () => {
  it('waits for self-healing, acts once, then sees it cleared', async () => {
    const h = harness([job], () => ({ diagnosis: 'Flaky.', action: 'rerun-x' }))
    await h.go()
    expect(h.ran).toEqual([])
    h.advance(10)
    await h.go()
    expect(h.ran).toEqual([['aico', 'routines', 'run', 'x']])
    h.box.rows = [{ ...job, shown: 'ok' }]
    h.advance(5)
    await h.go()
    expect(whats(h.events)).toEqual(['diagnosed', 'acted', 'cleared'])
    expect(h.notices).toEqual([])
  })

  it('runs only what the list has for that row, and logs the refusal', async () => {
    for (const action of ['delete-backups', 'heal', 'rm -rf /']) {
      const h = harness([job], () => ({ diagnosis: 'Hm.', action }))
      await h.go()
      h.advance(10)
      await h.go()
      expect(h.ran).toEqual([])
      expect(whats(h.events)).toContain('refused')
    }
  })

  it('tries one thing per problem and does not ask again', async () => {
    const h = harness([job], () => ({ diagnosis: 'Flaky.', action: 'rerun-x' }))
    await h.go()
    for (let i = 0; i < 6; i++) {
      h.advance(10)
      await h.go()
    }
    expect(h.ran.length).toBe(1)
    expect(h.questions.length).toBe(1)
    expect(whats(h.events)).toEqual(['diagnosed', 'acted', 'stayed'])
    // A job that isn't serious stays on Status: no phone.
    expect(h.notices).toEqual([])
  })

  it('a problem that comes straight back is the same problem until the retry window', async () => {
    const h = harness([job], () => ({ diagnosis: 'Flaky.', action: 'rerun-x' }))
    await h.go()
    h.advance(10)
    await h.go()
    h.box.rows = []
    h.advance(5)
    await h.go()
    h.box.rows = [job]
    h.advance(30)
    await h.go()
    h.advance(30)
    await h.go()
    expect(h.ran.length).toBe(1)
  })

  it('a serious row still down gets one notice, under the sustained key, and it ends when well', async () => {
    const h = harness([web], () => ({ diagnosis: 'Crashing.', action: 'heal' }))
    await h.go()
    h.advance(10)
    await h.go()
    h.advance(10)
    await h.go()
    h.advance(10)
    await h.go()
    expect(h.notices.length).toBe(1)
    expect(h.notices[0]).toMatchObject({
      interrupt: 'outage',
      key: 'status-sustained:here/web',
      source: 'aico',
    })
    h.box.rows = [{ ...web, shown: 'ok' }]
    h.advance(1)
    await h.go()
    expect(h.resolved).toEqual(['status-sustained:here/web'])
  })

  it('a failed backup never interrupts from here: Status tells after its retry window', async () => {
    const backup = { ...job, id: 'here/backup/x', kind: 'backup' }
    const h = harness([backup], () => ({ diagnosis: 'Hm.', action: 'none' }))
    await h.go()
    h.advance(10)
    await h.go()
    expect(h.notices).toEqual([])
  })

  it('stays off rows that are off, ignored, warnings or not its kind', async () => {
    const h = harness(
      [
        { ...job, machine_off: true },
        { ...job, id: 'here/check-sudo', kind: 'check' },
        { ...job, id: 'jobs/y', shown: 'warn' },
        { ...job, id: 'g', kind: 'grant' },
      ],
      () => ({ diagnosis: '', action: 'rerun-x' }),
    )
    await h.go()
    h.advance(60)
    await h.go()
    expect(h.questions).toEqual([])
  })

  it('spends nothing on a row with no action unless it is serious', async () => {
    const h = harness([{ ...job, id: 'jobs/other' }], () => ({ diagnosis: '', action: 'none' }))
    await h.go()
    h.advance(20)
    await h.go()
    h.advance(20)
    await h.go()
    expect(h.questions).toEqual([])
    expect(whats(h.events)).toEqual(['skipped'])
  })

  it('holds to the daily limits and says so once', async () => {
    const h = harness([job], () => ({ diagnosis: 'd', action: 'none' }))
    h.state.day = new Date(1_000_000 * MIN + 10 * MIN).toISOString().slice(0, 10)
    h.state.calls = POLICY.max_model_calls_per_day
    await h.go()
    h.advance(10)
    await h.go()
    h.advance(10)
    await h.go()
    expect(h.questions).toEqual([])
    expect(whats(h.events)).toEqual(['limit'])
  })

  it('no model answering is logged once and tries again later', async () => {
    let up = false
    const h = harness([job], () =>
      up ? { diagnosis: 'd', action: 'rerun-x' } : { failed: 'all down' },
    )
    await h.go()
    h.advance(10)
    await h.go()
    h.advance(10)
    await h.go()
    expect(h.questions).toHaveLength(1)
    expect(whats(h.events)).toEqual(['no-model'])
    up = true
    h.advance(POLICY_FOR_TEST.no_model_wait_minutes)
    await h.go()
    expect(h.ran.length).toBe(1)
  })

  it('a failed action stops there', async () => {
    const h = harness([job], () => ({ diagnosis: 'd', action: 'rerun-x' }))
    h.box.code = 1
    await h.go()
    h.advance(10)
    await h.go()
    h.advance(10)
    await h.go()
    expect(h.ran.length).toBe(1)
    expect(whats(h.events)).toEqual(['diagnosed', 'acted', 'stayed'])
  })
})

describe('caretaker reaches the owner whatever else fails', () => {
  const storage: ProblemRow = { ...job, id: 'here/check-storage', kind: 'check', what: 'Disk' }

  it('a notice that fails is sent on the next pass, and the row is not asked about again', async () => {
    const h = harness([storage], () => ({ diagnosis: 'full', action: 'none' }))
    const notify = h.deps.notify
    let down = true
    h.deps.notify = async (notice) => {
      if (down) throw new Error('tray is down')
      await notify(notice)
    }
    await h.go()
    h.advance(11)
    await h.go()
    expect(h.notices).toHaveLength(0)
    expect(whats(h.events)).toContain('notify-failed')
    down = false
    await h.go()
    await h.go()
    expect(h.notices).toHaveLength(1)
    expect(h.questions).toHaveLength(1)
  })

  it('a serious row is told when the daily limits are used up, without asking', async () => {
    const h = harness([storage], () => ({ diagnosis: 'full', action: 'none' }))
    await h.go()
    h.advance(11)
    h.state.calls = POLICY_FOR_TEST.max_model_calls_per_day
    await h.go()
    expect(h.notices).toHaveLength(1)
    expect(h.questions).toHaveLength(0)
  })

  it('no model: one ask, none until the wait is over, and a bad row stops nothing', async () => {
    const h = harness([job, { ...job, id: 'jobs/y' }], () => ({ failed: 'both down' }))
    h.deps.ask = async (text) => {
      h.questions.push(text)
      throw new Error('both down')
    }
    await h.go()
    h.advance(11)
    await h.go()
    await h.go()
    expect(h.questions).toHaveLength(1)
    h.advance(POLICY_FOR_TEST.no_model_wait_minutes + 1)
    await h.go()
    expect(h.questions).toHaveLength(2)
    expect(whats(h.events).filter((what) => what === 'no-model')).toHaveLength(1)
  })

  it('a strange row id still makes a notice key the notice rules accept', async () => {
    const h = harness([{ ...web, id: 'here/a b;$(id)' }], () => ({
      diagnosis: 'full',
      action: 'none',
    }))
    await h.go()
    h.advance(11)
    await h.go()
    expect(h.notices[0]?.key).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.:/@+=,-]{0,199}$/)
  })

  it('names an outage for a service, and needs-you for a serious check', async () => {
    const h = harness([web, storage], () => ({ diagnosis: 'd', action: 'none' }))
    await h.go()
    h.advance(11)
    await h.go()
    expect(h.notices.map((notice) => notice.interrupt).sort()).toEqual(['needs-you', 'outage'])
  })

  it('reads the first object when a model says it twice, and caps a long action', () => {
    const one = '{"diagnosis":"d {x} \\" }","action":"none"}'
    expect(parseAnswer(`${one}\n${one}`)).toEqual({ diagnosis: 'd {x} " }', action: 'none' })
    expect(parseAnswer({ diagnosis: 'd', action: 'x'.repeat(5000) })?.action).toHaveLength(80)
  })
})

describe('caretaker question and answers', () => {
  it('gives the model the row, its actions and masked evidence', () => {
    const text = question(
      POLICY_FOR_TEST,
      job,
      actionsFor(POLICY_FOR_TEST, 'jobs/x'),
      'password=hunter2hunter2',
    )
    expect(text).toContain('rerun-x')
    expect(text).not.toContain('heal:')
  })

  it('reads an answer with or without a fence, and turns down anything else', () => {
    expect(parseAnswer('```json\n{"diagnosis":"d","action":"none"}\n```')).toEqual({
      diagnosis: 'd',
      action: 'none',
    })
    expect(parseAnswer({ diagnosis: 'd', action: 'x' })).toEqual({ diagnosis: 'd', action: 'x' })
    expect(parseAnswer('no json here')).toBeNull()
    expect(parseAnswer({ action: 'x' })).toBeNull()
  })

  it('falls from the subscription to the free tier, and says why when nothing answers', async () => {
    const down = { sub: async () => ({ failed: 'signed out' }) }
    expect(
      await askChain(POLICY, 'q', {
        ...down,
        free: async () => '{"diagnosis":"d","action":"none"}',
      }),
    ).toEqual({ diagnosis: 'd', action: 'none', model: POLICY.free_tier_models[0] })
    const failed = await askChain(POLICY, 'q', {
      ...down,
      free: async () => {
        throw new Error('no key')
      },
    })
    expect('failed' in failed && failed.failed).toContain('signed out')
    expect('failed' in failed && failed.failed).toContain('no key')
  })

  it('the shipped policy gives no action any way to delete, deploy, publish or send', () => {
    for (const action of POLICY.actions) {
      const words = action.argv.join(' ')
      expect(words).not.toMatch(/\b(rm|forget|prune|deploy|rebuild|publish|digest|dadbot-digest)\b/)
      if (action.argv[0] === 'sudo')
        expect(action.argv.slice(1, 5)).toEqual(['-n', 'systemctl', '--no-ask-password', 'start'])
    }
  })
})

describe('caretaker route check', () => {
  const up = { sub: async () => ({ text: 'ready' }), free: async () => 'ready' }
  const subDown = { ...up, sub: async () => ({ failed: 'signed out' }) }
  const freeDown = {
    ...up,
    free: async () => {
      throw new Error('quota')
    },
  }
  it('says which route answers', async () => {
    expect((await routeCheck(POLICY, up)).state).toBe('ok')
    expect(await routeCheck(POLICY, subDown)).toMatchObject({
      state: 'warn',
      meaning: expect.stringContaining('signed out'),
    })
    expect(await routeCheck(POLICY, freeDown)).toMatchObject({
      state: 'warn',
      meaning: expect.stringContaining('quota'),
    })
    expect((await routeCheck(POLICY, { ...subDown, free: freeDown.free })).state).toBe('failed')
  })
})

describe('caretaker with no model', () => {
  it('still tells the owner about a serious row', async () => {
    const disk = { ...job, id: 'here/check-storage', what: 'Disk', kind: 'check' as const }
    const h = harness([disk, job], () => ({ failed: 'all down' }))
    await h.go()
    h.advance(10)
    await h.go()
    expect(h.notices.length).toBe(1)
    expect(h.notices[0]).toMatchObject({ interrupt: 'needs-you' })
  })
})

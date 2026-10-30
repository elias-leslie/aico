import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bindCatalog, insertWidget, removeWidget } from './lifecycle/catalog'
import { Store } from './store'
import {
  applyWakePolicyPatch,
  cleanNote,
  DEFAULT_WAKE_POLICY,
  type EndedSession,
  inputLineEmpty,
  parseStoredWakePolicy,
  WAKE_RELAUNCH_RETRY_MS,
  type WakeOperations,
  WakePolicyError,
  WakeScheduler,
  WakeStore,
  wakeJson,
  wakeMessage,
} from './wakes'

const stores: Store[] = []
function open(path = ':memory:'): Store {
  const store = new Store(path, () => 1_000)
  stores.push(store)
  bindCatalog(store.db)
  return store
}
afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close()
    } catch {
      // already closed
    }
  }
})

const SESSION = '0a1b2c3d'
const ENDED: EndedSession = {
  id: SESSION,
  tool: 'codex',
  projectId: 'aico',
  projectRoot: '/srv/workspaces/projects/aico',
  name: 'Wakes',
  origin: 'aico',
  coordinator: false,
  coordinatorId: null,
  resumeId: '019a0000-0000-7000-8000-000000000001',
}

function storeWithSession(): { store: Store; wakes: WakeStore } {
  const store = open()
  insertWidget(SESSION, 'codex', 1_000, { origin: 'aico' })
  let n = 0
  const next = () => {
    n += 1
    return `${n}`.padStart(12, '0')
  }
  return { store, wakes: new WakeStore(store.db, next) }
}

describe('wake policy', () => {
  it('validates patches against the bounds', () => {
    expect(applyWakePolicyPatch(DEFAULT_WAKE_POLICY, { tonightHour: 22 }).tonightHour).toBe(22)
    expect(() => applyWakePolicyPatch(DEFAULT_WAKE_POLICY, { tonightHour: 24 })).toThrow(
      WakePolicyError,
    )
    expect(() => applyWakePolicyPatch(DEFAULT_WAKE_POLICY, { laterMinutes: 1.5 })).toThrow(
      WakePolicyError,
    )
    expect(() => applyWakePolicyPatch(DEFAULT_WAKE_POLICY, { nope: 1 })).toThrow(/unknown/)
  })

  it('reads a stored value leniently', () => {
    expect(parseStoredWakePolicy(null)).toEqual(DEFAULT_WAKE_POLICY)
    expect(parseStoredWakePolicy('{bad')).toEqual(DEFAULT_WAKE_POLICY)
    expect(parseStoredWakePolicy('{"morningHour":7,"quietSeconds":-1}')).toEqual({
      ...DEFAULT_WAKE_POLICY,
      morningHour: 7,
    })
  })
})

describe('wake store', () => {
  it('drops a session’s wakes at End unless they were kept', () => {
    const { wakes } = storeWithSession()
    const plain = wakes.add({
      sessionId: SESSION,
      dueAt: 5_000,
      note: 'a',
      createdBy: 'agent',
      now: 1,
    })
    removeWidget(SESSION)
    expect(wakes.get(plain.id)).toBeUndefined()

    insertWidget('0a1b2c3e', 'codex', 1_000, { origin: 'aico' })
    const kept = wakes.add({
      sessionId: '0a1b2c3e',
      dueAt: 5_000,
      note: 'b',
      createdBy: 'owner',
      now: 1,
    })
    expect(wakes.keep('0a1b2c3e', { ...ENDED, id: '0a1b2c3e' })).toBe(1)
    removeWidget('0a1b2c3e')
    const after = wakes.get(kept.id)
    expect(after).toMatchObject({ sessionId: null, kept: true, endedSession: { id: '0a1b2c3e' } })
    // The public shape names the ended session but not its conversation.
    expect(wakeJson(after as never)).toMatchObject({
      endedSession: { id: '0a1b2c3e', name: 'Wakes' },
    })
    expect(JSON.stringify(wakeJson(after as never))).not.toContain(ENDED.resumeId)
  })

  it('unkeeps after an End that did not happen and attaches to a holder', () => {
    const { wakes } = storeWithSession()
    const wake = wakes.add({
      sessionId: SESSION,
      dueAt: 5_000,
      note: 'a',
      createdBy: 'agent',
      now: 1,
    })
    wakes.keep(SESSION, ENDED)
    wakes.unkeep(SESSION)
    expect(wakes.get(wake.id)).toMatchObject({ kept: false, endedSession: null })
    wakes.failed(wake.id, 'x')
    expect(wakes.get(wake.id)?.attempts).toBe(1)
    expect(wakes.update(wake.id, { dueAt: 9_000 })).toMatchObject({ dueAt: 9_000, attempts: 0 })
    wakes.attach(wake.id, SESSION)
    expect(wakes.get(wake.id)).toMatchObject({ sessionId: SESSION, lastError: null })
  })

  it('is created by the v10 migration on a v9 database', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tether-wakes-')), 'tether.db')
    const old = open(path)
    old.db.exec(`DROP TRIGGER sessions_end_wakes; DROP TABLE wakes;
      DELETE FROM schema_version WHERE version >= 10`)
    old.close()
    const migrated = open(path)
    insertWidget(SESSION, 'codex', 1_000, { origin: 'aico' })
    const wakes = new WakeStore(migrated.db)
    wakes.add({ sessionId: SESSION, dueAt: 5_000, note: 'a', createdBy: 'agent', now: 1 })
    removeWidget(SESSION)
    expect(wakes.list()).toEqual([])
  })
})

describe('wake message and note', () => {
  const wake = (dueAt: number, note: string) =>
    ({ id: 'x', sessionId: SESSION, dueAt, note }) as never
  it('says when it was due, how late and whether it resumed after End', () => {
    const due = new Date(2026, 9, 26, 17, 30).getTime()
    expect(wakeMessage([wake(due, 'check lanes')], due + 60_000, DEFAULT_WAKE_POLICY)).toBe(
      '[Scheduled check-in for 5:30 PM] check lanes',
    )
    expect(
      wakeMessage([wake(due, 'a'), wake(due + 1, 'b')], due + 12 * 60_000, DEFAULT_WAKE_POLICY, {
        resumed: true,
      }),
    ).toBe('[Scheduled check-in for 5:30 PM, 12 min late, resumed after End] a / b')
    expect(wakeMessage([wake(due, 'a')], due + 24 * 3600_000, DEFAULT_WAKE_POLICY)).toMatch(
      /^\[Scheduled check-in for Mon 5:30 PM, 1440 min late\] a$/,
    )
  })

  it('keeps one clean line within the limit', () => {
    expect(cleanNote('  check\nthe\tlanes ', 500)).toBe('check the lanes')
    expect(cleanNote('', 500)).toBeNull()
    expect(cleanNote('x'.repeat(21), 20)).toBeNull()
    expect(cleanNote('bad \x1b[31m', 500)).toBeNull()
    expect(cleanNote(5, 500)).toBeNull()
  })
})

describe('input line', () => {
  // Shapes from capture-pane -p -e of the live agents.
  const codex = (input: string) =>
    [
      '• Done.',
      '',
      `\x1b[1m›\x1b[0m ${input}`,
      '',
      '  \x1b[2mgpt-5.5 high · 41% left · ~/aico\x1b[0m',
    ].join('\n')
  const claude = (input: string, more: string[] = []) =>
    [
      '● Done.',
      '',
      '\x1b[2m────────────────────────────────────────\x1b[0m',
      `❯\xa0${input}`,
      ...more,
      '\x1b[2m────────────────────────────────────────\x1b[0m',
      '  \x1b[2m? for shortcuts\x1b[0m',
    ].join('\n')

  it('sees an empty prompt behind a dim placeholder', () => {
    expect(inputLineEmpty(codex('\x1b[2mAsk Codex to do anything\x1b[0m'))).toBe(true)
    expect(inputLineEmpty(claude(''))).toBe(true)
    expect(inputLineEmpty(claude('\x1b[2mTry "fix lint errors"\x1b[0m'))).toBe(true)
  })

  it('does not take a truecolor or 256-color draft for a dim placeholder', () => {
    expect(inputLineEmpty(codex('\x1b[38;2;176;176;176mhalf a thought\x1b[0m'))).toBe(false)
    expect(inputLineEmpty(codex('\x1b[38;5;2mhalf a thought\x1b[0m'))).toBe(false)
    expect(inputLineEmpty(codex('\x1b[38:2::176:2:176mhalf a thought\x1b[0m'))).toBe(false)
    expect(inputLineEmpty(codex('\x1b[38;2;1;2;3;2mplaceholder\x1b[0m'))).toBe(true)
  })

  it('sees a draft, including one wrapped onto more lines', () => {
    expect(inputLineEmpty(codex('half a thought'))).toBe(false)
    expect(inputLineEmpty(claude('first line', ['  second line']))).toBe(false)
    expect(inputLineEmpty(claude('', ['  pasted below']))).toBe(false)
  })

  it('waits when there is no prompt line', () => {
    expect(inputLineEmpty('Working… (esc to interrupt)')).toBe(false)
    expect(inputLineEmpty('')).toBe(false)
  })

  // Pi draws its editor between two truecolor rules, with no prompt mark and
  // a reverse-video cursor; the top rule carries `Working` while it runs.
  const rule = (label = '') =>
    `\x1b[38;2;143;106;225m${label ? `── ${label} ` : ''}${'─'.repeat(60)}`
  const pi = (input: string[], top = rule()) =>
    [
      ' \x1b[38;2;162;144;213m- \x1b[1m\x1b[39mDone\x1b[0m: verdict submit.',
      '   \x1b[38;2;150;159;164m────────────────────────────────\x1b[39m',
      '',
      top,
      ...input,
      rule(),
      '\x1b[38;2;119;129;135m~/.local/share/aico/blank-slate/neri-gitlab-r1\x1b[39m',
      '\x1b[38;2;119;129;135m↑52k ↓19k 5.2%/1.0M (auto)      (opencode-go) deepseek-v4.1-flash • high',
    ].join('\n')

  it('reads Pi’s ruled editor: empty only with nothing between the rules', () => {
    expect(inputLineEmpty(pi(['\x1b[7m\x1b[39m \x1b[0m']), 'ruled')).toBe(true)
    // The same screen read for a prompt mark finds none and waits: the old bug.
    expect(inputLineEmpty(pi(['\x1b[7m\x1b[39m \x1b[0m']))).toBe(false)
    expect(inputLineEmpty(pi(['half a thought\x1b[7m \x1b[0m']), 'ruled')).toBe(false)
    expect(inputLineEmpty(pi(['first line', '\x1b[7m \x1b[0m']), 'ruled')).toBe(false)
    expect(inputLineEmpty(pi(['more\x1b[7m \x1b[0m'], rule('↑ 2 more')), 'ruled')).toBe(false)
    expect(
      inputLineEmpty(pi(['\x1b[7m\x1b[39m \x1b[0m'], rule('\x1b[39m⠧ Working')), 'ruled'),
    ).toBe(false)
    expect(inputLineEmpty(`${rule()}\n${rule()}`, 'ruled')).toBe(false)
    expect(inputLineEmpty('', 'ruled')).toBe(false)
  })
})

describe('wake scheduler', () => {
  function harness(overrides: Partial<WakeOperations> = {}) {
    const { wakes } = storeWithSession()
    const clock = { now: 10_000 }
    const log = {
      delivered: [] as string[],
      reopened: [] as string[],
      relaunched: [] as string[],
      changed: [] as (string | null)[],
      lines: [] as string[],
    }
    const state = { idle: true, empty: true, lastKey: null as number | null, deliver: true }
    const ops: WakeOperations = {
      now: () => clock.now,
      policy: () => DEFAULT_WAKE_POLICY,
      busy: async () => (state.idle ? null : 'the agent is working (claude-status)'),
      inputEmpty: async () => state.empty,
      lastKeyAt: async () => state.lastKey,
      deliver: async (_id, text) => {
        if (state.deliver) log.delivered.push(text)
        return state.deliver
      },
      reopen: (id) => log.reopened.push(id),
      conversationHolder: async () => null,
      relaunch: async (_ended, message) => {
        log.relaunched.push(message)
        return { status: 'started', id: 'ffff0000' }
      },
      changed: (id) => log.changed.push(id),
      log: (line) => log.lines.push(line),
      ...overrides,
    }
    const scheduler = new WakeScheduler(wakes, ops)
    const add = (dueAt: number, note: string) =>
      wakes.add({ sessionId: SESSION, dueAt, note, createdBy: 'agent', now: 0 })
    return { wakes, clock, log, state, scheduler, add }
  }

  it('delivers due wakes together, once, and leaves later ones', async () => {
    const { wakes, log, scheduler, add } = harness()
    add(9_000, 'first')
    add(9_500, 'second')
    const later = add(60_000, 'later')
    await scheduler.tick()
    expect(log.delivered).toHaveLength(1)
    expect(log.delivered[0]).toMatch(/\] first \/ second$/)
    expect(log.reopened).toEqual([SESSION])
    expect(wakes.list().map((wake) => wake.id)).toEqual([later.id])
    await scheduler.tick()
    expect(log.delivered).toHaveLength(1)
  })

  it('waits for idle, a quiet keyboard and an empty input line', async () => {
    const { wakes, clock, log, state, scheduler, add } = harness()
    add(9_000, 'note')
    state.idle = false
    await scheduler.tick()
    state.idle = true
    state.lastKey = clock.now - 5_000
    await scheduler.tick()
    state.lastKey = clock.now - 20_000
    state.empty = false
    await scheduler.tick()
    expect(log.delivered).toEqual([])
    expect(wakes.list()).toHaveLength(1)
    // Asked to reopen the window, and republished as due, only once while it waits.
    expect(log.reopened).toEqual([SESSION])
    expect(log.changed).toEqual([SESSION])
    state.empty = true
    await scheduler.tick()
    expect(log.delivered).toHaveLength(1)
  })

  it('logs each reason an overdue wake waits, once, and delivers when it clears', async () => {
    const { wakes, clock, log, state, scheduler, add } = harness()
    add(9_000, 'note')
    state.idle = false
    await scheduler.tick()
    await scheduler.tick()
    expect(log.lines).toEqual([
      `check-in for session=${SESSION} waits: the agent is working (claude-status)`,
    ])
    expect(scheduler.heldReason(SESSION)).toBe('the agent is working (claude-status)')
    state.idle = true
    state.empty = false
    await scheduler.tick()
    expect(log.lines.at(-1)).toBe(
      `check-in for session=${SESSION} waits: the input line holds a draft`,
    )
    // An hour overdue, the gates clear and it still goes out.
    clock.now += 3_600_000
    state.empty = true
    await scheduler.tick()
    expect(log.delivered).toHaveLength(1)
    expect(log.delivered[0]).toMatch(/60 min late\] note$/)
    expect(log.lines.at(-1)).toBe(
      `delivered 1 check-in(s) to session=${SESSION} after waiting 60 min (last: the input line holds a draft)`,
    )
    expect(scheduler.heldReason(SESSION)).toBeNull()
    expect(wakes.list()).toEqual([])
  })

  it('puts the wake back when the paste did not happen', async () => {
    const { wakes, log, state, scheduler, add } = harness()
    const wake = add(9_000, 'note')
    state.deliver = false
    await scheduler.tick()
    expect(wakes.get(wake.id)).toMatchObject({ note: 'note' })
    expect(log.changed).toContain(SESSION)
  })

  it('does not send a wake cancelled while the gates were checked', async () => {
    let cancel = () => {}
    const { log, scheduler, add, wakes } = harness({
      inputEmpty: async () => {
        cancel()
        return true
      },
    })
    const wake = add(9_000, 'note')
    cancel = () => void wakes.remove(wake.id)
    await scheduler.tick()
    expect(log.delivered).toEqual([])
  })

  it('relaunches a kept wake as a resumed conversation', async () => {
    const { wakes, log, scheduler, add } = harness()
    const wake = add(9_000, 'note')
    wakes.keep(SESSION, ENDED)
    removeWidget(SESSION)
    expect(wakes.get(wake.id)?.sessionId).toBeNull()
    await scheduler.tick()
    expect(log.relaunched).toEqual([expect.stringMatching(/resumed after End\] note$/)])
    expect(wakes.list()).toEqual([])
  })

  it('gives a kept wake to the session that already resumed its conversation', async () => {
    const { wakes, log, scheduler } = harness({ conversationHolder: async () => SESSION })
    insertWidget('0a1b2c3e', 'codex', 1_000, { origin: 'aico' })
    const wake = wakes.add({
      sessionId: '0a1b2c3e',
      dueAt: 9_000,
      note: 'n',
      createdBy: 'agent',
      now: 0,
    })
    wakes.keep('0a1b2c3e', { ...ENDED, id: '0a1b2c3e' })
    removeWidget('0a1b2c3e')
    await scheduler.tick()
    expect(log.relaunched).toEqual([])
    expect(wakes.get(wake.id)?.sessionId).toBe(SESSION)
    // A started scheduler runs the next pass at once; this one is stopped.
    await scheduler.tick()
    expect(log.delivered).toHaveLength(1)
    expect(wakes.get(wake.id)).toBeUndefined()
  })

  it('retries a failed relaunch later and stops after the attempts run out', async () => {
    const outcomes: ('retry' | 'failed')[] = ['retry', 'failed', 'failed']
    const { wakes, clock, log, scheduler, add } = harness({
      policy: () => ({ ...DEFAULT_WAKE_POLICY, relaunchAttempts: 2 }),
      relaunch: async (_ended, message) => {
        log.relaunched.push(message)
        return { status: outcomes.shift() ?? 'failed', reason: 'busy' }
      },
    })
    const wake = add(9_000, 'note')
    wakes.keep(SESSION, ENDED)
    removeWidget(SESSION)
    await scheduler.tick()
    // An admission "not now" does not count as a failed attempt.
    expect(wakes.get(wake.id)?.attempts).toBe(0)
    await scheduler.tick()
    expect(log.relaunched).toHaveLength(1)
    for (const _ of [1, 2, 3]) {
      clock.now += WAKE_RELAUNCH_RETRY_MS
      await scheduler.tick()
    }
    expect(log.relaunched).toHaveLength(3)
    expect(wakes.get(wake.id)).toMatchObject({ attempts: 2, lastError: 'busy' })
  })
})

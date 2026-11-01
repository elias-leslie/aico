import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileTail } from './agent-state'
import type { ProcFs } from './continuity'
import { ModelNotices, readModelNoticeState } from './model-notices'
import {
  bareModel,
  claudeModelEvents,
  claudeTranscriptPath,
  codexModelEvents,
  isModelSwitch,
  ModelFollower,
  type ModelSource,
  type ModelSwitch,
  ModelWatch,
  type ModelWatchOperations,
  modelSwitchText,
  piModelEvents,
  readAlternates,
  readWatchEntries,
  type WatchEntry,
  worktreeFacts,
} from './model-switch'

const FIXTURES = join(__dirname, 'test-fixtures', 'model-switch')
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8')
const SESSION = 'aaaa0001'
const CONVERSATION = '893220a2-7fbb-4968-b048-470b098be9cd'
const PROMPT = '5e434c97-6fee-44f4-9614-84f7b4b34097'

/** A record in memory, read like nodeFileTail reads one. */
function memoryTail(initial = '') {
  const file = { content: initial }
  const tail: FileTail = {
    read(_path, offset, max) {
      const bytes = Buffer.from(file.content)
      let start = offset > bytes.length ? 0 : offset
      if (bytes.length - start > max) start = bytes.length - max
      const text = bytes.subarray(start).toString()
      const end = text.lastIndexOf('\n') + 1
      return {
        text: text.slice(0, end),
        offset: start + Buffer.byteLength(text.slice(0, end)),
        size: bytes.length,
      }
    },
    range(_path, start, end) {
      return Buffer.from(file.content).subarray(start, end)
    },
  }
  return { file, tail }
}

function harness(initial: string, options: { alternates?: string[] } = {}) {
  const { file, tail } = memoryTail(initial)
  const saved: { entries: Record<string, WatchEntry> } = { entries: {} }
  const agent = { state: 'working', detail: null as string | null }
  const interrupts: string[] = []
  const changes: string[] = []
  const logs: string[] = []
  const ops: ModelWatchOperations = {
    now: () => Date.now(),
    read: () => readWatchEntries(JSON.stringify(saved.entries)),
    write: (entries) => {
      saved.entries = JSON.parse(JSON.stringify(entries))
    },
    alternates: () => options.alternates ?? [],
    agent: () => agent,
    interrupt: async (id) => {
      interrupts.push(id)
      return true
    },
    worktree: async () => ({ commit: 'e5a9695', changed: false }),
    changed: (id) => changes.push(id),
    log: (line) => logs.push(line),
  }
  const watch = new ModelWatch(ops)
  return { file, tail, saved, agent, interrupts, changes, logs, ops, watch }
}

const claude = (tail: FileTail): ModelSource => ({
  tool: 'claude',
  sessionId: CONVERSATION,
  home: '/home/test',
  // The transcript is found in its projects dir.
  fs: { readdir: () => ['x'], mtimeMs: () => 1 } as unknown as ProcFs,
  tail,
})
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(Date.parse('2026-11-01T13:19:50Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the rule', () => {
  it('is the same model across provider prefix, case, tag and snapshot date', () => {
    expect(bareModel('anthropic/Claude-Opus-5-5-20261001')).toBe('claude-opus-5-5')
    expect(isModelSwitch('claude-opus-5-5', 'claude-opus-5-5[1m]')).toBe(false)
    expect(isModelSwitch('openai-codex/gpt-5.5', 'gpt-5.5')).toBe(false)
    expect(isModelSwitch('claude-sonnet-5-5', 'claude-sonnet-5-5-2026-10-01')).toBe(false)
    expect(isModelSwitch('claude-opus-5-5', 'claude-opus-4-8')).toBe(true)
    expect(isModelSwitch(null, 'claude-opus-4-8')).toBe(false)
  })
})

describe('Claude Code', () => {
  it('reads the incident: a refusal fallback, typed fields only', () => {
    const events = fixture('claude-incident-2026-11-01.jsonl')
      .split('\n')
      .flatMap((line) => claudeModelEvents(line))
    expect(events.map((e) => e.type)).toEqual([
      'prompt',
      'served',
      'refused',
      'refusal',
      'served',
      'served',
    ])
    expect(events[3]).toEqual({
      type: 'refusal',
      from: 'claude-opus-5-5',
      to: 'claude-opus-4-8',
      category: 'cyber',
      key: expect.stringMatching(/^req_011CgcGvz/),
      at: Date.parse('2026-11-01T13:19:38.260Z'),
    })
  })

  it('stops the incident turn once, and again when the fallback answers later', async () => {
    const h = harness(fixture('claude-incident-2026-11-01.jsonl'))
    const watch = new ModelWatch(h.ops)
    watch.see(SESSION, claude(h.tail), h.tail)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.interrupts).toEqual([SESSION])
    expect(watch.switchOf(SESSION)).toMatchObject({
      kind: 'refusal',
      from: 'claude-opus-5-5',
      to: 'claude-opus-4-8',
      category: 'cyber',
      stopped: true,
      checked: false,
      rewindTo: PROMPT,
    })
    // The same rows again: one switch, one stop.
    watch.see(SESSION, claude(h.tail), h.tail)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(h.interrupts).toHaveLength(1)
    expect(watch.switchOf(SESSION)).toMatchObject({
      commit: 'e5a9695',
      worktreeChanged: false,
      checked: true,
    })
    // A new turn on the fallback: stopped again (not within 5 s of the last).
    await vi.advanceTimersByTimeAsync(5_000)
    h.file.content += `${JSON.stringify({
      type: 'assistant',
      isSidechain: false,
      uuid: '11111111-1111-4111-8111-111111111111',
      timestamp: '2026-11-01T13:21:00Z',
      message: { model: 'claude-opus-4-8', role: 'assistant', stop_reason: 'tool_use' },
    })}\n`
    watch.see(SESSION, claude(h.tail), h.tail)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.interrupts).toHaveLength(2)
    // The follow survives a restart: nothing new to stop.
    const again = new ModelWatch(h.ops)
    again.see(SESSION, claude(h.tail), h.tail)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.interrupts).toHaveLength(2)
    expect(again.switchOf(SESSION)?.kind).toBe('refusal')
  })

  it('never presses Escape into a dialog or an idle prompt', async () => {
    const h = harness(fixture('claude-incident-2026-11-01.jsonl'))
    h.agent.state = 'blocked'
    h.agent.detail = 'dialog open'
    h.watch.see(SESSION, claude(h.tail), h.tail)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.interrupts).toEqual([])
    expect(h.watch.switchOf(SESSION)?.stopped).toBe(false)
  })

  it("reads Agent Hub's fallback fixture", () => {
    const follower = new ModelFollower()
    const found = fixture('claude-fallback.jsonl')
      .split('\n')
      .flatMap((line) => claudeModelEvents(line))
      .map((event) => follower.apply(event, 1))
      .filter(Boolean)
    expect(found).toEqual([
      expect.objectContaining({ kind: 'refusal', from: 'claude-opus-5-5', to: 'claude-opus-4-8' }),
    ])
  })

  it('a refusal that ends the turn with no switch is a pause, once the agent is out of its turn', async () => {
    const h = harness(fixture('claude-refusal-no-switch.jsonl'))
    h.watch.see(SESSION, claude(h.tail), h.tail)
    expect(h.watch.switchOf(SESSION)).toBeNull()
    h.agent.state = 'idle'
    h.watch.see(SESSION, claude(h.tail), h.tail)
    vi.advanceTimersByTime(5_000)
    h.watch.see(SESSION, claude(h.tail), h.tail)
    await vi.advanceTimersByTimeAsync(3_000)
    const paused = h.watch.switchOf(SESSION) as ModelSwitch
    expect(paused).toMatchObject({
      kind: 'paused',
      from: 'claude-opus-5-5',
      to: 'claude-opus-5-5',
      category: 'cyber',
      checked: true,
    })
    expect(h.interrupts).toEqual([])
    expect(modelSwitchText(paused, 'claude-code', 'req-1').what).toBe(
      'stopped on a cyber refusal on claude-opus-5-5: it waits on retry or another model',
    )
    // An answer (a retry went through): the pause is over.
    h.file.content += `${JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-opus-5-5', role: 'assistant', stop_reason: 'end_turn' },
    })}\n`
    h.watch.see(SESSION, claude(h.tail), h.tail)
    expect(h.watch.switchOf(SESSION)).toBeNull()
  })

  it('a pause Claude Code records itself is told at once', () => {
    const follower = new ModelFollower()
    follower.apply({ type: 'served', model: 'claude-opus-5-5', at: 1 }, 1)
    const [event] = claudeModelEvents(
      JSON.stringify({
        type: 'system',
        subtype: 'model_refusal_no_fallback',
        originalModel: 'claude-opus-5-5',
        apiRefusalCategory: 'cyber',
        requestId: 'req_X',
      }),
    )
    expect(event && follower.apply(event, 2)).toMatchObject({ kind: 'paused', category: 'cyber' })
  })

  it('a model picked in the window is told, not stopped; spelling is no switch', async () => {
    const row = (model: string) =>
      `${JSON.stringify({ type: 'assistant', message: { model, role: 'assistant' } })}\n`
    const h = harness(row('claude-opus-5-5') + row('claude-opus-5-5[1m]'))
    h.watch.see(SESSION, claude(h.tail), h.tail)
    expect(h.watch.switchOf(SESSION)).toBeNull()
    h.file.content += `${JSON.stringify({
      type: 'system',
      subtype: 'local_command',
      content: '<command-name>/model</command-name>',
    })}\n${row('claude-sonnet-5-5')}${row('claude-sonnet-5-5')}`
    h.watch.see(SESSION, claude(h.tail), h.tail)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(h.watch.switchOf(SESSION)).toMatchObject({ kind: 'changed', to: 'claude-sonnet-5-5' })
    expect(h.interrupts).toEqual([])
    h.file.content += row('claude-opus-5-5')
    h.watch.see(SESSION, claude(h.tail), h.tail)
    expect(h.watch.switchOf(SESSION)).toBeNull()
  })

  it('ignores subagents and synthetic rows', () => {
    expect(
      claudeModelEvents(
        JSON.stringify({
          type: 'assistant',
          isSidechain: true,
          message: { model: 'claude-haiku-5-5' },
        }),
      ),
    ).toEqual([])
    expect(
      claudeModelEvents(JSON.stringify({ type: 'assistant', message: { model: '<synthetic>' } })),
    ).toEqual([])
  })

  it('a model listed as an alternate is no switch; a refusal onto it still is', () => {
    const follower = new ModelFollower(undefined, ['claude-sonnet-5-5'])
    follower.apply({ type: 'served', model: 'claude-opus-5-5', at: 1 }, 1)
    expect(follower.apply({ type: 'served', model: 'claude-sonnet-5-5', at: 2 }, 2)).toBeNull()
    expect(
      follower.apply(
        {
          type: 'refusal',
          from: null,
          to: 'claude-sonnet-5-5',
          category: 'cyber',
          key: 'k',
          at: 3,
        },
        3,
      ),
    ).toMatchObject({ kind: 'refusal' })
  })

  it('finds the first model at the start of a record read late', () => {
    const row = (model: string) =>
      `${JSON.stringify({ type: 'assistant', message: { model, role: 'assistant' }, pad: 'x'.repeat(4_000) })}\n`
    const h = harness(row('claude-opus-5-5') + row('claude-opus-4-8').repeat(1_200))
    h.watch.see(SESSION, claude(h.tail), h.tail)
    expect(h.watch.switchOf(SESSION)).toMatchObject({
      kind: 'substituted',
      from: 'claude-opus-5-5',
      to: 'claude-opus-4-8',
    })
  })

  it('finds the transcript by conversation id', () => {
    const fs = {
      readdir: () => ['-a', '-b'],
      mtimeMs: (path: string) => (path.includes('/-b/') ? 1 : null),
    } as unknown as ProcFs
    expect(claudeTranscriptPath(fs, '/home/test', CONVERSATION)).toBe(
      `/home/test/.claude/projects/-b/${CONVERSATION}.jsonl`,
    )
    expect(claudeTranscriptPath(fs, '/home/test', '../x')).toBeNull()
  })
})

describe('Codex', () => {
  const line = (type: string, payload: object) =>
    JSON.stringify({ timestamp: '2026-11-01T13:00:00Z', type, payload })

  it('a changed turn context is told; a reroute is a refusal and stops the turn', async () => {
    const h = harness(
      `${line('session_meta', { id: 't' })}\n${line('turn_context', { model: 'gpt-5.5' })}\n${line('turn_context', { model: 'gpt-5.5' })}\n`,
    )
    const source: ModelSource = { tool: 'codex', path: '/r.jsonl', tail: h.tail }
    h.watch.see(SESSION, source, h.tail)
    expect(h.watch.switchOf(SESSION)).toBeNull()
    h.file.content += `${line('turn_context', { model: 'gpt-5.4' })}\n`
    h.watch.see(SESSION, source, h.tail)
    expect(h.watch.switchOf(SESSION)).toMatchObject({ kind: 'changed', to: 'gpt-5.4' })
    expect(h.interrupts).toEqual([])
    h.file.content += `${line('event_msg', {
      type: 'model_reroute',
      from_model: 'gpt-5.4',
      to_model: 'gpt-5.3',
      reason: 'high_risk_cyber_activity',
      turn_id: 'turn-1',
    })}\n`
    h.watch.see(SESSION, source, h.tail)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.watch.switchOf(SESSION)).toMatchObject({ kind: 'refusal', category: 'cyber' })
    expect(h.interrupts).toEqual([SESSION])
  })

  it('reads only turn contexts and reroutes', () => {
    expect(codexModelEvents(line('response_item', { model: 'gpt-x' }))).toEqual([])
  })
})

describe('Pi', () => {
  it("a provider's other model is a substitution and stops the turn", async () => {
    const events = fixture('pi-response-model.jsonl')
      .split('\n')
      .flatMap((l) => piModelEvents(l))
    expect(events).toEqual([
      { type: 'requested', model: 'openai-codex/gpt-5.5', at: Date.parse('2026-10-22T12:00:02Z') },
      { type: 'served', model: 'openai-codex/gpt-5.4', at: Date.parse('2026-10-22T12:00:02Z') },
    ])
    const h = harness(fixture('pi-response-model.jsonl'))
    h.watch.see(SESSION, { tool: 'pi', path: '/p.jsonl', tail: h.tail }, h.tail)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.watch.switchOf(SESSION)).toMatchObject({
      kind: 'substituted',
      from: 'openai-codex/gpt-5.5',
      to: 'openai-codex/gpt-5.4',
    })
    expect(h.interrupts).toEqual([SESSION])
  })
})

describe('worktree facts', () => {
  const run =
    (log: string | null, status: string | null) =>
    async (_c: string, args: string[]): Promise<string | null> =>
      args.includes('log') ? log : status

  it('a commit after the switch is a change', async () => {
    expect(await worktreeFacts('/p', 1_000, run('abc1234\t2\n', ''), () => null)).toEqual({
      commit: 'abc1234',
      changed: true,
    })
  })

  it('a file written after the switch is a change; older ones are not', async () => {
    const status = ' M src/a.ts\0R  new.ts\0old.ts\0?? b.txt\0'
    const times: Record<string, number> = {
      '/p/src/a.ts': 500,
      '/p/new.ts': 900,
      '/p/b.txt': 1_500,
    }
    expect(
      await worktreeFacts('/p', 1_000, run('abc1234\t0\n', status), (path) => times[path] ?? null),
    ).toEqual({ commit: 'abc1234', changed: true })
    delete times['/p/b.txt']
    expect(
      await worktreeFacts('/p', 1_000, run('abc1234\t0\n', status), (path) => times[path] ?? null),
    ).toEqual({ commit: 'abc1234', changed: false })
  })

  it('no git is unknown', async () => {
    expect(await worktreeFacts('/p', 1, run(null, null), () => null)).toEqual({
      commit: null,
      changed: null,
    })
    expect(await worktreeFacts(null, 1, run('', ''), () => null)).toEqual({
      commit: null,
      changed: null,
    })
  })
})

describe('alternates', () => {
  it('are per tool, default none', () => {
    expect(readAlternates(null)).toEqual({ claude: [], codex: [], pi: [] })
    expect(readAlternates('{"claude-code":["claude-sonnet-5-5",3],"pi":"x"}')).toEqual({
      claude: ['claude-sonnet-5-5'],
      codex: [],
      pi: [],
    })
    expect(readAlternates('not json').claude).toEqual([])
  })
})

describe('owner notice', () => {
  const change: ModelSwitch = {
    key: '1@5',
    kind: 'refusal',
    from: 'claude-opus-5-5',
    to: 'claude-opus-4-8',
    category: 'cyber',
    at: 5,
    stopped: true,
    commit: null,
    worktreeChanged: false,
    checked: true,
    rewindTo: null,
  }

  function notices() {
    const sent: { key: string; title: string; body: string }[] = []
    const resolved: string[] = []
    let state = readModelNoticeState(null)
    const n = new ModelNotices({
      origin: 'https://aico.test',
      send: (notice) => sent.push(notice),
      resolve: (key) => resolved.push(key),
      state: { read: () => state, write: (next) => (state = next) },
    })
    return { n, sent, resolved }
  }

  it('a window nobody launched tells the owner once, resolved when it is back', () => {
    const { n, sent, resolved } = notices()
    const session = { id: SESSION, tool: 'claude-code', displayTitle: 'Notes', launched: false }
    n.session({ ...session, modelSwitch: { ...change, checked: false } }, null)
    expect(sent).toHaveLength(0)
    n.session({ ...session, modelSwitch: change }, null)
    n.session({ ...session, modelSwitch: change }, null)
    expect(sent).toEqual([
      expect.objectContaining({
        key: `aico-model:${SESSION}:1@5`,
        title: 'Model changed in Notes',
        body: 'It is now on claude-opus-4-8 after a cyber refusal. Turn stopped · last commit none · worktree changed since: no · rewind it, or relaunch from a handoff.',
      }),
    ])
    n.session({ ...session, modelSwitch: null }, null)
    expect(resolved).toEqual([`aico-model:${SESSION}:1@5`])
  })

  it('a launched lane tells its launcher instead', () => {
    const { n, sent } = notices()
    n.session(
      { id: SESSION, launched: true, coordinatorId: 'bbbb0001', modelSwitch: change },
      'davion-gem',
    )
    expect(sent).toHaveLength(0)
  })
})

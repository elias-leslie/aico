// One suite, every adapter: the same checks run for Claude Code, Codex, Pi and
// Antigravity, against fixtures of the real status-file, rollout, session and
// conversation shapes. A new adapter joins by being listed in ADAPTERS.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AgentSignal } from '../../../agent-state'
import type { FileTail, ProcFs } from '../../../proc-fs'
import { DEFAULT_TOOLS } from '../../../tools'
import { ADAPTERS, adapterByHarness, adapterOf, toolSpec } from '../registry'
import type { AgySnapshot } from './agy'
import type { StateContext, TuiAdapter } from './contract'

const SESSION = '5a7741ea-e6b1-4062-853b-0d9d2e03d549'
const CODEX_ROLLOUT = `/h/.codex/sessions/2026/10/12/rollout-2026-10-12T11-03-15-${SESSION}.jsonl`
const PI_FILE = `/h/.pi/agent/sessions/--srv-p--/2026-10-26T22-19-58-537Z_${SESSION}.jsonl`
const AT = '2026-10-12T10:00:00.000Z'

function procfs(files: Record<string, string>, links: Record<string, string> = {}): ProcFs {
  const missing = (path: string) => Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' })
  return {
    readFile: (path) => {
      if (path in files) return files[path] as string
      throw missing(path)
    },
    readHead: (path, bytes) => {
      if (path in files) return (files[path] as string).slice(0, bytes)
      throw missing(path)
    },
    readdir: (path) => {
      const prefix = `${path}/`
      const names = [...Object.keys(files), ...Object.keys(links)]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length).split('/')[0] as string)
      if (!names.length) throw missing(path)
      return [...new Set(names)]
    },
    readlink: (path) => {
      if (path in links) return links[path] as string
      throw missing(path)
    },
  }
}

function tailOf(files: Record<string, string>): FileTail {
  return {
    read(path, offset, max) {
      const bytes = Buffer.from(files[path] ?? '')
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
    range: () => Buffer.alloc(0),
  }
}

type Phase = 'busy' | 'idle'

/** What the tool leaves on disk while it works and when its turn is done. */
const FIXTURES: Record<string, (phase: Phase) => StateContext> = {
  'claude-code': (phase) => ({
    fs: procfs({
      '/h/.claude/sessions/20.json': JSON.stringify({
        pid: 20,
        sessionId: SESSION,
        status: phase,
        statusUpdatedAt: 5,
      }),
    }),
    home: '/h',
    pids: [20],
  }),
  codex: (phase) => {
    const files = {
      [CODEX_ROLLOUT]: [
        JSON.stringify({ type: 'session_meta', payload: { id: SESSION, thread_source: 'user' } }),
        JSON.stringify({ timestamp: AT, type: 'event_msg', payload: { type: 'task_started' } }),
        ...(phase === 'idle'
          ? [
              JSON.stringify({
                timestamp: AT,
                type: 'event_msg',
                payload: { type: 'task_complete' },
              }),
            ]
          : []),
        '',
      ].join('\n'),
    }
    return {
      fs: procfs(files, { '/proc/30/fd/53': CODEX_ROLLOUT }),
      home: '/h',
      pids: [30],
      tail: tailOf(files),
    }
  },
  pi: (phase) => {
    const message = (role: string, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ type: 'message', timestamp: AT, message: { role, content: [], ...extra } })
    const files = {
      '/proc/40/environ': `TETHER_AGENT_SESSION_ID=${SESSION}\0`,
      [PI_FILE]: [
        JSON.stringify({ type: 'session', version: 3, id: SESSION }),
        message('user'),
        ...(phase === 'idle' ? [message('assistant', { stopReason: 'stop' })] : []),
        '',
      ].join('\n'),
    }
    return { fs: procfs(files), home: '/h', pids: [40], tail: tailOf(files) }
  },
  'aico-agent': (phase) => ({
    fs: procfs({
      '/proc/60/comm': 'aico-agent\n',
      '/proc/60/environ': `TETHER_AGENT_SESSION_ID=${SESSION}\0`,
    }),
    home: '/h',
    pids: [60],
    runs: (id: string) =>
      id === SESSION
        ? { startedAt: Date.parse(AT), endedAt: phase === 'busy' ? null : Date.parse(AT) }
        : null,
  }),
  agy: (phase) => {
    const snapshot: AgySnapshot = {
      maxIdx: phase === 'busy' ? 8 : 7,
      open: [],
      lastMetadata: null,
      executorLastStep: 7,
    }
    return {
      fs: procfs(
        { '/proc/50/comm': 'agy\n' },
        { '/proc/50/fd/9': `/h/.gemini/antigravity-cli/presence/${SESSION}.lock` },
      ),
      home: '/h',
      pids: [50],
      seams: { agy: () => snapshot },
    }
  },
}

/** A snapshot from the poll of whichever probe the adapter found. */
function signal(adapter: TuiAdapter, ctx: StateContext): AgentSignal | null {
  return adapter.state.find(ctx, null)?.poll() ?? null
}

describe('adapter registry', () => {
  it('lists each tool once, by id, harness and executor', () => {
    const unique = (values: (string | null)[]) => {
      const named = values.filter((v) => v !== null)
      expect(new Set(named).size).toBe(named.length)
    }
    unique(ADAPTERS.map((a) => a.id))
    unique(ADAPTERS.map((a) => a.harness))
    unique(ADAPTERS.map((a) => a.executor))
    unique(ADAPTERS.map((a) => a.seed.processName))
  })

  it('has a fixture for every adapter', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(ADAPTERS.map((a) => a.id).sort())
  })
})

describe.each(ADAPTERS.map((adapter) => [adapter.id, adapter] as const))(
  'adapter %s',
  (id, adapter) => {
    it('is found by its id and its harness, and seeded in the tools table', () => {
      expect(adapterOf(id)).toBe(adapter)
      expect(adapterByHarness(adapter.harness)).toBe(adapter)
      expect(DEFAULT_TOOLS).toContain(adapter.seed)
      expect(adapter.seed.slug).toBe(id)
      const tool = { ...adapter.seed, id, command: '', createdAt: 0, updatedAt: 0 }
      expect(toolSpec(tool).slug).toBe(id)
    })

    it('declares every capability as an explicit boolean', () => {
      const { delivery, ...flags } = adapter.capabilities
      for (const value of [...Object.values(flags), ...Object.values(delivery)])
        expect(typeof value).toBe('boolean')
    })

    it('agrees with itself: each capability matches the parts that back it', () => {
      const c = adapter.capabilities
      expect(c.root).toBe(adapter.spec.resume !== undefined)
      expect(c.instructions).toBe(adapter.spec.instructions !== undefined)
      expect(c.modelWatch).toBe(adapter.models !== null)
      expect(c.rewind).toBe(Boolean(adapter.models?.promptAt))
      expect(c.stateHooks).toBe(adapter.hooks.stateReports.length > 0)
      expect(c.entry).toBe(adapter.entryApiVersion !== null)
      expect(c.entry).toBe(Boolean(adapter.state.findInEntry))
      expect(c.delivery.nextTurn).toBe(adapter.hooks.rideAlong.includes('UserPromptSubmit'))
      expect(c.delivery.toolResult).toBe(adapter.hooks.rideAlong.includes('PostToolUse'))
      expect(c.delivery.idlePaste).toBe(true)
      expect(c.root || !c.blankSlate).toBe(true)
      // A tool whose hooks carry ride-along lines has a provider name for them.
      if (adapter.hooks.rideAlong.length) expect(adapter.hooks.provider).not.toBeNull()
    })

    it('reads its own state: idle, then busy, then idle again, as plain data', () => {
      const fixture = FIXTURES[id]
      if (!fixture) throw new Error(`no fixture for ${id}`)
      const busy = signal(adapter, fixture('busy'))
      const idle = signal(adapter, fixture('idle'))
      expect(busy?.state).toBe('working')
      expect(idle?.state).toBe('idle')
      for (const s of [busy, idle]) expect(JSON.parse(JSON.stringify(s))).toEqual(s)
      // The same fixture read twice (a poller's next look) gives the same state.
      expect(signal(adapter, fixture('busy'))?.state).toBe('working')
    })

    it('finds nothing in a pane with no such agent', () => {
      expect(adapter.state.find({ fs: procfs({}), home: '/h', pids: [1] }, null)).toBeNull()
    })

    it('declares login and context facts', () => {
      expect(adapter.context.kind).toBeTruthy()
      expect(typeof adapter.context.check).toBe('function')
      expect(['string', 'object']).toContain(typeof adapter.login.signIn)
      for (const install of adapter.hooks.installs) {
        expect(install.what).toBeTruthy()
        expect(install.path).toBeTruthy()
      }
      for (const event of [...adapter.hooks.rideAlong, ...adapter.hooks.stateReports])
        expect(event).toMatch(/^[A-Z][A-Za-z]+$/)
    })

    it('reads model events as plain data, or has no model watch', () => {
      if (!adapter.models) return
      expect(adapter.models.events('not json')).toEqual([])
      const events = adapter.models.events(
        JSON.stringify({
          type: 'assistant',
          timestamp: AT,
          message: { model: 'm', role: 'assistant' },
        }),
      )
      expect(JSON.parse(JSON.stringify(events))).toEqual(events)
    })
  },
)

// Which hook events carry ride-along lines is decided by aico-hook (native/hook/lease takesRide). Its Go test
// and this one read the same fixture, so the adapters' declared facts and the hook cannot drift apart.
describe('ride-along events', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('../../../../../../contracts/ride-along-fixtures.json', import.meta.url),
      'utf8',
    ),
  ) as { events: string[]; takes: Record<string, string[]> }
  it('agrees with every adapter hooks.rideAlong', () => {
    for (const adapter of ADAPTERS)
      expect(fixture.takes[adapter.hooks.provider ?? 'none']).toEqual(
        fixture.events.filter((event) => adapter.hooks.rideAlong.includes(event)),
      )
  })
})

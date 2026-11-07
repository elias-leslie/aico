import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  AgentStatePoller,
  type AgentStateRecord,
  AgentStateTracker,
  hookState,
} from './agent-state'
import {
  AgyConversation,
  type AgySnapshot,
  agy,
  agySignal,
  findAgyConversation,
  nodeAgyRead,
} from './lifecycle/tui/adapters/agy'
import { claudeSignal, findClaude } from './lifecycle/tui/adapters/claude-code'
import {
  CodexRollout,
  CodexTurn,
  findCodexRollout,
  observeCodex,
} from './lifecycle/tui/adapters/codex'
import { findPiSession, PiSession } from './lifecycle/tui/adapters/pi'
import { parseHookReport } from './lifecycle-api'
import type { FileTail, ProcFs } from './proc-fs'

const CLAUDE = '5a7741ea-e6b1-4062-853b-0d9d2e03d549'
const OTHER = '6b7741ea-e6b1-4062-853b-0d9d2e03d549'
const CODEX = '01a130a3-ac80-74c1-8728-7cc6a6085327'
const ROLLOUT = `/home/u/.codex/sessions/2026/10/12/rollout-2026-10-12T11-03-15-${CODEX}.jsonl`

function claudeFile(status: string, at: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ pid: 20, sessionId: CLAUDE, status, statusUpdatedAt: at, ...extra })
}

function tracker(start = 1000) {
  let clock = start
  const changes: [string, AgentStateRecord][] = []
  const t = new AgentStateTracker(
    (id, record) => changes.push([id, record]),
    () => clock,
  )
  return {
    t,
    changes,
    tick: (ms: number) => {
      clock += ms
    },
  }
}

describe('Claude status file', () => {
  it('maps busy, waiting, idle and shell', () => {
    expect(claudeSignal(claudeFile('busy', 5))).toMatchObject({ state: 'working', at: 5 })
    expect(
      claudeSignal(claudeFile('waiting', 6, { waitingFor: 'permission prompt' })),
    ).toMatchObject({ state: 'blocked', detail: 'permission prompt', agentSessionId: CLAUDE })
    expect(claudeSignal(claudeFile('idle', 7))).toMatchObject({ state: 'idle' })
    expect(claudeSignal(claudeFile('shell', 7))).toMatchObject({ state: 'idle' })
    expect(claudeSignal(claudeFile('later-unknown', 7))).toBeNull()
    expect(claudeSignal('{not json')).toBeNull()
  })

  it('reads a session file holding JSON null as no signal', () => {
    expect(claudeSignal('null')).toBeNull()
  })
})

describe('hook reports', () => {
  it('treats permission and elicitation prompts as blocked, not idle_prompt', () => {
    const report = (notificationType: string) =>
      hookState({ event: 'Notification', notificationType, agent: 'claude' })
    expect(report('permission_prompt')).toEqual({ state: 'blocked', detail: 'permission prompt' })
    expect(report('elicitation_dialog')).toEqual({ state: 'blocked', detail: 'input needed' })
    expect(report('idle_prompt')).toBeNull()
    expect(report('auth_success')).toBeNull()
    expect(hookState({ event: 'UserPromptSubmit', agent: 'claude' })).toEqual({
      state: 'working',
      detail: null,
    })
  })

  it('validates the request body', () => {
    expect(
      parseHookReport({
        event: 'Notification',
        notificationType: 'permission_prompt',
        agent: 'claude',
        agentSessionId: CLAUDE,
      }),
    ).toEqual({
      event: 'Notification',
      notificationType: 'permission_prompt',
      agent: 'claude',
      agentSessionId: CLAUDE,
    })
    expect(() => parseHookReport({ event: 'Bogus', agent: 'claude' })).toThrow()
    expect(() => parseHookReport({ event: 'Stop', agent: 'pi' })).toThrow()
    expect(() => parseHookReport({ event: 'Stop', agent: 'claude', prompt: 'x' })).toThrow()
  })
})

describe('AgentStateTracker', () => {
  it('keeps the agent’s own time, and a later idle is a change (a turn between polls)', () => {
    const { t, changes, tick } = tracker()
    t.observe('a', claudeSignal(claudeFile('idle', 900)))
    expect(t.get('a').stateAgentAt).toBe(900)
    tick(10)
    t.observe('a', claudeSignal(claudeFile('idle', 900)))
    expect(changes).toHaveLength(1)
    t.observe('a', claudeSignal(claudeFile('idle', 1_500)))
    expect(changes).toHaveLength(2)
    expect(t.get('a')).toMatchObject({ state: 'idle', stateAgentAt: 1_500, stateAt: 1000 })
    t.observe('a', claudeSignal(claudeFile('idle', 1_200)))
    expect(t.get('a').stateAgentAt).toBe(1_500)
    t.observe('a', null)
    expect(t.get('a')).toMatchObject({ state: 'unknown', stateAgentAt: 1_500 })
  })

  it('a first sighting without the agent’s time does not invent a finished turn', () => {
    const { t, tick } = tracker()
    const polled = (state: 'idle' | 'working') => ({
      state,
      source: 'agent-polled',
      detail: null,
      at: null,
      agentSessionId: null,
    })
    t.observe('a', polled('idle'))
    expect(t.get('a').stateAgentAt).toBe(0)
    tick(10)
    t.observe('a', polled('working'))
    tick(10)
    t.observe('a', polled('idle'))
    expect(t.get('a').stateAgentAt).toBe(1020)
  })

  it('starts unknown and publishes each change once', () => {
    const { t, changes, tick } = tracker()
    expect(t.get('a').state).toBe('unknown')
    t.observe('a', claudeSignal(claudeFile('busy', 900)))
    tick(10)
    t.observe('a', claudeSignal(claudeFile('busy', 900)))
    expect(changes.map(([, r]) => r.state)).toEqual(['working'])
    expect(t.get('a')).toEqual({
      state: 'working',
      stateSource: 'claude-status',
      stateAt: 1000,
      stateAgentAt: 900,
      stateDetail: null,
      statePrevious: 'unknown',
    })
    t.observe('a', null)
    expect(t.get('a').state).toBe('unknown')
  })

  it('holds a hook block until the agent status moves on after it', () => {
    const { t, tick } = tracker()
    t.observe('a', claudeSignal(claudeFile('busy', 900)))
    tick(100) // 1100
    expect(
      t.report('a', {
        event: 'Notification',
        notificationType: 'permission_prompt',
        agent: 'claude',
        agentSessionId: CLAUDE,
      }),
    ).toBe(true)
    expect(t.get('a')).toMatchObject({ state: 'blocked', stateSource: 'claude-hook' })
    // The status file still says busy from before the prompt: stay blocked.
    t.observe('a', claudeSignal(claudeFile('busy', 900)))
    expect(t.get('a').state).toBe('blocked')
    // Claude's own waiting status agrees.
    t.observe('a', claudeSignal(claudeFile('waiting', 1090, { waitingFor: 'permission prompt' })))
    expect(t.get('a').state).toBe('blocked')
    // Answered: busy again, after the hook fired.
    t.observe('a', claudeSignal(claudeFile('busy', 1200)))
    expect(t.get('a')).toMatchObject({ state: 'working', stateSource: 'claude-status' })
  })

  it('clears a hook block on UserPromptSubmit', () => {
    const { t } = tracker()
    t.report('a', { event: 'Notification', notificationType: 'permission_prompt', agent: 'claude' })
    t.report('a', { event: 'UserPromptSubmit', agent: 'claude' })
    expect(t.get('a')).toMatchObject({ state: 'working', stateSource: 'claude-hook' })
    t.observe('a', claudeSignal(claudeFile('busy', 1)))
    expect(t.get('a').state).toBe('working')
  })

  it("ignores a nested agent's hook reports", () => {
    const { t } = tracker()
    t.observe('a', claudeSignal(claudeFile('busy', 900)))
    expect(
      t.report('a', {
        event: 'Notification',
        notificationType: 'permission_prompt',
        agent: 'claude',
        agentSessionId: OTHER,
      }),
    ).toBe(false)
    expect(t.get('a').state).toBe('working')
  })

  it('ignores Notification types that do not block', () => {
    const { t } = tracker()
    expect(
      t.report('a', { event: 'Notification', notificationType: 'idle_prompt', agent: 'claude' }),
    ).toBe(false)
    expect(t.get('a').state).toBe('unknown')
  })
})

const line = (type: string, payload: Record<string, unknown>, at = '2026-10-12T10:00:00.000Z') =>
  JSON.stringify({ timestamp: at, type, payload })

describe('Codex rollout', () => {
  it('follows turns and unanswered user-input requests', () => {
    const turn = new CodexTurn(CODEX)
    expect(turn.signal().state).toBe('idle')
    turn.apply(line('event_msg', { type: 'task_started' }))
    expect(turn.signal()).toMatchObject({ state: 'working', agentSessionId: CODEX })
    turn.apply(
      line('response_item', { type: 'function_call', name: 'request_user_input', call_id: 'c1' }),
    )
    expect(turn.signal()).toMatchObject({ state: 'blocked', detail: 'input needed' })
    turn.apply(line('response_item', { type: 'function_call', name: 'exec', call_id: 'c2' }))
    expect(turn.signal().state).toBe('blocked')
    turn.apply(line('response_item', { type: 'function_call_output', call_id: 'c1' }))
    expect(turn.signal().state).toBe('working')
    turn.apply(line('event_msg', { type: 'exec_approval_request' }))
    expect(turn.signal()).toMatchObject({ state: 'blocked', detail: 'permission prompt' })
    turn.apply(line('event_msg', { type: 'token_count' }))
    expect(turn.signal().state).toBe('blocked')
    turn.apply(line('response_item', { type: 'function_call_output', call_id: 'c2' }))
    expect(turn.signal().state).toBe('working')
    turn.apply(line('event_msg', { type: 'task_complete' }, '2026-10-12T10:05:00.000Z'))
    expect(turn.signal()).toMatchObject({
      state: 'idle',
      at: Date.parse('2026-10-12T10:05:00.000Z'),
    })
    turn.apply('not json')
    expect(turn.signal().state).toBe('idle')
  })

  it('an asynchronous question stays blocked past its accepted output and the turn end, until the owner answers', () => {
    const turn = new CodexTurn(CODEX)
    turn.apply(line('event_msg', { type: 'task_started' }))
    turn.apply(
      line('response_item', {
        type: 'function_call',
        name: 'request_user_input_async',
        call_id: 'a1',
      }),
    )
    expect(turn.signal()).toMatchObject({ state: 'blocked', detail: 'input needed' })
    turn.apply(
      line('response_item', {
        type: 'function_call_output',
        call_id: 'a1',
        output: '{"accepted":true}',
      }),
    )
    expect(turn.signal().state).toBe('blocked')
    // The agent's own and tool-injected lines are not the owner's answer.
    turn.apply(line('response_item', { type: 'message', role: 'assistant' }))
    turn.apply(line('response_item', { type: 'message', role: 'developer' }))
    expect(turn.signal().state).toBe('blocked')
    turn.apply(line('event_msg', { type: 'task_complete' }))
    expect(turn.signal()).toMatchObject({ state: 'blocked', detail: 'input needed' })
    // The owner's reply starts the next turn.
    turn.apply(line('event_msg', { type: 'task_started' }))
    expect(turn.signal().state).toBe('working')
  })

  it('an asynchronous question asked mid-turn is answered by a user message', () => {
    const turn = new CodexTurn(CODEX)
    turn.apply(line('event_msg', { type: 'task_started' }))
    turn.apply(
      line('response_item', {
        type: 'custom_tool_call',
        name: 'request_user_input_async',
        call_id: 'a1',
      }),
    )
    expect(turn.signal().state).toBe('blocked')
    turn.apply(line('response_item', { type: 'message', role: 'user' }))
    expect(turn.signal().state).toBe('working')
  })

  it.each([
    ['on-request', 'user', 'blocked'],
    ['never', 'user', 'working'],
    ['on-request', 'auto_review', 'working'],
  ])(
    'an escalated call under policy %s, reviewer %s, is %s until its output',
    (policy, reviewer, pending) => {
      const turn = new CodexTurn(CODEX)
      turn.apply(
        JSON.stringify({
          type: 'turn_context',
          payload: { approval_policy: policy, approvals_reviewer: reviewer },
        }),
      )
      turn.apply(line('event_msg', { type: 'task_started' }))
      turn.apply(
        line('response_item', {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'c1',
          input:
            'await tools.exec_command({cmd:"touch x",sandbox_permissions:"require_escalated"})',
        }),
      )
      expect(turn.signal().state).toBe(pending)
      turn.apply(line('response_item', { type: 'custom_tool_call_output', call_id: 'c1' }))
      expect(turn.signal().state).toBe('working')
    },
  )

  /** A rollout file in memory, read like nodeFileTail reads one. */
  function memoryTail(initial = '') {
    const file = { content: initial, ranges: 0 }
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
        file.ranges += 1
        return Buffer.from(file.content).subarray(start, end)
      },
    }
    return { file, tail }
  }

  /** About `bytes` of a busy turn's tool calls, including an output that quotes a turn end. */
  function busyLines(bytes: number): string {
    const call = line('response_item', {
      type: 'function_call',
      name: 'exec',
      call_id: 'c',
      arguments: 'x'.repeat(4000),
    })
    const quote = line('response_item', {
      type: 'function_call_output',
      call_id: 'c',
      output: '{"type":"task_complete"}',
    })
    let text = ''
    while (text.length < bytes) text += `${call}\n${quote}\n`
    return text
  }

  it('finds a long turn that started before the tail it first reads', () => {
    const started = line('event_msg', { type: 'task_started' }, '2026-10-12T09:00:00.000Z')
    const { file, tail } = memoryTail(
      `${line('session_meta', { id: CODEX })}\n${line('event_msg', { type: 'task_complete' })}\n${started}\n${busyLines(3 * 1024 * 1024)}`,
    )
    const rollout = new CodexRollout(ROLLOUT, CODEX, tail)
    expect(rollout.poll()).toMatchObject({
      state: 'working',
      at: Date.parse('2026-10-12T09:00:00.000Z'),
    })
    expect(file.ranges).toBeGreaterThan(1)
    file.content += `${line('event_msg', { type: 'task_complete' })}\n`
    expect(rollout.poll()?.state).toBe('idle')
  })

  it('reads a long file with no turn yet as idle, and a boundary in the tail needs no scan', () => {
    const quiet = memoryTail(`${line('session_meta', { id: CODEX })}\n${busyLines(1024 * 1024)}`)
    expect(new CodexRollout(ROLLOUT, CODEX, quiet.tail).poll()?.state).toBe('idle')
    const recent = memoryTail(
      `${busyLines(1024 * 1024)}${line('event_msg', { type: 'task_started' })}\n`,
    )
    expect(new CodexRollout(ROLLOUT, CODEX, recent.tail).poll()?.state).toBe('working')
    expect(recent.file.ranges).toBe(0)
  })

  it('reads the tail first, then only appended complete lines', () => {
    const { file, tail } = memoryTail(
      `${line('session_meta', { id: CODEX })}\n${line('event_msg', { type: 'task_started' })}\n`,
    )
    const rollout = new CodexRollout(ROLLOUT, CODEX, tail)
    expect(rollout.poll()?.state).toBe('working')
    // A partial line is held back until it is complete.
    const done = line('event_msg', { type: 'task_complete' })
    file.content += done.slice(0, 10)
    expect(rollout.poll()?.state).toBe('working')
    file.content += `${done.slice(10)}\n`
    expect(rollout.poll()?.state).toBe('idle')
  })
})

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

describe('agent process discovery', () => {
  const SUBAGENT = '01a130a6-a89b-7533-b413-46951175576a'
  const SOURCED = '01a130a6-a89b-7533-b413-46951175576b'
  const rollout = (id: string) =>
    `/home/u/.codex/sessions/2026/10/12/rollout-2026-10-12T11-03-15-${id}.jsonl`
  const meta = (id: string, extra: Record<string, unknown> = {}) =>
    `${JSON.stringify({ type: 'session_meta', payload: { id, ...extra } })}\n{"type":"event"}\n`

  it('finds the Claude process by a session file naming its own pid', () => {
    const files = {
      '/h/.claude/sessions/20.json': JSON.stringify({ pid: 99, sessionId: CLAUDE }),
      '/h/.claude/sessions/21.json': JSON.stringify({ pid: 21, sessionId: 'not-a-uuid' }),
    }
    // A stale file left by a reused pid names another process; the session ID
    // does not matter here.
    expect(findClaude(procfs(files), '/h', [20, 21])).toEqual({
      pid: 21,
      file: '/h/.claude/sessions/21.json',
    })
    expect(findClaude(procfs(files), '/h', [20])).toBeNull()
  })

  it("takes the Codex user thread's rollout, never a subagent's", () => {
    const fs = procfs(
      {
        [rollout(SUBAGENT)]: meta(SUBAGENT, { parent_thread_id: CODEX, thread_source: 'subagent' }),
        [rollout(SOURCED)]: meta(SOURCED, { thread_source: 'subagent' }),
        [rollout(CODEX)]: meta(CODEX, { thread_source: 'user' }),
      },
      {
        '/proc/30/fd/3': '/dev/null',
        '/proc/30/fd/92': rollout(SUBAGENT),
        // A non-user thread_source alone marks a subagent.
        '/proc/30/fd/93': rollout(SOURCED),
        '/proc/30/fd/53': rollout(CODEX),
      },
    )
    expect(findCodexRollout(fs, [30])).toEqual({ pid: 30, path: rollout(CODEX), threadId: CODEX })
  })

  it('takes the user rollout with a UUID thread ID, the one reboot continuity resumes', () => {
    const fs = procfs(
      { [rollout('odd')]: meta('odd'), [rollout(CODEX)]: meta(CODEX) },
      { '/proc/30/fd/4': rollout('odd'), '/proc/30/fd/5': rollout(CODEX) },
    )
    expect(findCodexRollout(fs, [30])).toEqual({ pid: 30, path: rollout(CODEX), threadId: CODEX })
    expect(observeCodex(fs, [30])).toEqual({ pid: 30, resumeId: CODEX, idle: null, blocked: false })
  })

  it('falls back to a user rollout without a UUID thread ID when it is the only one', () => {
    const fs = procfs({ [rollout('odd')]: meta('odd') }, { '/proc/30/fd/4': rollout('odd') })
    expect(findCodexRollout(fs, [30])).toEqual({ pid: 30, path: rollout('odd'), threadId: null })
    expect(findCodexRollout(procfs({}), [30])).toBeNull()
  })
})

describe('AgentStatePoller', () => {
  it("finds the pane's Claude process, follows it, and loses it when it exits", async () => {
    const files: Record<string, string> = {
      '/proc/10/task/10/children': '20',
      '/proc/20/task/20/children': '',
      '/proc/20/stat': '20 (claude)',
      '/h/.claude/sessions/20.json': claudeFile('busy', 1),
    }
    const { t } = tracker()
    let panePidCalls = 0
    const poller = new AgentStatePoller(
      t,
      {
        sessions: () => [
          {
            id: 'a',
            generation: 'g1',
            panePid: async () => {
              panePidCalls += 1
              return 10
            },
          },
        ],
      },
      procfs(files),
      '/h',
      { now: () => 0 },
    )
    await poller.poll()
    expect(t.get('a').state).toBe('working')
    files['/h/.claude/sessions/20.json'] = claudeFile('waiting', 2, { waitingFor: 'input needed' })
    await poller.poll()
    expect(t.get('a')).toMatchObject({ state: 'blocked', stateDetail: 'input needed' })
    delete files['/proc/20/stat']
    delete files['/proc/20/task/20/children']
    delete files['/h/.claude/sessions/20.json']
    files['/proc/10/task/10/children'] = ''
    await poller.poll()
    expect(t.get('a').state).toBe('unknown')
    // The pane PID is asked once per generation.
    expect(panePidCalls).toBe(1)
  })

  it('reads a Claude without its session file past the grace as blocked on a startup dialog', async () => {
    // stat after the name: state ppid … starttime (field 22) = 1000 ticks = 10 s after boot.
    const stat = (pid: number, ppid: number) =>
      `${pid} (claude) S ${ppid} ${Array.from({ length: 17 }, () => '0').join(' ')} 1000 0`
    const files: Record<string, string> = {
      '/proc/10/task/10/children': '20 30',
      '/proc/20/task/20/children': '',
      '/proc/30/task/30/children': '',
      '/proc/20/stat': stat(20, 10),
      '/proc/20/cmdline': 'claude\0--dangerously-skip-permissions\0',
      // A `claude -p` beside it is never the session's agent.
      '/proc/30/stat': stat(30, 10),
      '/proc/30/cmdline': 'claude\0-p\0hi\0',
      '/proc/uptime': '15.00 1.00',
    }
    const { t } = tracker()
    const poller = new AgentStatePoller(
      t,
      { sessions: () => [{ id: 'a', generation: 'g1', panePid: async () => 10 }] },
      procfs(files),
      '/h',
      { now: () => 0 },
    )
    await poller.poll()
    expect(t.get('a').state).toBe('unknown') // 5 s old: still starting
    files['/proc/uptime'] = '21.00 1.00'
    await poller.poll()
    expect(t.get('a')).toMatchObject({
      state: 'blocked',
      stateSource: 'claude-process',
      stateDetail: 'startup dialog',
    })
    // The owner answers the dialog: Claude writes its file and the real state follows.
    files['/h/.claude/sessions/20.json'] = claudeFile('idle', 2)
    await poller.poll()
    expect(t.get('a')).toMatchObject({ state: 'idle', stateSource: 'claude-status' })
  })

  it('does not take a pane child `claude -p` for a startup dialog', async () => {
    const files: Record<string, string> = {
      '/proc/10/task/10/children': '30',
      '/proc/30/task/30/children': '',
      '/proc/30/stat': `30 (claude) S 10 ${Array.from({ length: 17 }, () => '0').join(' ')} 0 0`,
      '/proc/30/cmdline': 'claude\0--print\0hi\0',
      '/proc/uptime': '500.00 1.00',
    }
    const { t } = tracker()
    const poller = new AgentStatePoller(
      t,
      { sessions: () => [{ id: 'a', generation: 'g1', panePid: async () => 10 }] },
      procfs(files),
      '/h',
      { now: () => 0 },
    )
    await poller.poll()
    expect(t.get('a').state).toBe('unknown')
  })

  it('forgets sessions that stop running', async () => {
    const { t } = tracker()
    let sessions = [{ id: 'a', generation: 'g', panePid: async () => null as number | null }]
    const poller = new AgentStatePoller(t, { sessions: () => sessions }, procfs({}), '/h')
    t.report('a', { event: 'UserPromptSubmit', agent: 'claude' })
    sessions = []
    await poller.poll()
    expect(t.ids()).toEqual([])
  })
})

describe('Pi session file', () => {
  const PI = '4edd5953-950d-4415-93ad-3273312e73a4'
  const DIR = '/h/.pi/agent/sessions/--srv-p--'
  const PATH = `${DIR}/2026-10-26T22-19-58-537Z_${PI}.jsonl`
  const header = JSON.stringify({ type: 'session', version: 3, id: PI })
  const msg = (
    role: string,
    extra: Record<string, unknown> = {},
    at = '2026-10-26T22:22:18.044Z',
  ) => JSON.stringify({ type: 'message', timestamp: at, message: { role, content: [], ...extra } })
  const reply = (stopReason: string, content: unknown[] = [{ type: 'text' }]) =>
    msg('assistant', { stopReason, content })

  function fileTail(initial: string) {
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
      range: () => Buffer.alloc(0),
    }
    return { file, tail }
  }
  const state = (text: string) => new PiSession(PATH, PI, fileTail(text).tail).poll()?.state

  it('is idle after a finished reply and working while the turn runs', () => {
    expect(state(`${header}\n${msg('user')}\n${reply('stop')}\n`)).toBe('idle')
    expect(state(`${header}\n${msg('user')}\n`)).toBe('working')
    expect(state(`${header}\n${reply('toolUse', [{ type: 'toolCall' }])}\n`)).toBe('working')
    expect(state(`${header}\n${reply('toolUse')}\n${msg('toolResult')}\n`)).toBe('working')
    expect(state(`${header}\n${reply('pending')}\n`)).toBe('working')
    expect(state(`${header}\n${msg('user')}\n${reply('aborted')}\n`)).toBe('idle')
    expect(state(`${header}\n${msg('user')}\n${reply('error')}\n`)).toBe('idle')
    expect(state(`${header}\n${reply('length')}\n`)).toBe('idle')
    expect(state(`${header}\n${reply('length', [{ type: 'toolCall' }])}\n`)).toBe('working')
    // Entries that are not messages, and other roles, leave the state alone.
    expect(state(`${header}\n${reply('stop')}\n${msg('bashExecution')}\n{"type":"label"}\n`)).toBe(
      'idle',
    )
    expect(state(`${header}\n`)).toBeUndefined()
  })

  it('reads appended complete lines and holds back a partial one', () => {
    const { file, tail } = fileTail(`${header}\n${msg('user')}\n`)
    const session = new PiSession(PATH, PI, tail)
    expect(session.poll()).toMatchObject({
      state: 'working',
      source: 'pi-session',
      agentSessionId: PI,
      at: Date.parse('2026-10-26T22:22:18.044Z'),
    })
    const done = reply('stop')
    file.content += done.slice(0, 20)
    expect(session.poll()?.state).toBe('working')
    file.content += `${done.slice(20)}\n`
    expect(session.poll()?.state).toBe('idle')
  })

  it('reads a missing file as no signal', () => {
    const missing: FileTail = {
      read: () => {
        throw new Error('ENOENT')
      },
      range: () => Buffer.alloc(0),
    }
    expect(new PiSession(PATH, PI, missing).poll()).toBeNull()
  })

  it("finds the file named by the pane's chosen session ID, never another", () => {
    const environ = `PATH=/bin\0TETHER_AGENT_SESSION_ID=${PI}\0`
    const files = {
      '/proc/40/environ': environ,
      [`${DIR}/2026-10-26T23-00-00-000Z_${OTHER}.jsonl`]: header,
      '/h/.pi/agent/sessions/--other--/x.jsonl': header,
    }
    expect(findPiSession(procfs(files), '/h', [40])).toEqual({ pid: 40, sessionId: PI, path: null })
    expect(findPiSession(procfs({ ...files, [PATH]: header }), '/h', [40])).toEqual({
      pid: 40,
      sessionId: PI,
      path: PATH,
    })
    expect(findPiSession(procfs({ [PATH]: header }), '/h', [40])).toBeNull()
  })

  it('feeds the tracker from the poller', async () => {
    const files: Record<string, string> = {
      '/proc/10/task/10/children': '40',
      '/proc/40/task/40/children': '',
      '/proc/40/stat': '40 (pi)',
      '/proc/40/environ': `TETHER_AGENT_SESSION_ID=${PI}\0`,
    }
    const { file, tail } = fileTail(`${header}\n${msg('toolResult')}\n`)
    const { t } = tracker()
    let now = 0
    const poller = new AgentStatePoller(
      t,
      { sessions: () => [{ id: 'p', generation: 'g', panePid: async () => 10 }] },
      procfs(files),
      '/h',
      { now: () => now, tail },
    )
    await poller.poll()
    // Pi writes no file until the first prompt.
    expect(t.get('p').state).toBe('unknown')
    files[PATH] = header
    now = 20_000
    await poller.poll()
    expect(t.get('p')).toMatchObject({ state: 'working', stateSource: 'pi-session' })
    file.content += `${reply('stop')}\n`
    await poller.poll()
    expect(t.get('p').state).toBe('idle')
  })
})

// --- Antigravity (agy) ---------------------------------------------------------

const AGY = 'b336953c-6476-4378-b345-b0b3e6f89938'
const AGY_DB = `/h/.gemini/antigravity-cli/conversations/${AGY}.db`

function pbVarint(n: number): number[] {
  const out: number[] = []
  let value = n
  while (value >= 0x80) {
    out.push((value % 0x80) | 0x80)
    value = Math.floor(value / 0x80)
  }
  out.push(value)
  return out
}
function pbBytes(field: number, bytes: number[]): number[] {
  return [...pbVarint(field * 8 + 2), ...pbVarint(bytes.length), ...bytes]
}
function pbInt(field: number, value: number): number[] {
  return [...pbVarint(field * 8), ...pbVarint(value)]
}
/** CortexStepMetadata with created_at (1) and completed_at (8), in seconds. */
function stepMeta(created: number, completed?: number): Uint8Array {
  const stamp = (seconds: number) => [...pbInt(1, seconds), ...pbInt(2, 500_000_000)]
  return Uint8Array.from([
    ...pbBytes(1, stamp(created)),
    ...pbInt(3, 2),
    ...(completed ? pbBytes(8, stamp(completed)) : []),
  ])
}
/** ExecutorMetadata: termination_reason 1, num_generator_invocations 2, last_step_idx 3. */
function executor(lastStep: number, reason = 4): Uint8Array {
  return Uint8Array.from([
    ...pbInt(1, reason),
    ...pbInt(2, 1),
    ...(lastStep ? pbInt(3, lastStep) : []),
  ])
}

describe('agy conversation', () => {
  const snap = (over: Partial<AgySnapshot>): AgySnapshot => ({
    maxIdx: 7,
    open: [],
    lastMetadata: stepMeta(1_800_000_010, 1_800_000_020),
    executorLastStep: 7,
    ...over,
  })

  it('reads steps and executor runs as working, blocked and idle', () => {
    // No steps yet: agy fresh at its input, with no time of its own.
    expect(agySignal(snap({ maxIdx: null, executorLastStep: null }), AGY)).toEqual({
      state: 'idle',
      source: 'agy-conversation',
      detail: null,
      at: null,
      agentSessionId: AGY,
    })
    // The user's prompt is in, no executor run has ended on it: thinking.
    expect(agySignal(snap({ maxIdx: 8, executorLastStep: 7 }), AGY)).toMatchObject({
      state: 'working',
      at: 1_800_000_010_500,
    })
    expect(agySignal(snap({ executorLastStep: null }), AGY)?.state).toBe('working')
    // A step left RUNNING (a background command, an abandoned row) once the
    // run covering the newest step ended does not pin working: the turn is over.
    expect(agySignal(snap({ executorLastStep: 7 }), AGY)?.state).toBe('idle')
    // An old WAITING row a later run passed is not waiting any more.
    expect(
      agySignal(snap({ open: [{ idx: 3, status: 9, metadata: null }], executorLastStep: 7 }), AGY)
        ?.state,
    ).toBe('idle')
    // ask_question waits on the user.
    expect(
      agySignal(
        snap({ open: [{ idx: 7, status: 9, metadata: stepMeta(1_800_000_030) }], maxIdx: 7 }),
        AGY,
      ),
    ).toMatchObject({ state: 'blocked', detail: 'input needed', at: 1_800_000_030_500 })
    // The run covering the newest step ended: idle, at its completion.
    expect(agySignal(snap({}), AGY)).toEqual({
      state: 'idle',
      source: 'agy-conversation',
      detail: null,
      at: 1_800_000_020_500,
      agentSessionId: AGY,
    })
  })

  it('reads a real database in agy 1.4.9 schema, read-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-db-'))
    try {
      const path = join(dir, `${AGY}.db`)
      const db = new DatabaseSync(path)
      db.exec('PRAGMA journal_mode=WAL')
      db.exec(
        'CREATE TABLE `steps` (`idx` integer,`step_type` integer NOT NULL DEFAULT 0,`status` integer NOT NULL DEFAULT 0,`has_subtrajectory` numeric NOT NULL DEFAULT false,`metadata` blob,`error_details` blob,`permissions` blob,`task_details` blob,`render_info` blob,`step_payload` blob,`step_format` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`));' +
          'CREATE INDEX `idx_steps_status` ON `steps`(`status`);' +
          'CREATE TABLE `executor_metadata` (`idx` integer,`data` blob,PRIMARY KEY (`idx`));',
      )
      const step = db.prepare(
        'INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)',
      )
      const run = db.prepare('INSERT INTO executor_metadata (idx, data) VALUES (?, ?)')
      const read = () => agySignal(nodeAgyRead(path), AGY)
      expect(read()).toMatchObject({ state: 'idle', at: null })
      step.run(0, 14, 3, stepMeta(1_800_000_000, 1_800_000_001))
      expect(read()?.state).toBe('working')
      step.run(1, 15, 8, stepMeta(1_800_000_002))
      expect(read()?.state).toBe('working')
      db.exec('UPDATE steps SET status = 3 WHERE idx = 1')
      // A turn cancelled at its first step still ends a run (last_step_idx 0 encodes nothing).
      run.run(0, executor(0, 2))
      expect(read()?.state).toBe('working')
      run.run(1, executor(1))
      expect(read()).toMatchObject({ state: 'idle', at: 1_800_000_002_500 })
      db.exec(
        `UPDATE steps SET metadata = X'${Buffer.from(stepMeta(1_800_000_002, 1_800_000_009)).toString('hex')}' WHERE idx = 1`,
      )
      expect(read()).toMatchObject({ state: 'idle', at: 1_800_000_009_500 })
      step.run(2, 132, 9, stepMeta(1_800_000_010))
      expect(read()).toMatchObject({ state: 'blocked', detail: 'input needed' })
      // The ask's run ends at it: still blocked while it is the newest step.
      run.run(2, executor(2))
      expect(read()).toMatchObject({ state: 'blocked' })
      // A background command still RUNNING after a later run ended: idle.
      db.exec('UPDATE steps SET status = 3 WHERE idx = 2')
      step.run(3, 21, 2, stepMeta(1_800_000_011))
      run.run(3, executor(3))
      expect(read()).toMatchObject({ state: 'idle' })
      db.close()
      // agy holds the lock before the database (or its tables) exist: fresh, not unknown.
      expect(new AgyConversation(join(dir, 'none.db'), AGY).poll()).toMatchObject({
        state: 'idle',
        at: null,
        agentSessionId: AGY,
      })
      const empty = join(dir, 'empty.db')
      new DatabaseSync(empty).close()
      expect(new AgyConversation(empty, AGY).poll()).toMatchObject({ state: 'idle', at: null })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("finds the agy process's conversation by its presence lock, and agy before its first prompt", () => {
    const files = { '/proc/40/comm': 'agy\n', '/proc/41/comm': 'bash\n' }
    const lock = { '/proc/40/fd/9': `/h/.gemini/antigravity-cli/presence/${AGY}.lock` }
    const log = { '/proc/40/fd/1': '/h/.gemini/antigravity-cli/log/cli.log' }
    expect(findAgyConversation(procfs(files, log), '/h', [41, 40])).toEqual({
      pid: 40,
      conversationId: null,
      path: null,
    })
    expect(findAgyConversation(procfs(files, { ...log, ...lock }), '/h', [41, 40])).toEqual({
      pid: 40,
      conversationId: AGY,
      path: AGY_DB,
    })
    // The db itself held open counts too; another home's file does not.
    expect(
      findAgyConversation(procfs(files, { '/proc/40/fd/3': AGY_DB }), '/h', [40])?.conversationId,
    ).toBe(AGY)
    expect(
      findAgyConversation(procfs(files, { '/proc/40/fd/3': `/x${AGY_DB}` }), '/h', [40])
        ?.conversationId,
    ).toBeNull()
    // The presence lock wins over another conversation's db, the newest lock over older ones.
    const OTHER = 'aaaaaaaa-6476-4378-b345-b0b3e6f89938'
    expect(
      findAgyConversation(
        procfs(files, {
          '/proc/40/fd/3': `/h/.gemini/antigravity-cli/conversations/${OTHER}.db`,
          '/proc/40/fd/12': `/h/.gemini/antigravity-cli/presence/${OTHER}.lock`,
          '/proc/40/fd/9': lock['/proc/40/fd/9'],
          '/proc/40/fd/20': `/h/.gemini/antigravity-cli/presence/${AGY}.lock`,
        }),
        '/h',
        [40],
      )?.conversationId,
    ).toBe(AGY)
    // A root resumes the conversation the process holds, once there is one.
    expect(agy.state.observe?.(procfs(files, lock), '/h', [41, 40])).toEqual({
      pid: 40,
      resumeId: AGY,
      idle: null,
      blocked: false,
    })
    expect(agy.state.observe?.(procfs(files, log), '/h', [41, 40])).toBeNull()
    // A process not named agy is not agy.
    expect(
      findAgyConversation(
        procfs({ '/proc/41/comm': 'bash\n' }, { '/proc/41/fd/9': lock['/proc/40/fd/9'] }),
        '/h',
        [41],
      ),
    ).toBeNull()
  })

  it('feeds the tracker from the poller: idle with no time before the first prompt, then the conversation', async () => {
    const files: Record<string, string> = {
      '/proc/10/task/10/children': '40',
      '/proc/40/task/40/children': '',
      '/proc/40/stat': '40 (agy)',
      '/proc/40/comm': 'agy\n',
    }
    const links: Record<string, string> = {
      '/proc/40/fd/1': '/h/.gemini/antigravity-cli/log/x.log',
    }
    let snapshot: AgySnapshot = {
      maxIdx: 0,
      open: [],
      lastMetadata: stepMeta(1_800_000_000, 1_800_000_000),
      executorLastStep: null,
    }
    const reads: string[] = []
    const { t } = tracker()
    let now = 0
    const poller = new AgentStatePoller(
      t,
      { sessions: () => [{ id: 'g', generation: 'g', panePid: async () => 10 }] },
      procfs(files, links),
      '/h',
      {
        now: () => now,
        seams: {
          agy: (path: string) => {
            reads.push(path)
            return snapshot
          },
        },
      },
    )
    await poller.poll()
    expect(t.get('g')).toMatchObject({
      state: 'idle',
      stateSource: 'agy-conversation',
      stateAgentAt: 0,
    })
    // The first prompt opens a conversation: seen on the next poll, not 15 s later.
    links['/proc/40/fd/9'] = `/h/.gemini/antigravity-cli/presence/${AGY}.lock`
    now = 1_000
    await poller.poll()
    expect(t.get('g').state).toBe('working')
    expect(reads).toEqual([AGY_DB])
    snapshot = { ...snapshot, executorLastStep: 0 }
    await poller.poll()
    expect(t.get('g')).toMatchObject({ state: 'idle', stateAgentAt: 1_800_000_000_500 })
  })
})

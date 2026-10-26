import { describe, expect, it } from 'vitest'
import {
  AgentStatePoller,
  type AgentStateRecord,
  AgentStateTracker,
  CodexRollout,
  CodexTurn,
  claudeSignal,
  type FileTail,
  findClaude,
  findCodexRollout,
  findPiSession,
  hookState,
  PiSession,
} from './agent-state'
import { observeCodex, type ProcFs } from './continuity'
import { parseHookReport } from './lifecycle-api'

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

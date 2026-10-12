import { describe, expect, it } from 'vitest'
import {
  type ContinuitySnapshot,
  mergeSnapshot,
  observeAgent,
  observeClaude,
  observeCodex,
  type ProcFs,
  processTree,
  restoreCandidates,
} from './continuity'

const CLAUDE = '5a7741ea-e6b1-4062-853b-0d9d2e03d549'
const CODEX = '01a130a3-ac80-74c1-8728-7cc6a6085327'
const SUBAGENT = '01a130a6-a89b-7533-b413-46951175576a'
const ROLLOUT = (id: string) =>
  `/home/u/.codex/sessions/2026/10/12/rollout-2026-10-12T11-03-15-${id}.jsonl`

function procfs(files: Record<string, string>, links: Record<string, string> = {}): ProcFs {
  const dirs = new Map<string, Set<string>>()
  for (const path of [...Object.keys(files), ...Object.keys(links)]) {
    // Register every ancestor directory with its child entry.
    let child = path
    for (let slash = child.lastIndexOf('/'); slash > 0; slash = child.lastIndexOf('/')) {
      const dir = child.slice(0, slash)
      if (!dirs.has(dir)) dirs.set(dir, new Set())
      dirs.get(dir)?.add(child.slice(slash + 1))
      child = dir
    }
  }
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
      const entries = dirs.get(path)
      if (!entries) throw missing(path)
      return [...entries]
    },
    readlink: (path) => {
      if (path in links) return links[path] as string
      throw missing(path)
    },
  }
}

describe('agent observation', () => {
  it('walks the pane process tree through every task', () => {
    const fs = procfs({
      '/proc/10/task/10/children': '11 12',
      '/proc/11/task/11/children': '',
      '/proc/11/task/13/children': '14',
      '/proc/12/task/12/children': '',
      '/proc/14/task/14/children': '',
    })
    expect(processTree(fs, 10).sort()).toEqual([10, 11, 12, 14])
  })

  it("reads Claude Code's session file for its pid and busy state", () => {
    const state = (status: string) =>
      JSON.stringify({ pid: 20, sessionId: CLAUDE, cwd: '/p', status })
    expect(
      observeClaude(procfs({ '/h/.claude/sessions/20.json': state('busy') }), '/h', [19, 20]),
    ).toEqual({
      resumeId: CLAUDE,
      idle: false,
    })
    expect(
      observeClaude(procfs({ '/h/.claude/sessions/20.json': state('idle') }), '/h', [20]),
    ).toEqual({
      resumeId: CLAUDE,
      idle: true,
    })
    // A stale file left by a reused pid names another process.
    const stale = JSON.stringify({ pid: 99, sessionId: CLAUDE })
    expect(observeClaude(procfs({ '/h/.claude/sessions/20.json': stale }), '/h', [20])).toBeNull()
  })

  it("takes the Codex user thread, never a subagent's", () => {
    const meta = (id: string, extra: Record<string, unknown>) =>
      `${JSON.stringify({ type: 'session_meta', payload: { id, ...extra } })}\n{"type":"event"}\n`
    const fs = procfs(
      {
        [ROLLOUT(SUBAGENT)]: meta(SUBAGENT, { parent_thread_id: CODEX, thread_source: 'subagent' }),
        [ROLLOUT(CODEX)]: meta(CODEX, { thread_source: 'user' }),
      },
      {
        '/proc/30/fd/3': '/dev/null',
        '/proc/30/fd/92': ROLLOUT(SUBAGENT),
        '/proc/30/fd/53': ROLLOUT(CODEX),
      },
    )
    expect(observeCodex(fs, [30])).toEqual({ resumeId: CODEX, idle: null })
  })

  it('finds the agent anywhere under the pane', () => {
    const fs = procfs({
      '/proc/40/task/40/children': '41',
      '/proc/41/task/41/children': '',
      '/h/.claude/sessions/41.json': JSON.stringify({ pid: 41, sessionId: CLAUDE, status: 'idle' }),
    })
    expect(observeAgent(fs, '/h', 40)?.resumeId).toBe(CLAUDE)
    expect(observeAgent(procfs({}), '/h', 40)).toBeNull()
  })
})

describe('snapshot', () => {
  const previous: ContinuitySnapshot = {
    v: 1,
    bootId: 'old',
    updatedAt: 1,
    sessions: [
      { id: 'aaaaaaaa', tool: 'claude-code', resumeId: CLAUDE, observedAt: 1 },
      { id: 'bbbbbbbb', tool: 'codex', resumeId: CODEX, observedAt: 1 },
      { id: 'cccccccc', tool: 'shell', resumeId: null, observedAt: 1 },
    ],
  }

  it('keeps a known resume ID while the agent is between conversations', () => {
    const next = mergeSnapshot(
      previous,
      [{ id: 'aaaaaaaa', tool: 'claude-code', resumeId: null }],
      () => false,
      'boot',
      5,
    )
    expect(next.sessions).toEqual([
      { id: 'aaaaaaaa', tool: 'claude-code', resumeId: CLAUDE, observedAt: 1 },
    ])
  })

  it('drops a resume ID when the tool changed', () => {
    const next = mergeSnapshot(
      previous,
      [{ id: 'aaaaaaaa', tool: 'codex', resumeId: null }],
      () => false,
      'boot',
      5,
    )
    expect(next.sessions[0]?.resumeId).toBeNull()
  })

  it('retains sessions still waiting to be restored', () => {
    const next = mergeSnapshot(previous, [], (id) => id === 'bbbbbbbb', 'boot', 5)
    expect(next.sessions.map((s) => s.id)).toEqual(['bbbbbbbb'])
  })

  it('restores only sessions whose workload is gone', () => {
    const status: Record<string, string> = { aaaaaaaa: 'pending', bbbbbbbb: 'running' }
    expect(restoreCandidates(previous, (id) => status[id] ?? null).map((s) => s.id)).toEqual([
      'aaaaaaaa',
    ])
    expect(restoreCandidates(null, () => 'pending')).toEqual([])
  })
})

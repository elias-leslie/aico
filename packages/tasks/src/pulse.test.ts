import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionDescriptor } from '@aico/tether-client'
import { describe, expect, it } from 'vitest'
import { openTasksDb } from './db'
import { Registry } from './projects'
import {
  BriefLedger,
  brief,
  collect,
  type Finding,
  type PulseSources,
  render,
  roleOf,
} from './pulse'
import { runPulse } from './pulse-cli'

const NOW = Date.parse('2026-11-04T12:00:00Z')
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()

const finding = (over: Partial<Finding>): Finding => ({
  id: 'trend-pool',
  machine: 'gem',
  what: 'Thin pool',
  meaning: 'pve/data 65% full',
  project: null,
  shown: 'failed',
  since: NOW - 35 * 3_600_000,
  ...over,
})

function setup(findings: Finding[] | null = [finding({})]) {
  const db = openTasksDb(':memory:')
  const registry = new Registry(db)
  registry.register({ id: 'aico', root: '/srv/aico', name: 'Aico' })
  registry.register({ id: 'other', root: '/srv/other', name: 'Other' })
  const docs: Record<string, Record<string, unknown>> = {
    aico: {
      leases: [
        {
          agent_id: 'cc:111111',
          kind: 'file',
          globs: ['/srv/aico/a/**'],
          last_heartbeat: iso(5),
        },
        { agent_id: 'cc:222222', kind: 'file', globs: ['/srv/aico/old'], last_heartbeat: iso(45) },
        {
          agent_id: 'cc:333333',
          kind: 'file',
          globs: ['/srv/aico/taken.ts'],
          last_heartbeat: iso(2),
          taken_over_by: 'cc:333333',
        },
        {
          agent_id: 'st:op1',
          kind: 'op',
          globs: ['/srv/aico/**'],
          pid: 41,
          pid_start: '9',
          last_heartbeat: iso(90),
        },
        {
          agent_id: 'st:op2',
          kind: 'op',
          globs: ['/srv/aico/**'],
          pid: 42,
          pid_start: '9',
          last_heartbeat: iso(1),
        },
      ],
    },
    _coord: {
      messages: [
        { id: 'abc123', from: 'cc:111111', to: 'cc:222222', state: 'open', created: iso(7) },
        { id: 'def456', from: 'cc:1', to: 'cc:2', state: 'closed', created: iso(70) },
      ],
    },
  }
  const sources: PulseSources = {
    now: () => NOW,
    sessions: async () =>
      [
        { id: 'a1', status: 'running', projectId: 'aico', state: 'working' },
        { id: 'a2', status: 'running', projectId: 'aico', state: 'idle' },
        { id: 'a3', status: 'pending', projectId: 'aico', state: 'idle' },
      ] as SessionDescriptor[],
    docNames: async () => Object.keys(docs),
    doc: async (name) => docs[name] ?? {},
    findings: () => findings,
    alive: (pid) => pid === 41,
  }
  return { db, registry, sources }
}

describe('aico pulse', () => {
  it('shows a vanished child from Tether alongside the live children its coordinator started', async () => {
    const { sources } = setup()
    const lines = render(
      await collect({
        ...sources,
        children: async () => [
          { id: 'child1', parent: 'root1', host: null, title: 'Builder', state: 'live' },
          { id: 'child2', parent: 'root1', host: null, title: 'Reviewer', state: 'vanished' },
        ],
      }),
    )
    expect(lines).toContain('Children of root1: 1 live, 1 vanished')
    expect(lines.join('\n')).toContain('Reviewer (child2) vanished; check its session')
  })

  it('shows sessions, fresh leases, open handshakes and Status problems', async () => {
    const { sources } = setup()
    const lines = render(await collect(sources))
    expect(lines).toContain('aico: 2 sessions (1 working, 1 idle)')
    expect(lines.some((l) => l.startsWith('  lease cc:111111 /srv/aico/a/** idle:5m'))).toBe(true)
    expect(lines.join('\n')).not.toContain('/srv/aico/old')
    // A taken-over lease shows its current holder; an op lease shows while its process runs, however old
    // its heartbeat, and not once the process is gone.
    expect(lines.some((l) => l.startsWith('  lease cc:333333 /srv/aico/taken.ts'))).toBe(true)
    expect(lines.some((l) => l.startsWith('  op st:op1 /srv/aico/**'))).toBe(true)
    expect(lines.join('\n')).not.toContain('st:op2')
    expect(lines).toContain('Handshakes: 1 open')
    expect(lines).toContain('  abc123 open cc:111111->cc:222222 7m')
    expect(lines).toContain('Status: 1 problem')
    expect(lines).toContain('  failed gem: Thin pool: pve/data 65% full')
  })

  it('says unknown, not zero, when a source does not answer', async () => {
    const { sources } = setup(null)
    const lines = render(
      await collect({ ...sources, sessions: async () => null, docNames: async () => null }),
    )
    expect(lines).toContain('Sessions: Tether did not answer; live sessions are unknown.')
    expect(lines).toContain('Leases: Tether did not answer; leases are unknown.')
    expect(lines).toContain('Handshakes: Tether did not answer; open requests are unknown.')
    expect(lines).toContain('Status: unreadable; host findings are unknown.')
  })

  it('--brief lists host findings once per role window and stays small', () => {
    const { registry } = setup()
    const dir = mkdtempSync(join(tmpdir(), 'pulse-'))
    const ledger = new BriefLedger(join(dir, 'brief.json'))
    const args = {
      findings: [
        finding({}),
        finding({ id: 'reboot', shown: 'warn', meaning: 'reboot wanted', since: NOW - 3_600_000 }),
      ],
      role: 'agent' as const,
      project: 'aico',
      registry,
      now: NOW,
      ledger,
    }
    const lines = brief(args)
    expect(lines[0]).toBe('System brief (new since this window; `aico pulse --brief` repeats it):')
    expect(lines[1]).toMatch(
      /^- CRIT host: gem: Thin pool: pve\/data 65% full \(open 1d11h since Nov 0[234], stuck\)$/,
    )
    expect(lines[2]).toBe('- WARN host: gem: Thin pool: reboot wanted (open 1h)')
    expect(lines.join('\n').length).toBeLessThan(400)
    expect(brief(args)).toEqual([])
    expect(brief({ ...args, now: NOW + 25 * 3_600_000 }).length).toBeGreaterThan(0)
  })

  it('role decides who is told: a lane only blocking project items, a subagent nothing', () => {
    const { registry } = setup()
    const findings = [
      finding({ id: 'p-warn', project: 'aico', shown: 'warn', meaning: 'slow' }),
      finding({ id: 'p-fail', project: 'aico', shown: 'failed', meaning: 'broken' }),
      finding({ id: 'o-fail', project: 'other', shown: 'failed', meaning: 'other broken' }),
    ]
    const text = (role: 'coordinator' | 'agent' | 'lane' | 'subagent') =>
      brief({ findings, role, project: 'aico', registry, now: NOW }).join('\n')
    expect(text('subagent')).toBe('')
    expect(text('lane')).toContain('broken')
    expect(text('lane')).not.toContain('slow')
    expect(text('agent')).toContain('slow')
    expect(text('agent')).not.toContain('other broken')
    expect(text('coordinator')).toContain('other broken')
    expect(text('coordinator').indexOf('Thin pool')).toBeGreaterThan(-1)
  })

  it('roleOf reads the payload and the window lineage', () => {
    expect(roleOf({ agent_id: 'x' }, null, true)).toBe('subagent')
    expect(roleOf({}, null, false)).toBe('agent')
    expect(roleOf({}, { coordinator: true } as SessionDescriptor, true)).toBe('coordinator')
    expect(roleOf({}, { coordinatorId: 'c1' } as SessionDescriptor, true)).toBe('lane')
  })

  it('runs as a command: --start reads the hook payload and records, --brief repeats', async () => {
    const { db, sources } = setup()
    const dir = mkdtempSync(join(tmpdir(), 'pulse-'))
    const env = { AICO_DATA_DIR: dir } as NodeJS.ProcessEnv
    const out: string[] = []
    const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(`ERR ${l}`) }
    const stdin = () =>
      JSON.stringify({ cwd: '/srv/aico/packages', hook_event_name: 'SessionStart' })
    const run = (...argv: string[]) =>
      runPulse(argv, { db, cwd: '/srv/aico', env, sources, stdin }, io)
    expect(await run('--start')).toBe(0)
    expect(out.join('\n')).toContain('- CRIT host: gem: Thin pool')
    out.length = 0
    await run('--start')
    expect(out).toEqual([])
    await run('--brief')
    expect(out.join('\n')).toContain('- CRIT host: gem: Thin pool')
    out.length = 0
    expect(await run('--nope')).toBe(2)
  })
})

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StatusRow } from '@aico/status'
import { describe, expect, it } from 'vitest'
import { whereOf } from './act'
import type { JobDef } from './jobs'
import { JobStore } from './leases'
import { loadJobs, newRoutine } from './routines'
import { parseAdd, type RoutineView, routinesCommand } from './routines-cli'
import { Runner } from './runner'

const scratch = () => mkdtempSync(join(tmpdir(), 'routines-'))
const jobsFile = (dir: string) => {
  const file = join(dir, 'jobs.json')
  writeFileSync(
    file,
    JSON.stringify({
      jobs: [
        {
          kind: 'export',
          what: 'Notes export',
          project: 'aico',
          home: 'ws',
          at: '03:30',
          run: { post: '/api/export/notes' },
          lease_s: 60,
        },
      ],
    }),
  )
  return file
}

const ADD = [
  '--project',
  'school-check',
  '--kind',
  'school-check',
  '--what',
  'Nightly school check',
]

function harness() {
  const dir = scratch()
  const store = new JobStore(':memory:')
  const file = jobsFile(dir)
  const lines: string[] = []
  const errors: string[] = []
  const rows: StatusRow[][] = []
  const removed: string[] = []
  const clock = { now: new Date(2026, 10, 7, 12, 0).getTime() }
  const run = (...args: string[]) =>
    routinesCommand(
      args,
      {
        jobs: loadJobs(file, store),
        store,
        machine: 'ws',
        env: {},
        dataDir: dir,
        postRows: async (r) => void rows.push(r),
        removeRow: async (id) => void removed.push(id),
        now: () => clock.now,
      },
      (l) => lines.push(l),
      (l) => errors.push(l),
    )
  return { dir, store, file, lines, errors, rows, removed, clock, run }
}

describe('registering a routine', () => {
  it('parses --command as the rest of the line, and wants one schedule', () => {
    expect(
      parseAdd([...ADD, '--at', '19:00', '--command', 'sh', '-c', 'echo --at 3']),
    ).toMatchObject({
      kind: 'school-check',
      at: '19:00',
      command: ['sh', '-c', 'echo --at 3'],
    })
    expect(() => parseAdd([...ADD, '--command', 'true'])).toThrow('exactly one schedule')
    expect(() => parseAdd([...ADD, '--at', '19:00', '--every', '5'])).toThrow(
      'exactly one schedule',
    )
    expect(() => parseAdd(['--kind', 'x', '--at', '19:00'])).toThrow('--project is required')
  })

  it('refuses what the scheduler would refuse, naming the field', () => {
    const base = { kind: 'k', project: 'p', what: 'W', at: '19:00', command: ['/bin/true'] }
    const make = (extra: object) => newRoutine({ ...base, ...extra }, 'ws', new Set(), 0)
    expect(make({}).scope).toBe('user')
    expect(() => make({ at: '7pm' })).toThrow('at')
    expect(() => make({ kind: 'Bad Kind' })).toThrow('kind')
    expect(() => make({ project: 'School Check' })).toThrow('--project')
    expect(() => make({ host: 'gem' })).toThrow('run this on gem')
    expect(() => make({ post: '/x' })).toThrow('command to run')
    expect(() => make({ command: ['./run.sh'] })).toThrow('relative')
    expect(() => make({ scope: 'root' })).toThrow('scope')
    expect(() => make({ cwd: '/definitely/not/here' })).toThrow('not a folder')
    expect(() => newRoutine(base, 'ws', new Set(['k']), 0)).toThrow("already a routine or job 'k'")
  })
})

describe('aico routines', () => {
  it('adds, lists with the built-in jobs, and removes', async () => {
    const h = harness()
    expect(await h.run('add', ...ADD, '--at', '19:00', '--command', 'true')).toBe(0)
    expect(h.lines.join('\n')).toContain('Registered school-check')
    // Same kind twice, or a built-in's kind, is refused.
    expect(await h.run('add', ...ADD, '--at', '19:00', '--command', 'true')).toBe(2)
    expect(
      await h.run(
        'add',
        ...'--project',
        'x',
        '--what',
        'Dup',
        '--kind',
        'export',
        '--at',
        '19:00',
        '--command',
        'true',
      ),
    ).toBe(2)
    h.lines.length = 0
    await h.run('list', '--json')
    const views = JSON.parse(h.lines[0] as string) as RoutineView[]
    expect(views.map((v) => [v.kind, v.source, v.project])).toEqual([
      ['export', 'built-in', 'aico'],
      ['school-check', 'registered', 'school-check'],
    ])
    expect(views[1]).toMatchObject({
      schedule: 'daily at 19:00',
      command: ['true'],
      started: false,
      paused: false,
    })
    expect(await h.run('remove', 'export')).toBe(2)
    expect(await h.run('remove', 'school-check')).toBe(0)
    expect(h.removed).toEqual(['jobs/school-check'])
    expect(h.store.routines()).toEqual([])
  })

  it('pauses (off, no next run, no scheduled runs) and resumes; run now works while paused', async () => {
    const h = harness()
    await h.run('add', ...ADD, '--every', '10', '--command', 'true')
    h.store.ensure('school-check', h.clock.now)
    expect(await h.run('pause', 'school-check')).toBe(0)
    expect(h.rows.at(-1)?.[0]).toMatchObject({ id: 'jobs/school-check', state: 'off' })
    expect(h.rows.at(-1)?.[0]).not.toHaveProperty('next_run')
    expect(
      h.store.claim('school-check', { holder: 'w:1', machine: 'ws' }, h.clock.now + 1e6, 1000),
    ).toBeNull()
    // Run now: due once even though paused; the finished run clears it.
    expect(await h.run('run', 'school-check')).toBe(0)
    const lease = h.store.claim(
      'school-check',
      { holder: 'w:1', machine: 'ws' },
      h.clock.now + 1,
      1000,
    )
    if (!lease) throw new Error('no lease')
    h.store.complete(lease, { state: 'ok', meaning: 'done' }, h.clock.now, h.clock.now + 600_000)
    expect(h.store.get('school-check')).toMatchObject({ paused: true, runNow: false })
    expect(
      h.store.claim('school-check', { holder: 'w:1', machine: 'ws' }, h.clock.now + 1e7, 1000),
    ).toBeNull()
    expect(await h.run('resume', 'school-check')).toBe(0)
    expect(h.rows.at(-1)?.[0]).toMatchObject({ state: 'ok' })
    expect(h.rows.at(-1)?.[0]).toHaveProperty('next_run')
    expect(
      h.store.claim('school-check', { holder: 'w:1', machine: 'ws' }, h.clock.now + 1, 1000),
    ).not.toBeNull()
  })

  it('says so for an unknown routine and for one the scheduler has not started', async () => {
    const h = harness()
    expect(await h.run('run', 'nope')).toBe(2)
    expect(h.errors.join('')).toContain("no routine 'nope'")
    expect(await h.run('run', 'export')).toBe(1)
    expect(h.errors.join('')).toContain('has not started export yet')
  })
})

describe('scheduling a registered routine', () => {
  it('picks it up at the next tick, runs it in its folder and scope, and writes its Status row', async () => {
    const h = harness()
    const cwd = join(h.dir, 'project')
    mkdirSync(cwd)
    await h.run(
      'add',
      ...ADD,
      '--at',
      '19:00',
      '--cwd',
      cwd,
      '--scope',
      'system',
      '--command',
      'true',
    )
    const ran: JobDef[] = []
    const posted: StatusRow[][] = []
    const runner = new Runner({
      store: h.store,
      jobs: () => loadJobs(h.file, h.store),
      machine: 'ws',
      holder: 'ws:1',
      act: async (job) => {
        ran.push(job)
        return { state: 'failed', meaning: 'Exited 1: school site unreachable' }
      },
      postRows: async (rows) => void posted.push(rows),
      now: () => h.clock.now,
      log: () => {},
    })
    runner.start()
    await h.run(
      'add',
      '--project',
      'other',
      '--kind',
      'late-add',
      '--what',
      'Added while serving',
      '--every',
      '5',
      '--command',
      'true',
    )
    h.clock.now = new Date(2026, 10, 7, 19, 0, 1).getTime()
    await runner.tick()
    await runner.idle()
    expect(ran.map((j) => j.kind).sort()).toEqual(['late-add', 'school-check'])
    const job = ran.find((j) => j.kind === 'school-check') as JobDef
    expect(whereOf(job)).toEqual({ scope: 'system', cwd })
    const row = posted
      .flat()
      .filter((r) => r.id === 'jobs/school-check')
      .at(-1)
    expect(row).toMatchObject({
      project: 'school-check',
      kind: 'job',
      state: 'failed',
      meaning: 'Exited 1: school site unreachable',
    })
    // A routine removed while the scheduler runs is no longer started.
    await h.run('remove', 'late-add')
    ran.length = 0
    h.clock.now += 3_600_000
    await runner.tick()
    await runner.idle()
    expect(ran).toEqual([])
  })
})

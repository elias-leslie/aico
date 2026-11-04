import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type Deps, runProjects, runTasks } from './cli'
import { openTasksDb } from './db'
import { Registry } from './projects'

function setup(env: NodeJS.ProcessEnv = {}) {
  const db = openTasksDb(':memory:')
  new Registry(db).register({ id: 'aico', root: '/srv/aico', name: 'Aico' })
  const out: string[] = []
  const err: string[] = []
  const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }
  const deps: Deps = { db, cwd: '/srv/aico/packages', env }
  const tasks = (...argv: string[]) => runTasks(argv, deps, io)
  const take = () => out.splice(0).join('\n')
  return {
    db,
    deps,
    io,
    tasks,
    take,
    err,
    projects: (...argv: string[]) => runProjects(argv, deps, io),
  }
}

const SESSION_ENV = {
  AICO_SESSION_ID: 'aico-widget-77',
  AICO_AGENT_SLUG: 'claude-code',
  CLAUDE_CODE_SESSION_ID: 'uuid-77',
}

describe('aico tasks', () => {
  it('create, claim, log, done in a session; show lists the linked session', async () => {
    const { tasks, take, deps } = setup(SESSION_ENV)
    deps.describeSession = async (id) =>
      id === 'claude-code:uuid-77' ? 'claude-code, a model, started 2026-11-04 10:00' : null
    expect(await tasks('create', 'Scratch job', '-d', 'a test', '-l', 'x,y', '-p', '3')).toBe(0)
    const created = take()
    const id = created.split('|')[0] as string
    expect(created).toMatch(
      /^task-[0-9a-f]{16}\|aico\|pending\|P3\|task\|SIMPLE\|0\/0\|manual\|decisions:0\|Scratch job$/,
    )
    expect(await tasks('claim', id)).toBe(0)
    expect(take()).toMatch(/^PASS Task task-[0-9a-f]+ claimed\./)
    expect(await tasks('log', id, 'halfway')).toBe(0)
    expect(JSON.parse(take())).toMatchObject({ status: 'appended', task_id: id, entry: 'halfway' })
    expect(await tasks('done', id, '-m', 'finished')).toBe(0)
    expect(take()).toBe(`PASS Task ${id} completed.`)
    expect(await tasks('show', id)).toBe(0)
    const shown = take()
    expect(shown).toContain('Sessions (1):')
    expect(shown).toContain(
      'claude-code:uuid-77 (Tether aico-widget-77)  claude-code, a model, started 2026-11-04 10:00',
    )
    expect(shown).toContain('completed: finished')
  })

  it('list prints the st shape; context prints KEY lines; a second claimer gets an ERROR line', async () => {
    const { tasks, take, err, deps } = setup({ AICO_SESSION_ID: 'one' })
    await tasks('create', 'First', '-t', 'bug', '-p', '1')
    const id = take().split('|')[0] as string
    expect(await tasks('list')).toBe(0)
    expect(take()).toMatch(
      new RegExp(`^TASKS\\[1\\]\\nP1 ${id} aico         bug        pending   \\[TRIAGE\\] First$`),
    )
    await tasks('claim', id)
    take()
    await tasks('context', id)
    expect(take()).toMatch(/^TASK:task-[0-9a-f]+\|running\|P1\|bug\|SIMPLE\nTITLE:First\n/)
    deps.env = { AICO_SESSION_ID: 'two' }
    expect(await tasks('claim', id)).toBe(1)
    expect(err.join('\n')).toMatch(/^ERROR task task-[0-9a-f]+ is claimed by one since /)
  })

  it('subtasks from a plan: claim with --task, done with --task', async () => {
    const { tasks, take, err } = setup({ AICO_SESSION_ID: 'one' })
    const dir = mkdtempSync(join(tmpdir(), 'plan-'))
    const file = join(dir, 'plan.json')
    writeFileSync(
      file,
      JSON.stringify({
        title: 'Planned',
        complexity: 'SIMPLE',
        done_when: ['works'],
        subtasks: [{ description: 'a' }, { description: 'b' }],
        verify: { x: 1 },
      }),
    )
    expect(await tasks('create', '--plan', file, '--dry-run')).toBe(0)
    expect(take()).toBe('DRY-RUN:Planned|2 subtasks')
    await tasks('create', '--plan', file)
    const id = take().split('|')[0]?.replace('IMPORT:', '') as string
    expect(await tasks('claim', '1.1')).toBe(2)
    expect(err.join('\n')).toMatch(/needs --task PARENT/)
    expect(await tasks('claim', '1.1', '-t', id)).toBe(0)
    expect(take()).toMatch(/^PASS Subtask 1.1 claimed\./)
    expect(await tasks('done', '1.1', '-t', id, '--paths', 'a.ts')).toBe(0)
    expect(err.join('\n')).toMatch(/WARN not checked or recorded yet: --paths/)
    await tasks('context', id)
    expect(take()).toMatch(/DONE_WHEN\[1\]:works\nSUBTASKS\[2\]\n {2}1\.1 {3}PASS a/)
  })

  it('abandon previews with a token and needs it to proceed', async () => {
    const { tasks, take } = setup()
    await tasks('create', 'Drop me')
    const id = take().split('|')[0] as string
    await tasks('abandon', id)
    const preview = take()
    const token = /--confirm (\S+)/.exec(preview)?.[1] as string
    await tasks('list', '-s', 'pending')
    expect(take()).toContain('TASKS[1]')
    await tasks('abandon', id, '--confirm', token, '-r', 'moot')
    expect(take()).toBe(`PASS Task ${id} abandoned.`)
  })

  it('refuses an unknown project and a missing title with plain errors', async () => {
    const { tasks, err } = setup()
    expect(await tasks('create', 'x', '-P', 'nope')).toBe(1)
    expect(await tasks('create')).toBe(2)
    expect(await tasks('nonsense')).toBe(2)
    expect(err.join('\n')).toContain('ERROR no project nope')
  })
})

describe('aico projects', () => {
  it('lists with the current one marked, shows, registers and retires', async () => {
    const { projects, take } = setup()
    await projects('list')
    expect(JSON.parse(take())).toEqual([
      { id: 'aico', name: 'Aico', root_path: '/srv/aico', current: true },
    ])
    expect(await projects('register', 'other', '--root', '/srv/other')).toBe(0)
    expect(await projects('retire', 'other', '--reason', 'done')).toBe(0)
    take()
    await projects('list')
    expect(JSON.parse(take())).toHaveLength(1)
    await projects('list', '--all')
    expect(JSON.parse(take())).toHaveLength(2)
    await projects('show', 'other')
    expect(JSON.parse(take())).toMatchObject({
      id: 'other',
      lifecycle: 'retired',
      events: [{ action: 'registered' }, { action: 'retired' }],
    })
    expect(await projects('retire', 'other', '--reason', 'x')).toBe(1)
  })
})

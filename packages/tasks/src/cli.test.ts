import { describe, expect, it } from 'vitest'
import { type Deps, runProjects } from './cli'
import { openTasksDb } from './db'
import { Registry } from './projects'

function setup(env: NodeJS.ProcessEnv = {}) {
  const db = openTasksDb(':memory:')
  new Registry(db).register({ id: 'aico', root: '/srv/aico', name: 'Aico' })
  const out: string[] = []
  const err: string[] = []
  const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }
  const deps: Deps = { db, cwd: '/srv/aico/packages', env }
  const take = () => out.splice(0).join('\n')
  return {
    db,
    deps,
    io,
    take,
    err,
    projects: (...argv: string[]) => runProjects(argv, deps, io),
  }
}

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

  it('a missing project says how to list the registered ones', async () => {
    const { projects, err } = setup()
    expect(await projects('show', 'nope')).toBe(1)
    expect(err.at(-1)).toBe('ERROR no project nope (aico projects list shows the registered ones)')
  })

  it('renames a project and keeps its id', async () => {
    const { projects, take, err } = setup()
    expect(await projects('rename', 'aico', 'Aico', 'Hub')).toBe(0)
    take()
    await projects('list')
    expect(JSON.parse(take())).toMatchObject([{ id: 'aico', name: 'Aico Hub' }])
    expect(await projects('rename', 'nope', 'X')).toBe(1)
    expect(await projects('rename', 'aico')).toBe(2)
    expect(err.length).toBeGreaterThan(0)
  })
})

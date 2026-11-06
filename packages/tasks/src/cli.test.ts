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
})

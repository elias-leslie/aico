import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTasksDb, Registry } from '@aico/tasks'
import { afterEach, expect, it } from 'vitest'
import { projectId } from './status'

const scratch: string[] = []
afterEach(() => {
  for (const p of scratch.splice(0)) rmSync(p, { recursive: true, force: true })
})

it('names the registered project holding the folder before the inherited id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-status-'))
  scratch.push(dir)
  const file = join(dir, 'tasks.db'),
    root = join(dir, 'b'),
    other = join(dir, 'other')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(other)
  const db = openTasksDb(file)
  new Registry(db).register({ id: 'b', root })
  db.close()
  const env = { AICO_TASKS_DB: file, ST_PROJECT_ID: 'a' }
  expect(projectId(join(root, 'src'), env)).toBe('b')
  expect(projectId(other, env)).toBe('a')
  expect(projectId(other, { AICO_TASKS_DB: file })).toBe('other')
})

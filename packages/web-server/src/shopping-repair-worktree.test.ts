import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { deployedShoppingCommit, prepareShoppingWorktree } from './shopping-repair-worktree'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

it('pins the deployed commit and refuses a dirty or unrelated checkout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shopping-worktree-test-'))
  dirs.push(dir)
  const worktree = join(dir, 'tree')
  const sha = 'a'.repeat(40)
  let dirty = false
  let otherRepo = false
  const io = {
    run: async (args: string[]) => {
      if (args[0]?.endsWith('/scripts/vm-release.sh'))
        return { code: 0, output: '[guest] current: release aaaaaaaaaaaa' }
      if (args.includes('worktree')) mkdirSync(worktree)
      if (args.includes('--git-common-dir'))
        return { code: 0, output: otherRepo && args[2] === worktree ? '/other' : '/common' }
      if (args.includes('status')) return { code: 0, output: dirty ? '?? other-file' : '' }
      return { code: 0, output: sha }
    },
  }
  expect(await deployedShoppingCommit(io, dir)).toBe(sha)
  expect(await prepareShoppingWorktree(io, dir, worktree, sha)).toEqual({ base: sha })
  dirty = true
  expect(await prepareShoppingWorktree(io, dir, worktree, sha)).toBeUndefined()
  dirty = false
  otherRepo = true
  expect(await prepareShoppingWorktree(io, dir, worktree, sha)).toBeUndefined()
})

it('does not infer a deployed revision from failed or ambiguous status', async () => {
  const io = { run: async () => ({ code: 1, output: '[guest] current: release aaaaaaaaaaaa' }) }
  expect(await deployedShoppingCommit(io, '/project')).toBeUndefined()
})

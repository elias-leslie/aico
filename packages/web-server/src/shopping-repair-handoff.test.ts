import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { acceptShoppingHandoff, validateShoppingHandoff } from './shopping-repair-handoff'

it('compares the proposed commit, parent, paths, and affected requests to independent evidence', async () => {
  const base = 'a'.repeat(40)
  const commit = 'b'.repeat(40)
  const proposal = {
    version: 1,
    base,
    commit,
    files: ['backend/app/shopping.py', 'backend/tests/test_shopping.py'],
    requests: ['request-1'],
  }
  let paths = 'backend/app/shopping.py\0backend/tests/test_shopping.py\0'
  let parents = `${commit} ${base}`
  const io = {
    run: async (argv: string[]) => ({
      code: 0,
      output: argv.includes('rev-list')
        ? parents
        : argv.includes('ls-tree')
          ? `100644 blob ${'c'.repeat(40)}\tbackend/app/shopping.py\0`
          : paths,
    }),
  }
  expect(await validateShoppingHandoff(io, '/tree', base, ['request-1'], proposal)).toEqual({
    base,
    commit,
    files: proposal.files,
    requests: proposal.requests,
  })
  expect(await validateShoppingHandoff(io, '/tree', base, ['request-2'], proposal)).toBeUndefined()
  expect(
    await validateShoppingHandoff(io, '/tree', base, ['request-1'], {
      ...proposal,
      files: ['../.env'],
    }),
  ).toBeUndefined()
  const middle = 'd'.repeat(40)
  parents = `${commit} ${middle}\n${middle} ${base}`
  expect(await validateShoppingHandoff(io, '/tree', base, ['request-1'], proposal)).toBeDefined()
  parents = `${commit} ${base}`
  paths += 'unreported-file\0'
  expect(await validateShoppingHandoff(io, '/tree', base, ['request-1'], proposal)).toBeUndefined()
  paths = 'backend/app/shopping.py\0backend/tests/test_shopping.py\0'
  parents = `${commit} ${base} ${'c'.repeat(40)}`
  expect(await validateShoppingHandoff(io, '/tree', base, ['request-1'], proposal)).toBeUndefined()
})

it('requires both the full gate and its retained receipt for the pinned tree', async () => {
  const common = mkdtempSync(join(tmpdir(), 'shopping-handoff-'))
  try {
    const sha = 'b'.repeat(40)
    const tree = 'c'.repeat(40)
    let code = 0
    const io = {
      run: async (args: string[], cwd?: string) => {
        if (args[0] === 'st') {
          expect(cwd).toBe('/project')
          return { code, output: '' }
        }
        return { code: 0, output: args.includes('--git-common-dir') ? common : tree }
      },
    }
    expect(await acceptShoppingHandoff(io, '/project', sha)).toBeUndefined()
    const dir = join(common, 'aico-checks', 'receipts')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `accept-${tree}.json`),
      JSON.stringify({ passed: true, scope: null, tree, results: [] }),
    )
    code = 1
    expect(await acceptShoppingHandoff(io, '/project', sha)).toBeUndefined()
    code = 0
    expect(await acceptShoppingHandoff(io, '/project', sha)).toEqual({
      tree,
      receipt: join(dir, `accept-${tree}.json`),
    })
  } finally {
    rmSync(common, { recursive: true, force: true })
  }
})

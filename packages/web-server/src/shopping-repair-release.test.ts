import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { shoppingPolicy } from './shopping-repair-policy'
import {
  dispatchShoppingRelease,
  shoppingReleaseResult,
  startShoppingRelease,
} from './shopping-repair-release'

it('deploys only a clean candidate from the current deployed base, then requires a successful job and live SHA', async () => {
  const base = 'a'.repeat(40),
    commit = 'b'.repeat(40),
    unit = 'shopping-repair-1234-abcd'
  let deployed = base,
    dirty = false,
    capable = true,
    status = 'LoadState=loaded\nActiveState=activating\nResult=success\nExecMainStatus=0'
  const calls: string[][] = []
  const io = {
    run: async (argv: string[]) => {
      calls.push(argv)
      if (argv[0] === 'env') argv = argv.slice(3)
      if (argv[0]?.endsWith('vm-release.sh') && argv[1] === 'capabilities')
        return { code: 0, output: capable ? 'expected-base-v1' : '' }
      if (argv[0]?.endsWith('vm-release.sh'))
        return { code: 0, output: `[guest] current: release ${deployed.slice(0, 12)}` }
      if (argv.includes('status')) return { code: 0, output: dirty ? ' M dirty' : '' }
      if (argv.includes('HEAD^{commit}') && argv[2] === '/release') return { code: 0, output: base }
      if (argv.includes('rev-parse'))
        return {
          code: 0,
          output: argv.some((part) => part.startsWith('a'.repeat(12)))
            ? base
            : deployed === commit && argv.includes(`${commit.slice(0, 12)}^{commit}`)
              ? commit
              : commit,
        }
      if (argv[0] === 'systemctl') return { code: 0, output: status }
      return { code: 0, output: '' }
    },
  }
  expect(await startShoppingRelease(io, '/project', '/tree', '/release', base, commit, unit)).toBe(
    true,
  )
  capable = false
  expect(await startShoppingRelease(io, '/project', '/tree', '/release', base, commit, unit)).toBe(
    false,
  )
  capable = true
  dirty = true
  expect(await startShoppingRelease(io, '/project', '/tree', '/release', base, commit, unit)).toBe(
    false,
  )
  dirty = false
  expect(await dispatchShoppingRelease(io, '/tree', commit, base, unit, '/run/user/1000/ssh')).toBe(
    true,
  )
  expect(calls.find((call) => call.includes('systemd-run'))).toEqual(
    expect.arrayContaining([commit, '--expected-base', base]),
  )
  expect(await shoppingReleaseResult(io, '/project', unit, commit)).toBe('pending')
  status = 'LoadState=loaded\nActiveState=failed\nResult=exit-code\nExecMainStatus=1'
  expect(await shoppingReleaseResult(io, '/project', unit, commit)).toBe('failed')
  status =
    'LoadState=loaded\nActiveState=active\nSubState=exited\nMainPID=0\nResult=success\nExecMainStatus=0'
  expect(await shoppingReleaseResult(io, '/project', unit, commit)).toBe('pending')
  deployed = commit
  expect(await shoppingReleaseResult(io, '/project', unit, commit)).toBe('verified')
})

it('dispatches project-specific trusted executors and verifies the live revision', async () => {
  const { shoppingPolicy } = await import('./shopping-repair-policy')
  const base = 'a'.repeat(40)
  const commit = 'b'.repeat(40)
  const unit = 'shopping-repair-1234'
  const calls: string[][] = []
  const io = {
    run: async (argv: string[]) => {
      calls.push(argv)
      if (argv.includes('--git-common-dir')) return { code: 0, output: '/project/.git' }
      if (
        argv.includes('show') &&
        argv.includes('--property=LoadState,ActiveState,SubState,Result,ExecMainStatus,MainPID')
      )
        return {
          code: 0,
          output:
            'LoadState=loaded\nActiveState=active\nSubState=exited\nResult=success\nExecMainStatus=0\nMainPID=0',
        }
      if (argv[0] === 'ssh') return { code: 0, output: JSON.stringify({ sha: commit }) }
      if (argv.includes('status') && argv.includes('aico'))
        return { code: 0, output: `aico release=${commit.slice(0, 12)}` }
      if (argv.includes('rev-parse')) return { code: 0, output: commit }
      return { code: 0, output: '' }
    },
  }
  const dadbot = shoppingPolicy('dadbot')
  expect(await dispatchShoppingRelease(io, '/trusted', commit, base, unit, '/socket', dadbot)).toBe(
    true,
  )
  const dadbotCommand = calls.find((argv) => argv.includes('systemd-run'))
  expect(dadbotCommand).toContain('bash')
  expect(dadbotCommand?.join(' ')).toContain('show "$3:scripts/deploy.sh"')
  expect(dadbotCommand?.join(' ')).toContain('--expected-base "$3"')
  expect(await shoppingReleaseResult(io, '/trusted', unit, commit, dadbot)).toBe('verified')
  const aico = shoppingPolicy('aico')
  expect(
    await dispatchShoppingRelease(
      io,
      '/trusted',
      commit,
      base,
      unit,
      '/socket',
      aico,
      '/receipt.json',
    ),
  ).toBe(true)
  const managed = calls.filter((argv) => argv.includes('systemd-run')).at(-1)
  expect(managed?.join(' ')).toContain('--source-repo')
  expect(managed?.join(' ')).toContain('--sha')
  expect(managed?.join(' ')).toContain('update-ref')
  expect(managed).toContain(commit)
  expect(await shoppingReleaseResult(io, '/trusted', unit, commit, aico)).toBe('verified')
  expect(await shoppingReleaseResult(io, '/trusted', unit, base, aico)).toBe('pending')
})

it('rejects a dirty or legacy Dadbot release checkout before running its script', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shopping-trusted-'))
  const base = 'a'.repeat(40)
  const commit = 'b'.repeat(40)
  const calls: string[][] = []
  let dirty = true
  const io = {
    run: async (argv: string[]) => {
      calls.push(argv)
      if (argv.includes('status'))
        return { code: 0, output: dirty && argv[2] === dir ? ' M scripts/deploy.sh' : '' }
      if (argv.includes('HEAD^{commit}'))
        return { code: 0, output: argv[2] === dir ? base : commit }
      if (argv[0] === 'bash') return { code: 0, output: 'expected-base-v1' }
      if (argv[0] === 'ssh') return { code: 0, output: JSON.stringify({ sha: base }) }
      return { code: 0, output: base }
    },
  }
  try {
    mkdirSync(join(dir, 'scripts'))
    writeFileSync(join(dir, 'scripts/deploy.sh'), 'expected-base-v1')
    expect(
      await startShoppingRelease(
        io,
        '/project',
        '/candidate',
        dir,
        base,
        commit,
        'shopping-repair-1234',
        shoppingPolicy('dadbot'),
      ),
    ).toBe(false)
    expect(calls.some((argv) => argv[0] === 'bash' || argv[0] === 'ssh')).toBe(false)
    dirty = false
    writeFileSync(join(dir, 'scripts/deploy.sh'), 'legacy script')
    expect(
      await startShoppingRelease(
        io,
        '/project',
        '/candidate',
        dir,
        base,
        commit,
        'shopping-repair-1234',
        shoppingPolicy('dadbot'),
      ),
    ).toBe(false)
    expect(calls.some((argv) => argv[0] === 'bash' || argv[0] === 'ssh')).toBe(false)
    writeFileSync(join(dir, 'scripts/deploy.sh'), 'expected-base-v1')
    expect(
      await startShoppingRelease(
        io,
        '/project',
        '/candidate',
        dir,
        base,
        commit,
        'shopping-repair-1234',
        shoppingPolicy('dadbot'),
      ),
    ).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

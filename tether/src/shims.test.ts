import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The shims wrap real system tools. These tests never run one: the PATH holds
// only the shim directory and a fake "real binary" directory with a stub for
// every name in shims.list that prints its argv.

const source = join(__dirname, '..', 'scripts', 'shims')
const installer = join(__dirname, '..', 'scripts', 'install-shims.sh')
const rules = readFileSync(join(source, 'shims.list'), 'utf8')
  .split('\n')
  .filter((line) => line.trim() && !line.startsWith('#'))
  .map((line) => line.trim().split(/\s+/))

let root: string
let shimDir: string
let realDir: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'tether-shims-'))
  shimDir = join(root, 'shims')
  realDir = join(root, 'real')
  mkdirSync(shimDir)
  mkdirSync(realDir)
  copyFileSync(join(source, 'tether-shim'), join(shimDir, 'tether-shim'))
  copyFileSync(join(source, 'shims.list'), join(shimDir, 'shims.list'))
  chmodSync(join(shimDir, 'tether-shim'), 0o755)
  for (const [name] of rules) {
    symlinkSync('tether-shim', join(shimDir, name as string))
    const stub = join(realDir, name as string)
    writeFileSync(
      stub,
      `#!/bin/sh\nfor a in "$@"; do printf '[%s]' "$a"; done\nexit \${STUB_EXIT:-0}\n`,
    )
    chmodSync(stub, 0o755)
  }
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

function run(name: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(join(shimDir, name), args, {
    env: { PATH: `${shimDir}:${realDir}`, ...env },
    encoding: 'utf8',
  })
  return { out: result.stdout, err: result.stderr, code: result.status }
}

describe('agent shims', () => {
  it('lists the commands the owner asked for', () => {
    expect(rules.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        'systemctl',
        'systemd-run',
        'systemd-mount',
        'loginctl',
        'timedatectl',
        'hostnamectl',
        'localectl',
        'machinectl',
        'udisksctl',
        'pkexec',
      ]),
    )
  })

  for (const [name, , flag] of rules.filter(([, action]) => action === 'prepend')) {
    it(`${name} runs the real binary with ${flag} first and the rest unchanged`, () => {
      const { out, err, code } = run(name as string, ['--user', 'start', 'a b', '--', '-x'])
      expect(out).toBe(`[${flag}][--user][start][a b][--][-x]`)
      expect(err).toBe('')
      expect(code).toBe(0)
    })
  }

  it('puts the flag before a systemd-run command, not among its arguments', () => {
    expect(run('systemd-run', ['--unit=x', 'true', '--user']).out).toBe(
      '[--no-ask-password][--unit=x][true][--user]',
    )
  })

  it('works with no arguments', () => {
    expect(run('systemctl', []).out).toBe('[--no-ask-password]')
  })

  it('keeps the real exit code and adds no output', () => {
    const result = run('loginctl', ['x'], { STUB_EXIT: '7' })
    expect(result.code).toBe(7)
    expect(result.err).toBe('')
  })

  it('adds the udisksctl flag after listed subcommands only', () => {
    expect(run('udisksctl', ['mount', '-b', '/dev/x']).out).toBe(
      '[mount][--no-user-interaction][-b][/dev/x]',
    )
    expect(run('udisksctl', ['status']).out).toBe('[status]')
    expect(run('udisksctl', []).out).toBe('')
  })

  it('refuses pkexec with one line and never reaches the real binary', () => {
    const result = run('pkexec', ['id'])
    expect(result.code).toBe(126)
    expect(result.out).toBe('')
    expect(result.err).toBe('pkexec is blocked for agents; use nightshift request/bypass\n')
  })

  it('skips the shim directory even when it is reached through another path', () => {
    const alias = join(root, 'alias')
    symlinkSync(shimDir, alias)
    const result = spawnSync(join(shimDir, 'systemctl'), ['a'], {
      env: { PATH: `${alias}:${shimDir}:${realDir}` },
      encoding: 'utf8',
    })
    expect(result.stdout).toBe('[--no-ask-password][a]')
  })
})

describe('install-shims.sh', () => {
  it('links one shim per list line, is idempotent and drops stale links', () => {
    const fakeRepo = join(root, 'repo')
    const lib = join(root, 'lib')
    mkdirSync(join(fakeRepo, 'scripts'), { recursive: true })
    copyFileSync(installer, join(fakeRepo, 'scripts', 'install-shims.sh'))
    mkdirSync(join(fakeRepo, 'scripts', 'shims'))
    for (const file of ['tether-shim', 'shims.list']) {
      copyFileSync(join(source, file), join(fakeRepo, 'scripts', 'shims', file))
    }
    const install = () =>
      spawnSync(
        'bash',
        [
          '-c',
          `source "${fakeRepo}/scripts/install-shims.sh" && install_shims "${fakeRepo}" "${lib}"`,
        ],
        { encoding: 'utf8' },
      )
    expect(install().status).toBe(0)
    const names = readdirSync(join(lib, 'shims')).sort()
    expect(names).toEqual(
      [...rules.map(([name]) => name as string), 'shims.list', 'tether-shim'].sort(),
    )
    symlinkSync('tether-shim', join(lib, 'shims', 'oldcmd'))
    symlinkSync('/usr/bin/true', join(lib, 'shims', 'foreign'))
    const second = install()
    expect(second.status).toBe(0)
    expect(second.stdout).toContain('removed')
    const after = readdirSync(join(lib, 'shims'))
    expect(after).not.toContain('oldcmd')
    expect(after).toContain('foreign')
  })
})

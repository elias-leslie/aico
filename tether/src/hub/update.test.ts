import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HostEntry } from './hosts'
import { pushRelease, RELEASE_FILES, runningRelease, updateLine } from './update'

const SCRIPTS = join(import.meta.dirname, '..', '..', 'scripts')

const entry: HostEntry = {
  name: 'vm',
  ssh: 'vm',
  socket: '/run/user/1000/tether/default/control.sock',
  forwards: [],
  wake: null,
  sleep: null,
  status: null,
  statusOff: '\\bstopped\\b',
  health: [],
  wakeTimeoutSec: 240,
  stateDir: null,
}

function put(path: string, text: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  chmodSync(path, mode)
}

describe('remote Tether update', () => {
  let dir: string
  let release: string
  let home: string
  let lib: string
  let bin: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tether-update-'))
    release = join(dir, 'release')
    home = join(dir, 'home')
    lib = join(home, '.local', 'lib', 'tether')
    bin = join(dir, 'bin')
    // This hub's installed release, as install-release.sh lays it out.
    put(join(release, 'dist', 'tether.mjs'), 'new bundle\n')
    put(join(release, 'bin', 'tether'), '#!/bin/sh\nexit 0\n', 0o755)
    mkdirSync(join(release, 'scripts'), { recursive: true })
    for (const script of ['install-release.sh', 'install-shims.sh'])
      copyFileSync(join(SCRIPTS, script), join(release, 'scripts', script))
    put(join(release, 'scripts', 'aico-root-watch.py'), '# watch\n', 0o755)
    put(join(release, 'scripts', 'aico-blank-slate'), '# blank\n', 0o755)
    put(join(release, 'shims', 'tether-shim'), '#!/bin/sh\n', 0o755)
    put(join(release, 'shims', 'shims.list'), 'git prepend --no-pager\n')
    // The host's older release.
    put(join(lib, 'dist', 'tether.mjs'), 'old bundle\n')
    put(join(lib, 'bin', 'tether'), '#!/bin/sh\nexit 0\n', 0o755)
    // A stand-in systemctl that records what it was asked.
    put(join(bin, 'systemctl'), `#!/bin/sh\necho "$*" >> "${join(dir, 'systemctl.log')}"\n`, 0o755)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** The host side as the hub runs it over ssh, here in a local shell. */
  const hostArgv = () => [
    'env',
    `HOME=${home}`,
    `PATH=${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    'bash',
    '-c',
    updateLine('default', entry.socket, 1),
  ]
  const target = { entry, control: '/run/x/ssh.ctl', instance: 'default' }
  const restarts = () =>
    existsSync(join(dir, 'systemctl.log'))
      ? readFileSync(join(dir, 'systemctl.log'), 'utf8').trim().split('\n')
      : []

  it("installs the hub's release on the host and restarts its Tether there", async () => {
    const result = await pushRelease(release, target, { argv: hostArgv() })
    expect(result.code).toBe(0)
    expect(readFileSync(join(lib, 'dist', 'tether.mjs'), 'utf8')).toBe('new bundle\n')
    // The host can pass the release on in turn: the installer came with it.
    expect(existsSync(join(lib, 'scripts', 'install-release.sh'))).toBe(true)
    expect(existsSync(join(lib, 'scripts', 'install-shims.sh'))).toBe(true)
    expect(readlinkSync(join(lib, 'shims', 'git'))).toBe('tether-shim')
    expect(restarts()).toEqual(['--user --no-ask-password restart tether@default'])
  })

  it('puts the previous bundle back when the new one does not answer', async () => {
    put(join(release, 'bin', 'tether'), '#!/bin/sh\nexit 1\n', 0o755)
    const result = await pushRelease(release, target, { argv: hostArgv() })
    expect(result.code).toBe(1)
    expect(result.output).toBe(
      'the new release did not answer within 1 s; the previous release is back',
    )
    expect(readFileSync(join(lib, 'dist', 'tether.mjs'), 'utf8')).toBe('old bundle\n')
    expect(readFileSync(join(lib, 'bin', 'tether'), 'utf8')).toBe('#!/bin/sh\nexit 0\n')
    expect(restarts()).toEqual([
      '--user --no-ask-password restart tether@default',
      '--user --no-ask-password restart tether@default',
    ])
  })

  it('sends nothing without a whole release or a usable instance', async () => {
    expect((await pushRelease(null, target)).output).toBe(
      'this Tether does not run from an installed release',
    )
    rmSync(join(release, 'scripts', 'install-release.sh'))
    expect((await pushRelease(release, target)).output).toBe(
      `this Tether's release at ${release} has no scripts/install-release.sh`,
    )
    copyFileSync(
      join(SCRIPTS, 'install-release.sh'),
      join(release, 'scripts', 'install-release.sh'),
    )
    expect(
      (await pushRelease(release, { ...target, instance: "x'; rm -rf ~" }, { argv: ['false'] }))
        .output,
    ).toContain('named no usable instance')
    expect(restarts()).toEqual([])
  })

  it('lists every file install-release.sh installs', () => {
    const installer = readFileSync(join(SCRIPTS, 'install-release.sh'), 'utf8')
    const installed = [...installer.matchAll(/"\$lib_dir\/([^"]+)"/g)].map((match) => match[1])
    expect(installed.length).toBeGreaterThan(0)
    for (const file of installed) expect(RELEASE_FILES).toContain(file)
  })

  it('finds the installed release this process runs from', () => {
    expect(runningRelease('/home/u/.local/lib/tether/dist/tether.mjs')).toBe(
      '/home/u/.local/lib/tether',
    )
    expect(runningRelease('/repo/node_modules/vitest/vitest.mjs')).toBeNull()
    expect(runningRelease(undefined)).toBeNull()
  })
})

import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { remoteArgv } from './host-admin'
import type { HostEntry } from './hosts'
import {
  installStarted,
  pushRelease,
  RELEASE_FILES,
  releaseId,
  runningRelease,
  UPDATE_BUSY_EXIT,
  UPDATE_INSTALLING,
  updateLine,
} from './update'

const SCRIPTS = join(import.meta.dirname, '..', '..', 'scripts')

const entry: HostEntry = {
  name: 'vm',
  ssh: 'vm',
  socket: '/run/user/1000/tether/default/control.sock',
  sync: null,
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
  /** The host Tether's database (resolvePaths: $XDG_STATE_HOME/tether/<instance>). */
  let state: string
  let db: string
  let holder: ChildProcess | null

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tether-update-'))
    release = join(dir, 'release')
    home = join(dir, 'home')
    lib = join(home, '.local', 'lib', 'tether')
    bin = join(dir, 'bin')
    state = join(home, '.local', 'state', 'tether', 'default')
    db = join(state, 'tether.db')
    holder = null
    // A Tether that answered its link has opened its database.
    put(db, 'schema 25\n', 0o600)
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
    // A stand-in systemctl that records what it was asked. A start (or
    // restart) on the new bundle migrates the database, as Tether's Store does.
    put(
      join(bin, 'systemctl'),
      [
        '#!/bin/sh',
        `echo "$*" >> "${join(dir, 'systemctl.log')}"`,
        'case "$*" in *start*)',
        `  if grep -q "new bundle" "${join(lib, 'dist', 'tether.mjs')}" && [ -f "${db}" ]; then`,
        `    echo "schema 28" > "${db}"; echo "wal 28" > "${db}-wal"`,
        '  fi;;',
        'esac',
        '',
      ].join('\n'),
      0o755,
    )
  })

  afterEach(() => {
    holder?.kill('SIGKILL')
    if (existsSync(state)) chmodSync(state, 0o700)
    rmSync(dir, { recursive: true, force: true })
  })

  /** The host side as the hub runs it over ssh: the remote command ssh hands
   * the host's shell (remoteArgv's `bash -lc '<line>'`), here in a local one. */
  const hostArgv = () => [
    'env',
    '-i',
    `HOME=${home}`,
    `PATH=${bin}:/usr/bin:/bin`,
    `XDG_STATE_HOME=${join(home, '.local', 'state')}`,
    'sh',
    '-c',
    remoteArgv(entry, '/run/x/ssh.ctl', updateLine('default', entry.socket, 1)).at(-1) ?? '',
  ]
  const target = { entry, control: '/run/x/ssh.ctl', instance: 'default' }
  const restarts = () =>
    existsSync(join(dir, 'systemctl.log'))
      ? readFileSync(join(dir, 'systemctl.log'), 'utf8').trim().split('\n')
      : []
  const stop = '--user --no-ask-password stop tether@default'
  const start = '--user --no-ask-password start tether@default'
  /** The host's database before the update, at an older schema. */
  function oldDatabase(): void {
    put(db, 'schema 20\n', 0o600)
    put(`${db}-wal`, 'wal 20\n', 0o600)
    put(`${db}-shm`, 'shm\n', 0o600)
    // The old release answers only on a schema it can read.
    put(join(lib, 'bin', 'tether'), `#!/bin/sh\ngrep -q "schema 20" "${db}"\n`, 0o755)
  }

  it("installs the hub's release on the host and restarts its Tether there", async () => {
    const result = await pushRelease(release, target, { argv: hostArgv() })
    expect(result.code).toBe(0)
    expect(installStarted(result)).toBe(true)
    expect(readFileSync(join(lib, 'dist', 'tether.mjs'), 'utf8')).toBe('new bundle\n')
    // The host can pass the release on in turn: the installer came with it.
    expect(existsSync(join(lib, 'scripts', 'install-release.sh'))).toBe(true)
    expect(existsSync(join(lib, 'scripts', 'install-shims.sh'))).toBe(true)
    expect(readlinkSync(join(lib, 'shims', 'git'))).toBe('tether-shim')
    expect(restarts()).toEqual([stop, start])
  })

  it('puts the previous bundle back when the new one does not answer', async () => {
    put(join(release, 'bin', 'tether'), '#!/bin/sh\nexit 1\n', 0o755)
    const result = await pushRelease(release, target, { argv: hostArgv() })
    expect(result.code).toBe(1)
    expect(result.output).toBe(
      'the new release did not answer within 1 s; the previous release and its database are back',
    )
    // It failed after the host began installing: the same release would again.
    expect(installStarted(result)).toBe(true)
    expect(readFileSync(join(lib, 'dist', 'tether.mjs'), 'utf8')).toBe('old bundle\n')
    expect(readFileSync(join(lib, 'bin', 'tether'), 'utf8')).toBe('#!/bin/sh\nexit 0\n')
    expect(restarts()).toEqual([stop, start, stop, start])
  })

  it('puts the database back too when the new release moved its schema and then failed', async () => {
    oldDatabase()
    put(join(release, 'bin', 'tether'), '#!/bin/sh\nexit 1\n', 0o755)
    const result = await pushRelease(release, target, { argv: hostArgv() })
    expect(result).toMatchObject({
      code: 1,
      output:
        'the new release did not answer within 1 s; the previous release and its database are back',
    })
    // What the old release can read, with its WAL; the stale index is dropped.
    expect(readFileSync(db, 'utf8')).toBe('schema 20\n')
    expect(readFileSync(`${db}-wal`, 'utf8')).toBe('wal 20\n')
    expect(existsSync(`${db}-shm`)).toBe(false)
    expect(readFileSync(join(lib, 'dist', 'tether.mjs'), 'utf8')).toBe('old bundle\n')
    expect(restarts()).toEqual([stop, start, stop, start])
  })

  it('says so when the previous release does not answer after the rollback either', async () => {
    put(join(lib, 'bin', 'tether'), '#!/bin/sh\nexit 1\n', 0o755)
    put(join(release, 'bin', 'tether'), '#!/bin/sh\nexit 1\n', 0o755)
    const result = await pushRelease(release, target, { argv: hostArgv() })
    expect(result.output).toBe(
      'the new release did not answer within 1 s; the previous release and its database are back but did not answer within 1 s either',
    )
  })

  it.skipIf(process.getuid?.() === 0)(
    'never starts the previous release on a database it could not put back',
    async () => {
      oldDatabase()
      put(join(release, 'bin', 'tether'), '#!/bin/sh\nexit 1\n', 0o755)
      // The state directory takes no new file (a full or read-only disk).
      chmodSync(state, 0o500)
      const result = await pushRelease(release, target, { argv: hostArgv() })
      expect(result.code).toBe(1)
      const copy = /a copy is in (\S+)\)/.exec(result.output)?.[1] ?? ''
      expect(result.output).toBe(
        `the new release did not answer within 1 s; its database could not be put back (a copy is in ${copy}), so tether@default stays stopped`,
      )
      expect(readFileSync(join(copy, 'tether.db'), 'utf8')).toBe('schema 20\n')
      expect(restarts()).toEqual([stop, start, stop])
      rmSync(dirname(copy), { recursive: true, force: true })
    },
  )

  it('runs one update on a host at a time', async () => {
    const lock = join(lib, '.update.lock')
    holder = spawn('flock', [lock, 'sleep', '30'], { stdio: 'ignore' })
    await vi.waitFor(() => expect(spawnSync('flock', ['-n', lock, 'true']).status).not.toBe(0))
    const result = await pushRelease(release, target, { argv: hostArgv() })
    expect(result).toMatchObject({
      code: UPDATE_BUSY_EXIT,
      output: "another update of this host's Tether is still running",
    })
    expect(installStarted(result)).toBe(false)
    expect(readFileSync(join(lib, 'dist', 'tether.mjs'), 'utf8')).toBe('old bundle\n')
    expect(restarts()).toEqual([])
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

  it('installs nothing when the release does not arrive whole', async () => {
    // A link that drops mid-copy: the host gets a cut-off tar stream.
    const cut = [
      'sh',
      '-c',
      `head -c 100 | ${hostArgv()
        .map((word) => `'${word.replace(/'/g, `'\\''`)}'`)
        .join(' ')}`,
    ]
    const result = await pushRelease(release, target, { argv: cut })
    expect(result.code).not.toBe(0)
    expect(installStarted(result)).toBe(false)
    expect(readFileSync(join(lib, 'dist', 'tether.mjs'), 'utf8')).toBe('old bundle\n')
    expect(restarts()).toEqual([])
  })

  it('installs nothing when its database is not where the script looks', async () => {
    // A rollback could not put it back, so an old release would meet a newer schema.
    rmSync(db)
    const result = await pushRelease(release, target, { argv: hostArgv() })
    expect(result.code).toBe(1)
    expect(result.output).toBe(`no Tether database at ${state}; nothing installed`)
    expect(installStarted(result)).toBe(false)
    expect(readFileSync(join(lib, 'dist', 'tether.mjs'), 'utf8')).toBe('old bundle\n')
    expect(restarts()).toEqual([])
  })

  it("looks for the database under the host's stateDir when hosts.json sets one", () => {
    expect(updateLine('default', entry.socket, 1, '/srv/tether-state')).toContain(
      'state=\'/srv/tether-state\'/"$instance"',
    )
    expect(updateLine('default', entry.socket, 1)).toContain('XDG_STATE_HOME')
  })

  it('sees the install marker when a login profile printed before it on the same line', () => {
    expect(installStarted({ code: 1, stdout: `motd${UPDATE_INSTALLING}\n`, output: '' })).toBe(true)
  })

  it('lists every file install-release.sh installs', () => {
    const installer = readFileSync(join(SCRIPTS, 'install-release.sh'), 'utf8')
    const installed = [...installer.matchAll(/"\$lib_dir\/([^"]+)"/g)].map((match) => match[1])
    expect(installed.length).toBeGreaterThan(0)
    for (const file of installed) expect(RELEASE_FILES).toContain(file)
  })

  it('names the release by its bundle', () => {
    const first = releaseId(release)
    expect(first).toMatch(/^[0-9a-f]{16}$/)
    put(join(release, 'dist', 'tether.mjs'), 'newer bundle\n')
    expect(releaseId(release)).not.toBe(first)
    expect(releaseId(null)).toBe('none')
  })

  it('finds the installed release this process runs from', () => {
    expect(runningRelease('/home/u/.local/lib/tether/dist/tether.mjs')).toBe(
      '/home/u/.local/lib/tether',
    )
    expect(runningRelease('/repo/node_modules/vitest/vitest.mjs')).toBeNull()
    expect(runningRelease(undefined)).toBeNull()
  })
})

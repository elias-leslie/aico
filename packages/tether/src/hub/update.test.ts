import { execFileSync, spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { HostEntry } from '@aico/fleet/hosts'
import {
  RELEASE_FILES,
  releaseHash,
  SIGNED_RELEASE,
  signRelease,
  verifyRelease,
} from '@aico/fleet/releases'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { API_VERSION } from '../config'
import {
  installStarted,
  pushRelease,
  receiveUpdate,
  UPDATE_BUSY_EXIT,
  updateResult,
} from './update'

const mocks = vi.hoisted(() => ({ exec: vi.fn(), pins: vi.fn(), keys: vi.fn(), run: vi.fn() }))
vi.mock('@aico/fleet/exec', async (original) => ({
  ...(await original<typeof import('@aico/fleet/exec')>()),
  requestExec: mocks.exec,
}))
vi.mock('@aico/fleet/trust', async (original) => ({
  ...(await original<typeof import('@aico/fleet/trust')>()),
  readPins: mocks.pins,
}))
vi.mock('@aico/fleet/releases', async (original) => ({
  ...(await original<typeof import('@aico/fleet/releases')>()),
  readUpdateKeys: mocks.keys,
}))
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawnSync: mocks.run,
}))
let dir: string, release: string, lib: string, signer: string, state: string, report: string
const pair = generateKeyPairSync('ed25519')
const machine = hostname().split('.')[0]?.toLowerCase() as string
const entry = {
  name: 'worker',
  socket: '/run/user/4321/tether/default/control.sock',
  stateDir: null,
} as HostEntry
const target = { entry, control: '/test/exec.sock', instance: 'default' }
const id = '11111111-1111-1111-1111-111111111111'
function put(path: string, text: string, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, { mode })
}
function sign() {
  const input = signRelease(release, signer, API_VERSION, 2000)
  put(join(release, SIGNED_RELEASE), input)
  return input
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aico-update-'))
  release = join(dir, 'release')
  lib = join(dir, 'home/.local/lib/tether')
  state = join(dir, 'state')
  signer = join(dir, 'signer')
  put(signer, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 0o600)
  for (const file of RELEASE_FILES)
    put(
      join(release, file),
      file === 'bin/tether' ? '#!/bin/sh\nexit 0\n' : `fixture ${file}\n`,
      0o755,
    )
  for (const script of ['install-release.sh', 'install-shims.sh'])
    copyFileSync(
      join(import.meta.dirname, '../../scripts', script),
      join(release, 'scripts', script),
    )
  put(join(release, 'shims/shims.list'), '')
  for (const file of RELEASE_FILES)
    put(
      join(lib, file),
      file === 'dist/tether.mjs' ? 'previous bundle' : readFileSync(join(release, file), 'utf8'),
      0o755,
    )
  put(join(dir, 'home/.local/state/tether/default/tether.db'), 'fixture db')
  put(join(dir, 'bin/systemctl'), '#!/bin/sh\nexit 0\n', 0o755)
  const config = join(dir, 'fleet.json')
  put(
    config,
    JSON.stringify({
      machine,
      stateDir: state,
      allowlist: '/test/pins',
      listen: { address: '127.0.0.1', port: 7449 },
      peers: [{ name: 'worker', endpoint: { address: '127.0.0.1', port: 7450 } }],
      syncSocket: join(dir, 'sync.sock'),
      peerRoot: '/run/user/' + process.getuid?.() + '/aico/fleet',
      retryMinMs: 1,
      retryMaxMs: 1,
      deadMs: 300000,
      statusMs: 5000,
      statusUrl: 'http://127.0.0.1:3002/api/status/rows',
    }),
  )
  vi.stubEnv('HOME', join(dir, 'home'))
  vi.stubEnv('XDG_STATE_HOME', join(dir, 'home/.local/state'))
  vi.stubEnv('AICO_FLEET_CONFIG', config)
  vi.stubEnv('TETHER_LIB_DIR', lib)
  vi.stubEnv('PATH', join(dir, 'bin') + ':/usr/bin:/bin')
  mocks.pins.mockReturnValue([
    { name: machine, role: 'full' },
    { name: 'worker', role: 'worker' },
  ])
  mocks.keys.mockReturnValue([pair.publicKey])
  mocks.exec.mockReset()
  const real = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  report = ''
  mocks.run.mockImplementation((command, args, options) => {
    if (command === 'systemd-run') {
      report = args.at(-1)
      return { status: 0, stdout: '', stderr: '' }
    }
    return real.spawnSync(command, args, options)
  })
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})
it('refuses unsigned releases, worker senders and unpinned recipients before exec', async () => {
  expect((await pushRelease(release, target)).code).toBeNull()
  sign()
  mocks.pins.mockReturnValue([
    { name: machine, role: 'worker' },
    { name: 'worker', role: 'worker' },
  ])
  expect((await pushRelease(release, target)).output).toContain('full peer')
  mocks.pins.mockReturnValue([{ name: machine, role: 'full' }])
  expect((await pushRelease(release, target)).output).toContain('approved')
  expect(mocks.exec).not.toHaveBeenCalled()
})
it('refuses a stale signed envelope whose bundle differs from the running release', async () => {
  sign()
  put(join(release, 'dist/tether.mjs'), 'newer bundle')
  expect((await pushRelease(release, target)).output).toContain('stale')
  expect(mocks.exec).not.toHaveBeenCalled()
})
it('verifies receive-update before any installer runs, rejects old APIs and treats equal hashes as a no-op', () => {
  const envelope = sign()
  expect(() =>
    receiveUpdate('{}', { instance: 'default', socket: entry.socket, stateDir: null, id }),
  ).toThrow('Update refused')
  const older = signRelease(release, signer, API_VERSION - 1, 1000)
  expect(() =>
    receiveUpdate(older, { instance: 'default', socket: entry.socket, stateDir: null, id }),
  ).toThrow('older API')
  for (const file of RELEASE_FILES)
    put(join(lib, file), readFileSync(join(release, file), 'utf8'), 0o755)
  expect(
    receiveUpdate(envelope, { instance: 'default', socket: entry.socket, stateDir: null, id })
      .stdout,
  ).toBe('Already installed')
  expect(report).toBe('')
})
it('refuses an older signed release even within the same API version', () => {
  const older = sign()
  const current = join(dir, 'current')
  for (const file of RELEASE_FILES) put(join(current, file), 'newer ' + file)
  put(join(lib, SIGNED_RELEASE), signRelease(current, signer, API_VERSION, 3000))
  expect(() =>
    receiveUpdate(older, { instance: 'default', socket: entry.socket, stateDir: null, id }),
  ).toThrow('older signed release')
})
it('reports the real busy result and succeeds on a subsequent signed push', async () => {
  const input = sign()
  const digest = verifyRelease(input, [pair.publicKey]).releaseHash
  mkdirSync(lib, { recursive: true })
  const holder = spawn(
    'flock',
    [join(lib, '.update.lock'), 'bash', '-c', 'echo ready; read value'],
    { stdio: ['pipe', 'pipe', 'ignore'] },
  )
  await new Promise<void>((resolve) => holder.stdout.once('data', () => resolve()))
  mocks.exec.mockImplementation(async (_socket, argv: string[], body: Buffer) => {
    if (argv[2]?.includes('receive-update')) {
      const result = receiveUpdate(body.toString(), {
        instance: argv[4] as string,
        socket: argv[5] as string,
        stateDir: null,
        id: argv[7] as string,
      })
      try {
        execFileSync('bash', ['-c', report], { env: process.env, stdio: 'pipe' })
      } catch {}
      return result
    }
    return {
      code: 0,
      stdout: JSON.stringify(updateResult(argv[4] as string, argv[5] as string)),
      output: '',
    }
  })
  try {
    const busy = await pushRelease(release, target)
    expect(busy.code).toBe(UPDATE_BUSY_EXIT)
    expect(installStarted(busy)).toBe(false)
  } finally {
    holder.stdin.end()
    await new Promise((resolve) => holder.once('close', resolve))
  }
  const result = await pushRelease(release, target)
  expect(result.code).toBe(0)
  expect(installStarted(result)).toBe(true)
  expect(releaseHash(lib)).toBe(digest)
})

it('removes stale update metadata when an unsigned local release is installed', () => {
  put(join(lib, SIGNED_RELEASE), 'stale metadata')
  mkdirSync(join(release, 'scripts/shims'), { recursive: true })
  for (const file of ['tether-shim', 'shims.list'])
    copyFileSync(join(release, 'shims', file), join(release, 'scripts/shims', file))
  execFileSync('bash', [join(release, 'scripts/install-release.sh')], {
    env: process.env,
    stdio: 'pipe',
  })
  expect(existsSync(join(lib, SIGNED_RELEASE))).toBe(false)
})

it('worker installation stops at failed signature verification before replacing code', () => {
  const before = readFileSync(join(lib, 'dist/tether.mjs'), 'utf8')
  put(join(dir, 'bin/sudo'), '#!/bin/sh\nexit 0\n', 0o755)
  put(join(dir, 'bin/node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`, 0o755)
  const marker = join(dir, 'candidate-executed')
  put(
    join(release, 'dist/tether.mjs'),
    `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');process.exit(0)`,
  )
  put(join(release, SIGNED_RELEASE), '{}')
  put(join(dir, 'commands.json'), '[]')
  const script = join(import.meta.dirname, '../../../../scripts/install-worker.sh')
  expect(() =>
    execFileSync(
      'bash',
      [
        script,
        release,
        process.env.AICO_FLEET_CONFIG as string,
        signer,
        signer,
        join(dir, 'commands.json'),
      ],
      { env: process.env, stdio: 'pipe' },
    ),
  ).toThrow()
  expect(readFileSync(join(lib, 'dist/tether.mjs'), 'utf8')).toBe(before)
  expect(existsSync(marker)).toBe(false)
})

it('reports a failed health check and restores the prior release and database', () => {
  const oldHash = releaseHash(lib)
  put(join(release, 'bin/tether'), '#!/bin/sh\nexit 1\n', 0o755)
  put(join(dir, 'bin/sleep'), '#!/bin/sh\nexit 0\n', 0o755)
  put(
    join(dir, 'bin/systemctl'),
    `#!/bin/sh\ncase "$*" in *start*) if grep -q "exit 1" "${join(lib, 'bin/tether')}"; then echo changed > "${join(dir, 'home/.local/state/tether/default/tether.db')}"; fi;; esac\nexit 0\n`,
    0o755,
  )
  const input = sign()
  const digest = verifyRelease(input, [pair.publicKey]).releaseHash
  receiveUpdate(input, { instance: 'default', socket: entry.socket, stateDir: null, id })
  expect(() => execFileSync('bash', ['-c', report], { env: process.env, stdio: 'pipe' })).toThrow()
  expect(updateResult(id, digest)).toMatchObject({
    code: 1,
    output: expect.stringContaining('previous release'),
  })
  expect(releaseHash(lib)).toBe(oldHash)
  expect(readFileSync(join(dir, 'home/.local/state/tether/default/tether.db'), 'utf8')).toBe(
    'fixture db',
  )
  expect(existsSync(join(lib, SIGNED_RELEASE))).toBe(false)
})

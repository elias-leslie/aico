import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveExec } from '@aico/fleet/exec'
import { readSettings } from '@aico/fleet/settings'
import { readPins } from '@aico/fleet/trust'
import { afterEach, expect, it, vi } from 'vitest'
import { config, copyKey, emptyState } from './backup-plan'
import { execute, saveState } from './backup-runtime'
import { backups } from './backups'

vi.mock('@aico/fleet/settings', () => ({ readSettings: vi.fn() }))
vi.mock('@aico/fleet/trust', () => ({ readPins: vi.fn() }))
vi.mock('./backup-runtime', async (original) => ({
  ...(await original<typeof import('./backup-runtime')>()),
  execute: vi.fn(async () => ({ code: 0, out: '[]', err: '' })),
}))

const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'backup-coverage-cli-'))
  roots.push(root)
  const cfg = config({ AICO_BACKUP_MACHINE: 'davion-sidarli' })
  cfg.stateDir = join(root, 'state')
  cfg.legacyHostState = join(root, 'legacy-host')
  cfg.legacyDriveState = join(root, 'legacy-drive')
  Object.assign(cfg, { coverageReadSeconds: 0.3 })
  const state = emptyState()
  state.goodDriveRuns = 0
  state.copies[copyKey('pve-host-files', 'drive')] = {
    source: 'pve-host-files',
    target: 'drive',
    snapshot: 'a'.repeat(64),
    dataAt: new Date().toISOString(),
  }
  saveState(cfg, state)
  const path = join(root, 'backups.json')
  writeFileSync(path, JSON.stringify(cfg))
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation((line) => void lines.push(String(line)))
  return {
    root,
    cfg,
    state,
    lines,
    env: { AICO_BACKUPS_CONFIG: path, AICO_BACKUP_MACHINE: cfg.workstation },
  }
}

it('routes --fleet --local through the real list command without jobs, probes or a recursive peer read', async () => {
  const f = fixture()
  expect(await backups(['list', '--fleet', '--local', '--json'], f.env)).toBe(0)
  const result = JSON.parse(f.lines[0] as string)
  expect(result.owners).toHaveLength(1)
  expect(result.owners[0]).toMatchObject({
    machine: f.cfg.workstation,
    state: 'read',
    retained: [expect.objectContaining({ source: 'pve-host-files', snapshot: 'a'.repeat(64) })],
  })
  expect(
    result.owners[0].entries.some((e: { source: string }) => e.source === 'pve-host-files'),
  ).toBe(false)
  expect(execute).not.toHaveBeenCalled()
  expect(readSettings).not.toHaveBeenCalled()
})

it('keeps the ordinary local list contract and active-source counts unchanged', async () => {
  const f = fixture()
  expect(await backups(['list', '--json'], f.env)).toBe(0)
  const result = JSON.parse(f.lines[0] as string)
  expect(Object.keys(result).sort()).toEqual(['entries', 'machine', 'runs'])
  expect(
    result.entries.some(
      (e: { source: string; target: string }) =>
        e.source === 'pve-host-files' && e.target === 'drive',
    ),
  ).toBe(false)
  expect(execute).toHaveBeenCalledWith(['aico', 'jobs', 'list', '--json'])
  expect(readSettings).not.toHaveBeenCalled()
})

it.skipIf(!existsSync(`/run/user/${process.getuid?.()}/bus`))(
  'returns readable local coverage when an accepted peer stalls, and the manager cleans up its remote read and descendants',
  async () => {
    const f = fixture()
    // Real fleet exec runs from Tether's user service. Give this isolated fixture the same bus.
    const runtime = `/run/user/${process.getuid?.()}`
    vi.stubEnv('XDG_RUNTIME_DIR', runtime)
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', `unix:path=${runtime}/bus`)
    const pidFile = join(f.root, 'owned-read.json')
    const sockets = new Set<Socket>()
    let requested: string[] = []
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket)
      socket.on('error', () => {})
      socket.once('close', () => sockets.delete(socket))
      let pending = ''
      const hello = (chunk: Buffer) => {
        pending += chunk.toString()
        const end = pending.indexOf('\n')
        if (end < 0) return
        socket.off('data', hello)
        requested = JSON.parse(pending.slice(0, end))
        // Stand in for a wedged read on the peer, retaining the caller's actual manager argv.
        const script = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)']); require('node:fs').writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid])); setInterval(()=>{},1000)`
        const command = [process.execPath, '-e', script, pidFile]
        serveExec(
          socket,
          requested[0] === 'systemd-run'
            ? [...requested.slice(0, requested.indexOf('sh')), ...command]
            : command,
        )
      }
      socket.on('data', hello)
    })
    const peerRoot = join(f.root, 'fleet')
    const socketPath = join(f.root, 'exec.sock')
    // The configured peer name resolves to this socket with the real fleet path construction.
    mkdirSync(join(peerRoot, 'aico'), { recursive: true })
    symlinkSync(socketPath, join(peerRoot, 'aico', 'exec.sock'))
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    vi.mocked(readSettings).mockReturnValue({
      machine: f.cfg.workstation,
      stateDir: f.root,
      allowlist: '/fixture-pins',
      listen: { address: '127.0.0.1', port: 1 },
      peers: [{ name: 'aico', endpoint: { address: '127.0.0.1', port: 2 } }],
      controlSocket: '/control',
      syncSocket: '/sync',
      peerRoot,
      retryMinMs: 1,
      retryMaxMs: 1,
      deadMs: 1,
      statusMs: 1,
      statusUrl: 'http://127.0.0.1',
    })
    vi.mocked(readPins).mockReturnValue([{ name: 'aico', role: 'full', publicKey: 'fixture' }])
    let watchdog: NodeJS.Timeout | undefined
    const running = (pid: number) => {
      try {
        return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0] !== 'Z'
      } catch {
        return false
      }
    }
    try {
      const began = Date.now()
      const result = await Promise.race([
        backups(['list', '--fleet', '--json'], f.env),
        new Promise<null>((resolve) => {
          watchdog = setTimeout(() => resolve(null), 1500)
        }),
      ])
      expect(result).toBe(0)
      expect(Date.now() - began).toBeLessThan(1500)
      const coverage = JSON.parse(f.lines[0] as string)
      expect(coverage.owners[0]).toMatchObject({ machine: f.cfg.workstation, state: 'read' })
      expect(coverage.owners[0].retained[0].snapshot).toBe('a'.repeat(64))
      expect(coverage.owners[1]).toMatchObject({ machine: 'aico', state: 'unknown' })
      expect(requested[0]).toBe('systemd-run')
      expect(requested).toContain('--property=RuntimeMaxSec=0.3s')
      expect(requested).toContain('--property=KillMode=control-group')
      expect(requested.at(-1)).toContain('backups list --fleet --local --json')
      expect(execute).not.toHaveBeenCalled()
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true))
      const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as number[]
      await vi.waitFor(() => expect(pids.filter(running)).toEqual([]))
    } finally {
      clearTimeout(watchdog)
      for (const socket of sockets) socket.destroy()
      server.close()
      if (existsSync(pidFile))
        for (const pid of JSON.parse(readFileSync(pidFile, 'utf8')) as number[])
          if (running(pid))
            try {
              process.kill(pid, 'SIGKILL')
            } catch {}
    }
  },
)

import { spawn } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type BackupConfig,
  type BackupState,
  type BackupTarget,
  copyKey,
  driveSpec,
  emptyState,
  homePath,
  migrated,
  stateFile,
} from './backup-plan'

/** What fits after the copy's own sentence in a backup row's 300 characters; a row is not a log. */
const REASON_LIMIT = 200
export interface Result {
  code: number
  out: string
  err: string
}
export type Execute = (
  argv: string[],
  options?: { env?: NodeJS.ProcessEnv; cwd?: string; timeout?: number },
) => Promise<Result>
/** Bounded output, no argv or environment logging (credentials are file references only). */
export const execute: Execute = (argv, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(argv[0] as string, argv.slice(1), {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '',
      err = ''
    child.stdout.on('data', (data) => {
      out = (out + String(data)).slice(-(16 << 20))
    })
    child.stderr.on('data', (data) => {
      err = (err + String(data)).slice(-(1 << 20))
    })
    child.on('error', () => resolve({ code: 127, out, err: 'The program could not start.' }))
    child.on('close', (code) => resolve({ code: code ?? 1, out, err }))
  })
export const checked = async (run: Execute, argv: string[], options?: Parameters<Execute>[1]) => {
  const result = await run(argv, options)
  if (result.code !== 0)
    throw new Error(
      `${argv[0]?.split('/').at(-1)} failed (exit ${result.code})${failureReason(result, ': ')}.`,
    )
  return result.out
}
/** One line for the copy's record: no file paths from inside a backup, nothing that looks like a secret. */
function cleanReason(text: string): string {
  return (text.split('\n', 1)[0] as string)
    .replace(/(^|[\s"'(=:])(?!i\/o\b)(?!\d{4}\/\d{2}\/\d{2}\b)[^\s"'(=:]*\/[^:"')]*/g, '$1<path>')
    .replace(
      /\b(token|password|secret|key|authorization|bearer)(\s*[=:]\s*|\s+)\S+/gi,
      '$1 <hidden>',
    )
    .replace(/\b[A-Za-z0-9+_-]{32,}\b/g, '<hidden>')
    .trim()
}
/**
 * Why a failed run failed, from what restic (with --json) and what it ran wrote to stderr: the last
 * plain line (a capture's or rclone's own words) first as it says the most, then its last per-file
 * error and its exit message. Empty when they said nothing. The prefix only appears with a reason.
 */
export function failureReason(result: Result, prefix = ''): string {
  let exit = '',
    failed = '',
    plain = ''
  for (const line of result.err.split('\n')) {
    if (!line.trim()) continue
    try {
      const v = JSON.parse(line) as {
        message_type?: string
        message?: string
        error?: { message?: string }
      }
      if (v.message_type === 'exit_error') exit = cleanReason(v.message ?? '')
      // A per-file message names the file, more than once and in two forms: keep only why.
      if (v.message_type === 'error')
        failed = cleanReason(v.error?.message?.split(': ').at(-1) ?? '')
      if (v.message_type) continue
    } catch {}
    plain = cleanReason(line.replace(/^subprocess \S+: /, ''))
  }
  const reasons = [plain, failed, exit].filter(
    (reason, at, all) =>
      reason && all.indexOf(reason) === at && !all.some((o) => o !== reason && o.includes(reason)),
  )
  return reasons.length ? `${prefix}${reasons.join('; ').slice(0, REASON_LIMIT)}` : ''
}
function readRootState(cfg: BackupConfig): BackupState {
  if (existsSync(stateFile(cfg))) {
    const state = JSON.parse(readFileSync(stateFile(cfg), 'utf8')) as BackupState
    state.goodDriveRuns ??= legacyGoodRuns(cfg)
    return state
  }
  const state = emptyState()
  // Import successful receipts, never job timestamps as proof of a folder's data age.
  try {
    const saved = JSON.parse(
      readFileSync(join(homePath(cfg.legacyHostState), 'last-good.json'), 'utf8'),
    ) as { started_at: string; points: { source: string; snapshot: string; target: string }[] }
    state.points = saved.points.map((p) => ({ ...p, dataAt: saved.started_at }))
    for (const p of state.points)
      state.copies[copyKey(p.source, 'native')] = {
        source: p.source,
        target: 'native',
        dataAt: p.dataAt,
        path: p.target,
        snapshot: p.target,
        attemptedAt: p.dataAt,
      }
  } catch {}
  try {
    const saved = JSON.parse(
      readFileSync(join(homePath(cfg.legacyDriveState), 'state.json'), 'utf8'),
    ) as {
      jobs: Record<string, { time?: string; snapshot_id?: string }>
      seen?: Record<string, { status?: string; offline_since?: string }>
      last_run?: { jobs?: Record<string, { status?: string; offline_since?: string }> }
    }
    for (const [source, job] of Object.entries(saved.jobs ?? {}))
      if (job.time && job.snapshot_id)
        state.copies[copyKey(source, 'drive')] = {
          source,
          target: 'drive',
          dataAt: migrated.sources.find((s) => s.id === source)?.path.match(/^\/(media|mnt)\//)
            ? undefined
            : job.time,
          copiedAt: job.time,
          observed:
            (saved.seen ?? saved.last_run?.jobs)?.[source]?.status === 'offline'
              ? 'offline'
              : (saved.seen ?? saved.last_run?.jobs)?.[source]?.status === 'failed'
                ? 'failed'
                : 'ok',
          offlineSince: (saved.seen ?? saved.last_run?.jobs)?.[source]?.offline_since,
          snapshot: job.snapshot_id,
          attemptedAt: job.time,
        }
  } catch {}
  state.goodDriveRuns = legacyGoodRuns(cfg)
  return state
}
function legacyGoodRuns(cfg: BackupConfig): number {
  try {
    const saved = JSON.parse(
      readFileSync(join(homePath(cfg.legacyDriveState), 'state.json'), 'utf8'),
    ) as { runs?: { status?: string }[] }
    return saved.runs?.filter((run) => run.status === 'ok').length ?? 0
  } catch {
    return 0
  }
}
export function saveState(cfg: BackupConfig, state: BackupState) {
  const path = stateFile(cfg)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  renameSync(temp, path)
}
export function saveRun(
  cfg: BackupConfig,
  target: keyof BackupState['runs'],
  receipt: NonNullable<BackupState['runs'][typeof target]>,
): void {
  const root = join(homePath(cfg.stateDir), 'runs')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const path = join(root, `${target}.json`),
    tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(receipt) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}
export function readState(cfg: BackupConfig): BackupState {
  const state = readRootState(cfg)
  for (const target of ['native', 'drive', 'append', 'snapshots', 'guard', 'verify'] as const) {
    const path = join(homePath(cfg.stateDir), 'runs', `${target}.json`)
    if (existsSync(path)) state.runs[target] = JSON.parse(readFileSync(path, 'utf8'))
  }
  return state
}
export interface Runtime {
  cfg: BackupConfig
  run: Execute
  now: () => Date
}
export function resticArgs(
  cfg: BackupConfig,
  target: 'drive' | 'append',
  args: string[],
  root = false,
): { argv: string[]; env: NodeJS.ProcessEnv } {
  const spec = target === 'drive' ? driveSpec(cfg) : cfg.append
  // Root's copy runs with the home snapshot mounted over /home, so its cache can't live there.
  const cache = root ? homePath(cfg.rootCacheDir) : join(homePath(cfg.cacheDir), 'cache')
  const temp = join(
    process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`,
    'aico-backups',
  )
  for (const dir of [cache, temp]) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const argv = [
    'restic',
    '--repo',
    spec.repository,
    '--password-file',
    homePath(spec.passwordFile),
    '--cache-dir',
    cache,
    '--retry-lock',
    cfg.limits.lockWait,
    '--json',
  ]
  // Use the same Drive auth and password paths. Root gets a private copy as in the previous engine,
  // so a token refresh does not rewrite the owner's auth file.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: 'C.UTF-8',
    TMPDIR: temp,
    GOMAXPROCS: cfg.limits.gomaxprocs,
    GOMEMLIMIT: cfg.limits.gomemlimit,
  }
  if (root) env.HOME = temp
  if (target === 'drive') {
    const rclone = driveSpec(cfg).rcloneConfig
    if (rclone) {
      if (root) {
        const copy = join(temp, `drive-${process.pid}.conf`)
        copyRootAuth(homePath(rclone), copy)
        env.RCLONE_CONFIG = copy
      } else env.RCLONE_CONFIG = homePath(rclone)
    }
  }
  if (target === 'append') {
    // A forced-command SSH key reaches CT 160's append-only restic server, never a shell.
    const ssh = [
      'ssh',
      '-F',
      '/dev/null',
      '-p',
      cfg.pve.port,
      '-i',
      homePath(cfg.pve.appendKey),
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'IdentityAgent=none',
      '-o',
      'BatchMode=yes',
      `${cfg.pve.user}@${cfg.pve.address}`,
    ]
    argv.push('-o', `rclone.program=${ssh.join(' ')}`, '-o', 'rclone.args=serve restic --stdio')
  }
  return { argv: [...argv, ...args], env }
}
export async function restic(
  rt: Runtime,
  target: 'drive' | 'append',
  args: string[],
  binds: readonly [string, string][] = [],
): Promise<Result> {
  if (['forget', 'prune', 'key', 'init'].includes(args[0] ?? ''))
    throw new Error('This operation is not available from the backup runner.')
  const root = binds.length > 0
  let { argv, env } = resticArgs(rt.cfg, target, args, root)
  if (root) {
    const script =
      'while [ "$1" != -- ]; do mount --bind "$1" "$2" || exit 97; shift 2; done; shift; exec "$@"'
    argv = [
      'sudo',
      '-n',
      'unshare',
      '--mount',
      '--propagation',
      'private',
      '--',
      'env',
      '-i',
      ...Object.entries(env)
        .filter((p): p is [string, string] => typeof p[1] === 'string')
        .map(([k, v]) => `${k}=${v}`),
      'sh',
      '-c',
      script,
      'sh',
      ...binds.flat(),
      '--',
      ...argv,
    ]
    env = { PATH: process.env.PATH }
  }
  let result = await rt.run(argv, { env })
  if (result.code === 11 && args[0] !== 'unlock') {
    // restic unlock removes stale locks only. Never use --remove-all or disturb a live writer.
    const unlocked = await restic(rt, target, ['unlock'])
    if (unlocked.code === 0) result = await rt.run(argv, { env })
  }
  return result
}
export async function resticJson(
  rt: Runtime,
  target: 'drive' | 'append',
  args: string[],
): Promise<unknown> {
  const result = await restic(rt, target, args)
  if (result.code) throw new Error(`Could not read ${target} backups (exit ${result.code}).`)
  return JSON.parse(result.out)
}
export function summary(result: Result): { snapshot_id?: string; total_bytes_processed?: number } {
  for (const line of result.out.trim().split('\n').reverse()) {
    try {
      const v = JSON.parse(line)
      if (v.message_type === 'summary') return v
    } catch {}
  }
  return {}
}
/** Read straight from the release: nothing a live backup needs may sit in scratch. */
export function excludesPath(): string {
  return fileURLToPath(new URL('../data/backup.excludes', import.meta.url))
}

export function copyRootAuth(source: string, destination: string): void {
  try {
    unlinkSync(destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  copyFileSync(source, destination)
  chmodSync(destination, 0o600)
}

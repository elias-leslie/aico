// Sidecar lifecycle: Electron main owns the FastAPI sidecar as a child process,
// health-gates it on /health, and tears it down on quit. The pure helpers
// (interpreter resolution, spawn argv, health URL, poll loop) live up top so
// they unit-test cheaply without spawning Python; the `Sidecar` controller
// holds the live child handle.

import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import { join } from 'node:path'

export interface SidecarOptions {
  host: string
  port: number
  /** Repo root; the sidecar's interpreter and package live under it. */
  repoRoot: string
  /** State dir passed through so logs/db land where the rest of Aico expects. */
  stateDir: string
  env?: NodeJS.ProcessEnv
  /**
   * Packaged builds set this to the bundled sidecar executable (shipped via
   * electron-builder extraResources). When present it is spawned directly with
   * `args`, instead of `python -m aico_sidecar` — so the packaged app needs no
   * Python/uv/.venv. Dev (unset) keeps the editable-install interpreter path.
   */
  command?: string
  args?: string[]
}

/** Lifecycle transitions, logged by main and useful for a future status surface. */
export type SidecarStatus = 'starting' | 'ready' | 'unhealthy' | 'crashed' | 'stopped'

/**
 * The Python that runs the sidecar: explicit `AICO_SIDECAR_PYTHON` override,
 * else the repo's uv `.venv`. Editable-installed, so `-m aico_sidecar` resolves
 * regardless of cwd.
 */
export function resolvePython(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.AICO_SIDECAR_PYTHON ?? join(repoRoot, '.venv', 'bin', 'python')
}

/** argv for `python -m aico_sidecar`. */
export function sidecarArgs(): string[] {
  return ['-m', 'aico_sidecar']
}

/**
 * The bundled sidecar executable inside a packaged build: shipped by
 * electron-builder `extraResources` as `<resources>/sidecar/aico-sidecar/`,
 * a PyInstaller onedir whose launcher binary shares the bundle name.
 */
export function bundledSidecar(resourcesPath: string): string {
  return join(resourcesPath, 'sidecar', 'aico-sidecar', 'aico-sidecar')
}

export function healthUrl(host: string, port: number): string {
  return `http://${host}:${port}/health`
}

const SIDECAR_ENV_PASSTHROUGH = [
  'HOME',
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_COLLATE',
  'LC_NUMERIC',
  'LC_TIME',
  'TZ',
  'PYTHONHOME',
  'PYTHONPATH',
  'PYTHONUTF8',
  'PYTHONIOENCODING',
  'PYTHONUNBUFFERED',
  'PYTHONDONTWRITEBYTECODE',
  'VIRTUAL_ENV',
] as const

/**
 * The optional local helper needs runtime/locale context, not the Electron
 * process's provider credentials, cloud tokens, database URLs, or agent
 * secrets. Build an allowlisted child environment instead of copying all of
 * process.env across the privilege/process boundary.
 */
export function sidecarEnvironment(
  source: NodeJS.ProcessEnv,
  settings: { host: string; port: number; stateDir: string },
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {}
  for (const key of SIDECAR_ENV_PASSTHROUGH) {
    const value = source[key]
    if (value !== undefined) childEnv[key] = value
  }
  childEnv.AICO_SIDECAR_HOST = settings.host
  childEnv.AICO_SIDECAR_PORT = String(settings.port)
  childEnv.AICO_STATE_DIR = settings.stateDir
  return childEnv
}

async function isAicoSidecarHealth(res: Response): Promise<boolean> {
  if (!res.ok) return false
  try {
    const body: unknown = await res.json()
    return (
      typeof body === 'object' &&
      body !== null &&
      'status' in body &&
      body.status === 'ok' &&
      'service' in body &&
      body.service === 'aico-sidecar'
    )
  } catch {
    return false
  }
}

/**
 * Poll `url` until it returns Aico's expected JSON health identity, the timeout
 * elapses, or `signal` aborts. `fetchFn` is injectable so tests drive it without
 * a live server. Resolves true only for the expected sidecar response.
 */
export async function waitForHealth(
  url: string,
  opts: {
    timeoutMs?: number
    intervalMs?: number
    attemptTimeoutMs?: number
    signal?: AbortSignal
    fetchFn?: typeof fetch
  } = {},
): Promise<boolean> {
  const {
    timeoutMs = 10_000,
    intervalMs = 150,
    attemptTimeoutMs = 1_000,
    signal,
    fetchFn = fetch,
  } = opts
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) return false

    // A TCP connection can accept without ever returning HTTP headers. Give
    // every fetch its own AbortSignal, bounded by both the per-attempt and
    // overall health deadlines, instead of letting one hung request defeat the
    // existing startup timeout indefinitely.
    const attemptAbort = new AbortController()
    const abortAttempt = (): void => attemptAbort.abort(signal?.reason)
    signal?.addEventListener('abort', abortAttempt, { once: true })
    const remainingMs = Math.max(1, deadline - Date.now())
    const attemptTimer = setTimeout(
      () => attemptAbort.abort(new Error('sidecar health attempt timed out')),
      Math.max(1, Math.min(attemptTimeoutMs, remainingMs)),
    )
    try {
      const res = await fetchFn(url, { signal: attemptAbort.signal })
      if (await isAicoSidecarHealth(res)) return true
    } catch {
      // sidecar not up yet (ECONNREFUSED) — keep polling until the deadline
    } finally {
      clearTimeout(attemptTimer)
      signal?.removeEventListener('abort', abortAttempt)
    }
    if (signal?.aborted) return false

    const delayMs = Math.min(intervalMs, Math.max(0, deadline - Date.now()))
    if (delayMs > 0) {
      await new Promise<void>((resolve) => {
        let settled = false
        let delay: NodeJS.Timeout
        const finishDelay = (): void => {
          if (settled) return
          settled = true
          clearTimeout(delay)
          signal?.removeEventListener('abort', finishDelay)
          resolve()
        }
        delay = setTimeout(finishDelay, delayMs)
        signal?.addEventListener('abort', finishDelay, { once: true })
        if (signal?.aborted) finishDelay()
      })
    }
  }
  return false
}

/** Injection seam so the controller is unit-testable without a real Python child. */
export interface SidecarDeps {
  spawn?: typeof nodeSpawn
  waitForHealth?: typeof waitForHealth
}

export class Sidecar {
  private child: ChildProcess | null = null
  private abort: AbortController | null = null
  private readonly spawn: typeof nodeSpawn
  private readonly waitForHealth: typeof waitForHealth

  constructor(
    private readonly opts: SidecarOptions,
    /** Lifecycle sink (main logs it; later phases may forward to renderers). */
    private readonly onStatus: (status: SidecarStatus, detail?: string) => void = () => {},
    deps: SidecarDeps = {},
  ) {
    this.spawn = deps.spawn ?? nodeSpawn
    this.waitForHealth = deps.waitForHealth ?? waitForHealth
  }

  /** Spawn the sidecar and resolve once it reports healthy (or fails to). */
  async start(): Promise<boolean> {
    const { host, port, repoRoot, stateDir, env = process.env, command, args } = this.opts
    // Packaged: the bundled executable + empty argv. Dev: the .venv interpreter
    // running `-m aico_sidecar`.
    const exe = command ?? resolvePython(repoRoot, env)
    const argv = args ?? sidecarArgs()
    this.onStatus('starting', `${exe} ${argv.join(' ')} :${port}`)

    const startupAbort = new AbortController()
    this.abort = startupAbort
    let child: ChildProcess
    try {
      child = this.spawn(exe, argv, {
        cwd: repoRoot,
        env: sidecarEnvironment(env, { host, port, stateDir }),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      if (this.abort === startupAbort) this.abort = null
      this.onStatus('crashed', `spawn failed: ${errorDetail(err)}`)
      return false
    }
    this.child = child

    child.stdout?.on('data', (b: Buffer) => process.stdout.write(`[sidecar] ${b}`))
    child.stderr?.on('data', (b: Buffer) => process.stderr.write(`[sidecar] ${b}`))

    let reportChildFailure: (healthy: false) => void = () => {}
    const childFailure = new Promise<false>((resolve) => {
      reportChildFailure = resolve
    })
    const failChild = (detail: string): void => {
      // Exact-handle identity prevents a late event from an old child from
      // clearing a replacement launched by a later start().
      if (this.child !== child) return
      this.child = null
      if (this.abort === startupAbort) this.abort = null
      startupAbort.abort()
      this.onStatus('crashed', detail)
      reportChildFailure(false)
    }
    // A missing/unexecutable binary is reported asynchronously by ChildProcess
    // as `error`; without this listener Node treats it as an uncaught exception
    // and can take down Electron even though the sidecar is optional.
    child.on('error', (err) => failChild(`spawn failed: ${errorDetail(err)}`))
    child.on('exit', (code, sig) =>
      failChild(code !== null ? `exit ${code}` : `signal ${sig ?? 'unknown'}`),
    )

    let healthy: boolean
    try {
      healthy = await Promise.race([
        this.waitForHealth(healthUrl(host, port), { signal: startupAbort.signal }),
        childFailure,
      ])
    } catch (err) {
      if (this.child === child) {
        this.onStatus('unhealthy', `health check failed: ${errorDetail(err)}`)
        this.stop()
      }
      return false
    }
    if (healthy && this.child === child) {
      this.onStatus('ready', healthUrl(host, port))
      return true
    }
    // Health gate timed out (or aborted). A still-alive child is a hung sidecar
    // holding port 8005 — tear it down so the next launch can bind, instead of
    // leaking the port and leaving selection/voice silently dead.
    if (this.child === child) {
      this.onStatus('unhealthy', 'health gate timed out')
      this.stop()
    }
    return false
  }

  /** SIGTERM the child (synchronous-friendly for app quit) and stop polling. */
  stop(): void {
    this.abort?.abort()
    this.abort = null
    const child = this.child
    if (!child) return
    this.child = null
    child.kill('SIGTERM')
    // Force-kill if it ignores SIGTERM, so a lingering child can't keep holding
    // the port and make the next launch fail with "address already in use". The
    // timer intentionally remains referenced: direct/dev launches do not have
    // the managed service cgroup as a second cleanup boundary, so Electron may
    // wait at most this intrinsic TERM grace period rather than orphaning a
    // SIGTERM-ignoring sidecar during process exit.
    const sigkill = setTimeout(() => child.kill('SIGKILL'), 2000)
    child.once('exit', () => clearTimeout(sigkill))
    this.onStatus('stopped')
  }
}

function errorDetail(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

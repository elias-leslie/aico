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

export function healthUrl(host: string, port: number): string {
  return `http://${host}:${port}/health`
}

/**
 * Poll `url` until it answers 200, the timeout elapses, or `signal` aborts.
 * `fetchFn` is injectable so tests drive it without a live server. Resolves
 * true on a healthy response, false on timeout/abort.
 */
export async function waitForHealth(
  url: string,
  opts: {
    timeoutMs?: number
    intervalMs?: number
    signal?: AbortSignal
    fetchFn?: typeof fetch
  } = {},
): Promise<boolean> {
  const { timeoutMs = 10_000, intervalMs = 150, signal, fetchFn = fetch } = opts
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) return false
    try {
      const res = await fetchFn(url, { signal })
      if (res.ok) return true
    } catch {
      // sidecar not up yet (ECONNREFUSED) — keep polling until the deadline
    }
    await new Promise((r) => setTimeout(r, intervalMs))
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
    const { host, port, repoRoot, stateDir, env = process.env } = this.opts
    const python = resolvePython(repoRoot, env)
    this.onStatus('starting', `${python} ${sidecarArgs().join(' ')} :${port}`)

    this.child = this.spawn(python, sidecarArgs(), {
      cwd: repoRoot,
      env: {
        ...env,
        AICO_SIDECAR_HOST: host,
        AICO_SIDECAR_PORT: String(port),
        AICO_STATE_DIR: stateDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    this.child.stdout?.on('data', (b: Buffer) => process.stdout.write(`[sidecar] ${b}`))
    this.child.stderr?.on('data', (b: Buffer) => process.stderr.write(`[sidecar] ${b}`))
    this.child.on('exit', (code, sig) => {
      // An intentional kill (stop(), or the unhealthy teardown below) nulls
      // `this.child` first, so a non-null handle here means an unexpected exit —
      // a crash. Classify by that, not by the exit code: a signal-terminated
      // crash (OOM-kill/SIGSEGV) reports `code === null`, which the old
      // `code !== null` guard silently swallowed.
      const wasRunning = this.child !== null
      this.child = null
      if (wasRunning) this.onStatus('crashed', code !== null ? `exit ${code}` : `signal ${sig}`)
    })

    this.abort = new AbortController()
    const healthy = await this.waitForHealth(healthUrl(host, port), { signal: this.abort.signal })
    if (healthy) {
      this.onStatus('ready', healthUrl(host, port))
      return true
    }
    // Health gate timed out (or aborted). A still-alive child is a hung sidecar
    // holding port 8005 — tear it down so the next launch can bind, instead of
    // leaking the port and leaving selection/voice silently dead.
    if (this.child) {
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
    // timer is unref'd so it never by itself keeps the app alive during quit.
    const sigkill = setTimeout(() => child.kill('SIGKILL'), 2000)
    sigkill.unref?.()
    child.once('exit', () => clearTimeout(sigkill))
    this.onStatus('stopped')
  }
}

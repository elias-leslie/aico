// What the adapters' context checks share: which launcher the managed pane PATH
// resolves a command to.

import { execFile } from 'node:child_process'
import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { effectiveTuiPath } from './launch'
import type { TuiSpec } from './spec'

/** Aico's sign-in launchers on a worker host (scripts/install-worker.sh). Each
 * runs its tool through `tether fleet tool`, so it sits first on the pane PATH
 * and hands over to the absolute executable in its public command map. */
function credShimDir(env: NodeJS.ProcessEnv): string {
  return join(env.HOME ?? homedir(), '.local', 'lib', 'aico', 'auth-bin')
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** The worker installer generates each auth shim from this public command map.
 * The shim execs that absolute target, regardless of other commands on PATH. */
function credentialTarget(shim: string, env: NodeJS.ProcessEnv): string | null {
  const config = env.XDG_CONFIG_HOME || join(env.HOME ?? homedir(), '.config')
  try {
    const entries: unknown = JSON.parse(
      readFileSync(join(config, 'aico', 'tool-commands.json'), 'utf8'),
    )
    if (!Array.isArray(entries)) return null
    let target: string | null = null
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue
      const value = entry as Record<string, unknown>
      if (value.command !== basename(shim)) continue
      target =
        typeof value.executable === 'string' && isAbsolute(value.executable)
          ? value.executable
          : null
    }
    return target && isExecutable(target) ? target : null
  } catch {
    return null
  }
}

function probeLauncher(
  name: string,
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
): Promise<string | null> {
  return new Promise((done) => {
    execFile(
      '/bin/sh',
      ['-c', 'command -v -- "$1"', 'aico-resolve-launcher', name],
      { env, cwd, timeout: 5000 },
      (err, stdout) => {
        if (err) return done(null)
        const found = stdout.trim()
        if (found.includes('/')) {
          const path = resolve(cwd ?? process.cwd(), found)
          return done(isExecutable(path) ? path : null)
        }
        // `env` launches an executable, even when the probe shell has a builtin
        // with the same name (for example printf). Find that external command.
        for (const dir of (env.PATH ?? '').split(':')) {
          const path = resolve(cwd ?? process.cwd(), dir, name)
          if (isExecutable(path)) return done(path)
        }
        done(null)
      },
    )
  })
}

/** Resolve `name` with the exact PATH inherited by the no-profile/no-RC pane.
 * No login shell participates in launch: Aico explicitly writes its service
 * PATH into each tmux session/respawn environment, and a TUI may override it
 * declaratively. The verifier must therefore use that same value rather than a
 * separately sourced profile that could resolve a launcher the pane cannot.
 * A credential shim first on PATH is looked through to the launcher it execs;
 * `shim` names it so the status can say so. */
export async function resolveLauncher(
  name: string,
  spec: TuiSpec,
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<{ path: string; shim: string | null } | null> {
  const base = options.env ?? process.env
  const pathValue = spec.deliveredContext?.env.PATH ?? effectiveTuiPath(spec, base)
  const env = { ...base, ...spec.env, ...spec.deliveredContext?.env, PATH: pathValue }
  const first = await probeLauncher(name, env, options.cwd)
  if (!first) return null
  const shimDir = credShimDir(env)
  const trim = (dir: string): string => dir.replace(/\/+$/, '')
  if (trim(dirname(first)) !== shimDir) return { path: first, shim: null }
  const target = credentialTarget(first, env)
  return target ? { path: target, shim: first } : null
}

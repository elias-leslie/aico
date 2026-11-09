// What the adapters' context checks share: which launcher the managed pane PATH
// resolves a command to.

import { execFile } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { effectiveTuiPath } from './launch'
import type { TuiSpec } from './spec'

/** Aico's sign-in launchers on a worker host (scripts/install-worker.sh). Each
 * runs its tool through `tether fleet tool`, so it sits first on the pane PATH
 * ahead of the real command it hands over to. */
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
  const rest = pathValue
    .split(':')
    .filter((entry) => trim(entry) !== shimDir)
    .join(':')
  const next = await probeLauncher(name, { ...env, PATH: rest }, options.cwd)
  return next ? { path: next, shim: join(shimDir, name) } : null
}

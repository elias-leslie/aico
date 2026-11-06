// What the adapters' context checks share: which launcher the managed pane PATH
// resolves a command to.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { effectiveTuiPath } from './launch'
import type { TuiSpec } from './spec'

/** Aico's sign-in launchers on a worker host (scripts/install-worker.sh). Each
 * runs its tool through `tether fleet tool`, so it sits first on the pane PATH
 * ahead of the real command it hands over to. */
function credShimDir(): string {
  return join(homedir(), '.local', 'lib', 'aico', 'auth-bin')
}

function probeLauncher(name: string, pathValue: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      ['-c', 'command -v -- "$1"', 'aico-resolve-launcher', name],
      { env: { ...process.env, PATH: pathValue }, timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve(null)
        const path = stdout.trim()
        resolve(path.startsWith('/') && existsSync(path) ? path : null)
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
): Promise<{ path: string; shim: string | null } | null> {
  const pathValue = effectiveTuiPath(spec)
  const first = await probeLauncher(name, pathValue)
  if (!first) return null
  const shimDir = credShimDir()
  const trim = (dir: string): string => dir.replace(/\/+$/, '')
  if (trim(dirname(first)) !== shimDir) return { path: first, shim: null }
  const rest = pathValue
    .split(':')
    .filter((entry) => trim(entry) !== shimDir)
    .join(':')
  const next = await probeLauncher(name, rest)
  return next ? { path: next, shim: join(shimDir, name) } : null
}

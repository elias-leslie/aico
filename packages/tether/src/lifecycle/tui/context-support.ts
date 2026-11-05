// What the adapters' context checks share: where the sibling checkouts are and
// which launcher the managed pane PATH resolves a command to.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { effectiveTuiPath } from './launch'
import type { ContextStatus, TuiSpec } from './spec'

/** A sibling checkout (agent-hub, codex-config): `$<override>` when set, else
 * `$TETHER_PROJECTS_DIR/<name>`. With neither set there is no guess (the old
 * `~/projects` default named a folder that need not exist); the caller shows
 * {@link unknownCheckout} instead. */
export function checkout(override: string, name: string): string | null {
  const direct = process.env[override]
  if (direct) return direct
  const projects = process.env.TETHER_PROJECTS_DIR
  return projects ? join(projects, name) : null
}

export function agentHubRepo(): string | null {
  return checkout('AGENT_HUB_REPO', 'agent-hub')
}

export function unknownCheckout(override: string, name: string): ContextStatus {
  return {
    state: 'missing',
    detail: `TETHER_PROJECTS_DIR is not set and neither is ${override}, so the ${name} checkout can't be found; native agent continues`,
  }
}

/** Agent Hub's credential shims on a remote host. Each fetches its tool's
 * credentials, then execs the next same-named command on PATH, so it sits
 * first on the pane PATH ahead of the context launcher it hands over to. */
function credShimDir(): string {
  return join(homedir(), '.local', 'lib', 'agent-hub', 'cred-bin')
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

/** "<shim> execs " when a credential shim stands in front of the launcher. */
function viaShim(shim: string | null): string {
  return shim ? `${shim} (Agent Hub credential shim) execs ` : ''
}

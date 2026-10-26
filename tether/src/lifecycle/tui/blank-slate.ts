// Blank Slate: a session that starts with only the harness's own prompt and
// what the user types. The mode is the workspace: a session whose project root
// is a direct child of the Blank Slate directory launches through
// scripts/aico-blank-slate, which execs the native harness without Agent Hub
// context, instruction files, skills, plugins, MCP servers, memory or
// context-injecting hooks. Keying it on the root keeps it through restarts,
// tool replacement, crash recovery and reboot restore without a catalog field.

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { TuiSpec } from './spec'

/** Tools scripts/aico-blank-slate has an adapter for. Antigravity is absent:
 * its context comes from a user-level plugin no launch flag can skip. */
export const BLANK_SLATE_TOOLS: readonly string[] = ['claude-code', 'codex', 'pi']

export function supportsBlankSlate(slug: string): boolean {
  return BLANK_SLATE_TOOLS.includes(slug)
}

/** Parent of every Blank Slate workspace, beside Aico's Personal Workspace.
 * `st aico create --blank-slate` uses the same path. */
export function blankSlateBase(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME || homedir(), '.local', 'share', 'aico', 'blank-slate')
}

export function isBlankSlateRoot(
  root: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(root) && dirname(root as string) === blankSlateBase(env)
}

/** A new empty workspace for one Blank Slate session. */
export function createBlankSlateWorkspace(env: NodeJS.ProcessEnv = process.env): string {
  const root = join(blankSlateBase(env), randomUUID())
  mkdirSync(root, { recursive: true, mode: 0o700 })
  return root
}

/** Recreate a missing workspace, so a restart never falls back to $HOME. */
export function ensureBlankSlateWorkspace(root: string): void {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 })
  } catch {
    // The launch still uses the Blank Slate launcher; only the cwd differs.
  }
}

/** Installed beside Tether's other scripts (scripts/install-release.sh). */
export function blankSlateLauncher(env: NodeJS.ProcessEnv = process.env): string {
  const lib = env.TETHER_LIB_DIR || join(env.HOME || homedir(), '.local', 'lib', 'tether')
  return join(lib, 'scripts', 'aico-blank-slate')
}

/** The spec to launch in `root`: the Blank Slate launcher in place of the
 * tool's own command when `root` is a Blank Slate workspace. The tool's other
 * argv (permission flags, Pi's --approve) and its resume/model adapters stay. */
export function forWorkspace<T extends TuiSpec | undefined>(
  spec: T,
  root: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): T {
  if (!spec || spec.command.length === 0 || !isBlankSlateRoot(root, env)) return spec
  return {
    ...spec,
    command: [blankSlateLauncher(env), spec.slug, ...spec.command.slice(1)],
    context: { kind: 'blank-slate' },
  }
}

/**
 * The pane cap drop-in Tether owns: every tmux-spawn pane scope gets the
 * owner's MemoryMax and MemorySwapMax (src/memory-policy.ts) the moment tmux
 * starts it, whether Tether launched or resumed it or not. A pane past its cap
 * loses its biggest process to the kernel and keeps running, which needs
 * OOMPolicy=continue (Nightshift's host memory policy sets the user manager's
 * default). Without it a cap would stop the whole pane, so the file is not
 * written. Named 40- so a runtime `systemctl --user set-property --runtime
 * <pane> MemoryMax=20G` still raises one pane for a legitimate big job.
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { MemoryPolicy } from '../memory-policy'

export const PANE_CAP_DROPIN = 'tmux-spawn-.scope.d/40-tether-pane.conf'
/** Nightshift's fallback when the manager default is not continue. */
const OOM_FALLBACK = 'tmux-spawn-.scope.d/45-nightshift-oom.conf'

export function paneCapDropInText(policy: MemoryPolicy): string {
  return [
    '# Tether pane cap (Tether memory policy, edited in A-Term settings). Written by Tether; do not edit.',
    '# A pane past it loses its biggest process to the kernel and keeps running (OOMPolicy=continue).',
    '[Scope]',
    `MemoryMax=${policy.paneMemoryMaxGib}G`,
    `MemorySwapMax=${policy.paneSwapMaxGib}G`,
    '',
  ].join('\n')
}

export interface PaneCapFiles {
  userUnitDir: string
  defaultOomPolicy(): Promise<string | null>
  daemonReload(): Promise<void>
}

const exec = promisify(execFile)

export function systemdPaneCapFiles(env: NodeJS.ProcessEnv, home: string): PaneCapFiles {
  return {
    userUnitDir: join(env.XDG_CONFIG_HOME || join(home, '.config'), 'systemd', 'user'),
    async defaultOomPolicy() {
      try {
        const { stdout } = await exec(
          'systemctl',
          ['--user', 'show', '-p', 'DefaultOOMPolicy', '--value'],
          { timeout: 5_000 },
        )
        return stdout.trim() || null
      } catch {
        return null
      }
    },
    async daemonReload() {
      await exec('systemctl', ['--user', 'daemon-reload'], { timeout: 30_000 })
    },
  }
}

export type PaneCapResult = 'unchanged' | 'written' | 'refused'

/** Write the drop-in when it differs from the policy, then reload the user
 * manager so new and running panes take it. 'refused' when panes would not
 * be on OOMPolicy=continue. */
export async function applyPaneCapDropIn(
  files: PaneCapFiles,
  policy: MemoryPolicy,
): Promise<PaneCapResult> {
  const path = join(files.userUnitDir, PANE_CAP_DROPIN)
  const text = paneCapDropInText(policy)
  let current: string | null = null
  try {
    current = readFileSync(path, 'utf8')
  } catch {
    current = null
  }
  if (current === text) return 'unchanged'
  const continues =
    (await files.defaultOomPolicy()) === 'continue' ||
    existsSync(join(files.userUnitDir, OOM_FALLBACK))
  if (!continues) return 'refused'
  mkdirSync(join(files.userUnitDir, 'tmux-spawn-.scope.d'), { recursive: true })
  writeFileSync(`${path}.tmp`, text, { mode: 0o644 })
  renameSync(`${path}.tmp`, path)
  await files.daemonReload()
  return 'written'
}

// Fresh-machine recovery stays runnable with Python even when Node or Aico is unavailable.
import { fileURLToPath } from 'node:url'
import { machineId, type StatusRow } from '@aico/status'
import { type BackupConfig, homePath } from './backup-plan'
import { type Execute, execute } from './backup-runtime'

export function recoveryArgs(argv: string[], env = process.env): string[] {
  const config = env.AICO_RECOVERY_CONFIG
  return [
    'python3',
    fileURLToPath(new URL('../scripts/recovery.py', import.meta.url)),
    ...(config ? ['--config', homePath(config)] : []),
    ...argv,
  ]
}
export interface DrillReceipt {
  ok: boolean
  started: string
  finished: string
  durationSeconds: number
  scratchDestroyed: boolean
}
export function drillRow(receipt: DrillReceipt, machine: string): StatusRow {
  return {
    id: `${machine}/backup/restore-drill`,
    what: 'Aico monthly restore drill',
    kind: 'backup',
    machine,
    state: receipt.ok && receipt.scratchDestroyed ? 'ok' : 'failed',
    meaning:
      receipt.ok && receipt.scratchDestroyed
        ? `Restored both machines and served matching sessions, notes and Logins on ${receipt.finished.slice(0, 10)} (${receipt.durationSeconds} s). Scratch targets removed.`
        : 'Restore drill failed. Check the recovery receipt; the last good backups are preserved.',
    last_run: receipt.finished,
    actions: [
      { kind: 'detail', ref: '/backups' },
      { kind: 'look', ref: 'aico backups drill' },
    ],
  }
}
export async function recovery(
  argv: string[],
  cfg: BackupConfig,
  env = process.env,
  run: Execute = execute,
): Promise<number> {
  const result = await run(recoveryArgs(argv, env))
  if (result.out) process.stdout.write(result.out)
  if (result.err) process.stderr.write(result.err)
  if (argv[0] === 'drill' && !argv.some((arg) => ['--plan', '--help', '-h'].includes(arg))) {
    // The existing Status alert rule feeds failures to the tray and the app.
    const failed: DrillReceipt = {
      ok: false,
      started: new Date().toISOString(),
      finished: new Date().toISOString(),
      durationSeconds: 0,
      scratchDestroyed: false,
    }
    let receipt = failed
    try {
      const raw: unknown = JSON.parse(result.out)
      if (typeof raw === 'object' && raw !== null) {
        const value = raw as Record<string, unknown>
        if (
          typeof value.ok === 'boolean' &&
          typeof value.scratchDestroyed === 'boolean' &&
          typeof value.started === 'string' &&
          Number.isFinite(Date.parse(value.started)) &&
          typeof value.finished === 'string' &&
          Number.isFinite(Date.parse(value.finished)) &&
          typeof value.durationSeconds === 'number' &&
          Number.isFinite(value.durationSeconds)
        )
          receipt = {
            ok: value.ok && result.code === 0,
            scratchDestroyed: value.scratchDestroyed,
            started: value.started,
            finished: value.finished,
            durationSeconds: value.durationSeconds,
          }
      }
    } catch {
      /* Startup/configuration failures still need a failed Status row. */
    }
    const row = drillRow(receipt, env.AICO_BACKUP_MACHINE || machineId())
    const response = await fetch(new URL('/api/status/rows', env.AICO_WEB_URL || cfg.webUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([row]),
      signal: AbortSignal.timeout(cfg.statusPublish.timeoutMs),
    })
    if (!response.ok)
      throw new Error(`Could not publish restore drill Status (${response.status}).`)
    if (!receipt.ok) return result.code || 1
  }
  return result.code
}

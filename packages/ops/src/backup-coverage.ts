// Coverage is a read across repositories, separate from each controller's active jobs and Status rows.
import { join } from 'node:path'
import { requestExec } from '@aico/fleet/exec'
import { linkPaths } from '@aico/fleet/link'
import { readSettings } from '@aico/fleet/settings'
import { readPins } from '@aico/fleet/trust'
import syncConfig from '../data/context-sync.json' with { type: 'json' }
import {
  type BackupConfig,
  type BackupEntry,
  type BackupState,
  copyKey,
  driveSourceOwner,
  driveSources,
  driveTarget,
  entries,
  entry,
  migrated,
} from './backup-plan'

interface OwnerRepository {
  machine: string
  repository: string
  sources: string[]
}
export type BackupCoverageOwner = OwnerRepository &
  (
    | { state: 'unknown' }
    | {
        state: 'read'
        entries: BackupEntry[]
        retained: BackupEntry[]
        runs: BackupState['runs']
      }
  )
export type ReadBackupOwner = Extract<BackupCoverageOwner, { state: 'read' }>

function ownerRepository(cfg: BackupConfig, machine: string): OwnerRepository {
  return {
    machine,
    repository:
      cfg.driveClients[machine as keyof typeof cfg.driveClients]?.repository ??
      driveTarget().repository,
    sources: [...driveSources(cfg, machine).map((source) => source.id), `aico-${machine}`],
  }
}

/** Old verified receipts stay in their original repository; never import them into the new owner's state. */
export function localBackupCoverage(
  state: BackupState,
  cfg: BackupConfig,
  machine: string,
  now = Date.now(),
): ReadBackupOwner {
  // Saved power observations are not evidence that a guest is still off. This read avoids
  // live jobs/SSH probes, so it evaluates copy dates and keeps current power unverified.
  const observed = {
    ...state,
    copies: Object.fromEntries(
      Object.entries(state.copies).map(([key, copy]) => [
        key,
        copy.target === 'drive' && copy.observed === 'offline'
          ? { ...copy, observed: undefined }
          : copy,
      ]),
    ),
  }
  const items = entries(observed, cfg, machine, now).filter((item) => item.target === 'drive')
  const retained: BackupEntry[] = []
  for (const source of migrated.sources) {
    if (driveSourceOwner(cfg, source.id) === machine) continue
    const copy = observed.copies[copyKey(source.id, 'drive')]
    if (!copy?.snapshot || !copy.dataAt) continue
    // An old controller's last attempt does not invalidate its last verified artifact.
    retained.push(
      entry(source.id, source.name, 'drive', { ...copy, error: undefined }, cfg, machine, now),
    )
  }
  for (const item of [...items, ...retained])
    if (state.copies[copyKey(item.source, 'drive')]?.observed === 'offline')
      item.meaning = 'The last copy date is shown. The source’s current power has not been checked.'
  return {
    ...ownerRepository(cfg, machine),
    state: 'read',
    entries: items,
    retained,
    runs: state.runs,
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Validate only the fields used by the coverage reader; the peer's own listing computes copy health. */
function readOwner(value: unknown, expected: OwnerRepository): ReadBackupOwner | null {
  if (!record(value) || !Array.isArray(value.owners) || value.owners.length !== 1) return null
  const owner: unknown = value.owners[0]
  if (
    !record(owner) ||
    owner.state !== 'read' ||
    owner.machine !== expected.machine ||
    owner.repository !== expected.repository ||
    !Array.isArray(owner.entries) ||
    !Array.isArray(owner.retained) ||
    !record(owner.runs)
  )
    return null
  for (const item of [...owner.entries, ...owner.retained])
    if (
      !record(item) ||
      item.machine !== expected.machine ||
      item.target !== 'drive' ||
      typeof item.id !== 'string' ||
      typeof item.source !== 'string' ||
      !['ok', 'off', 'warn', 'failed'].includes(String(item.state)) ||
      (item.dataAt !== null && typeof item.dataAt !== 'string') ||
      (item.snapshot !== null && typeof item.snapshot !== 'string')
    )
      return null
  return { ...owner, ...expected } as ReadBackupOwner
}

/** Query only configured backup owners through the existing pinned fleet exec channel. */
export async function fleetBackupCoverage(
  local: ReadBackupOwner,
  cfg: BackupConfig,
  env = process.env,
): Promise<{ owners: BackupCoverageOwner[] }> {
  const seconds = cfg.coverageReadSeconds
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error('The backup coverage read budget must be a positive number of seconds.')
  let settings: ReturnType<typeof readSettings> = null
  let trusted: string[] = []
  try {
    settings = readSettings(env, '')
    if (settings)
      trusted = readPins(settings.allowlist)
        .filter((pin) => pin.role === 'full')
        .map((pin) => pin.name)
  } catch {
    // Missing configuration or trust is an unread owner, never an empty successful view.
  }
  const machines = [...new Set([cfg.workstation, ...Object.keys(cfg.driveClients)])]
  const owners = await Promise.all(
    machines.map(async (machine): Promise<BackupCoverageOwner> => {
      const expected = ownerRepository(cfg, machine)
      if (machine === local.machine) return local
      if (!settings?.peers.some((peer) => peer.name === machine) || !trusted.includes(machine))
        return { ...expected, state: 'unknown' }
      const socket = linkPaths(join(settings.peerRoot, machine)).control
      const answer = await requestExec(
        socket,
        // The same owning budget bounds this socket and a manager-owned remote read service.
        // It leaves room for CLI startup inside host-steward's existing five-second outer read.
        [
          'systemd-run',
          '--user',
          '--no-ask-password',
          '--quiet',
          '--wait',
          '--collect',
          '--pipe',
          '--service-type=exec',
          `--property=RuntimeMaxSec=${seconds}s`,
          '--property=KillMode=control-group',
          'sh',
          '-c',
          `cd "$HOME" && exec ${syncConfig.peerAico} backups list --fleet --local --json`,
        ],
        Buffer.alloc(0),
        AbortSignal.timeout(Math.ceil(seconds * 1000)),
      )
      if (answer.ended && answer.code === 0)
        try {
          const owner = readOwner(JSON.parse(answer.stdout), expected)
          if (owner) return owner
        } catch {}
      return { ...expected, state: 'unknown' }
    }),
  )
  return { owners }
}

// What the deploy's parts share: its refusal, the config and machine seams, and the small rules about
// sources and releases. Nothing here runs a deploy.

import { join } from 'node:path'
import type { StatusRow } from '@aico/status'
import ops from '../data/ops.json' with { type: 'json' }
import type { Runner } from './sh'

export class Refusal extends Error {
  constructor(
    message: string,
    readonly code = 1,
    /** An explicit hold, lock or acceptance refusal: nothing changed, the old release serves. */
    readonly unchanged = false,
  ) {
    super(message)
  }
}

export type DeployConfig = typeof ops.deploy

export interface DeployDeps {
  run: Runner
  out: (line: string) => void
  err: (line: string) => void
  env: NodeJS.ProcessEnv
  releasesDir: string
  jobsDir: string
  systemdDir: string
  /** HTTP GET status of a loopback URL, or 0 when nothing answered. */
  probe: (url: string) => Promise<number>
  sleep: (ms: number) => Promise<void>
  /** Posts the deploy's Status row (best effort). */
  report: (row: StatusRow, port: number) => Promise<void>
  /** The bundle a detached job re-runs. */
  self: string
  /** The link to the release whose ops bundle `aico deploy` runs (data/ops.json deploy.installedOps). */
  opsLink: string
  /** The paths live processes run from (cwd, exe, command line), so prune keeps their release. */
  processPaths: () => string[]
}

export const touches = (paths: string[], sources: string[]) =>
  paths.some((path) => sources.some((source) => path === source || path.startsWith(`${source}/`)))

/** The release commit a rendered unit file runs, when it runs one of ours. */
export function runningSha(unitText: string | null, releasesDir: string): string | null {
  if (!unitText) return null
  const dir = /^WorkingDirectory=(\S+)/m.exec(unitText)?.[1]
  if (!dir?.startsWith(`${releasesDir}/`)) return null
  const sha = dir.slice(releasesDir.length + 1).split('/')[0] ?? ''
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null
}

export const opsBundle = (release: string) => join(release, 'packages/ops/dist/aico-ops.mjs')

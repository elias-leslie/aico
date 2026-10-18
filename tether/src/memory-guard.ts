/**
 * Tether's agent-pane memory policy at runtime: the stored policy, the pane
 * cap drop-in and the runaway agent-job guard (src/lifecycle/job-guard.ts).
 * The default instance runs it; other instances only serve the policy API.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TetherPaths } from './config'
import { nightshiftAdmissionPath } from './lifecycle/agent-admission'
import { JobGuard, memoryEventsPath } from './lifecycle/job-guard'
import {
  applyPaneCapDropIn,
  type PaneCapFiles,
  type PaneCapResult,
  systemdPaneCapFiles,
} from './lifecycle/pane-caps'
import { applyMemoryPolicyPatch, type MemoryPolicy, parseStoredMemoryPolicy } from './memory-policy'
import type { Store } from './store'

export const MEMORY_POLICY_KEY = 'memory_policy'

export interface MemoryGuardStatus {
  running: boolean
  hostState: string | null
  lastKillAt: number | null
  paneCapFile: PaneCapResult | 'not-applied' | 'error'
}

export class MemoryPolicyService {
  private guard: JobGuard | null = null
  private capFile: MemoryGuardStatus['paneCapFile'] = 'not-applied'

  constructor(
    private readonly store: Store,
    private readonly files: PaneCapFiles | null,
    private readonly log: (message: string) => void = (m) =>
      console.log(`[tether:memory-guard] ${m}`),
  ) {}

  get(): MemoryPolicy {
    return parseStoredMemoryPolicy(this.store.getSetting(MEMORY_POLICY_KEY))
  }

  /** Validate and store a partial update, then apply it (MemoryPolicyError on a bad field). */
  async update(patch: Record<string, unknown>, now: number): Promise<MemoryPolicy> {
    const previous = this.get()
    const next = applyMemoryPolicyPatch(previous, patch)
    this.store.putSetting(MEMORY_POLICY_KEY, JSON.stringify(next), now)
    if (
      previous.paneMemoryMaxGib !== next.paneMemoryMaxGib ||
      previous.paneSwapMaxGib !== next.paneSwapMaxGib
    ) {
      this.guard?.capChanged(previous)
      await this.applyCaps(next)
    }
    return next
  }

  async applyCaps(policy: MemoryPolicy = this.get()): Promise<void> {
    if (!this.files) return
    try {
      this.capFile = await applyPaneCapDropIn(this.files, policy)
      if (this.capFile === 'refused')
        this.log(
          'pane cap not written: panes are not on OOMPolicy=continue, a cap would stop a whole pane',
        )
    } catch (error) {
      this.capFile = 'error'
      this.log(`could not write the pane cap: ${(error as Error).message}`)
    }
  }

  startGuard(guard: JobGuard): void {
    this.guard = guard
    guard.start()
    void this.applyCaps()
  }

  stop(): void {
    this.guard?.stop()
  }

  status(): MemoryGuardStatus {
    return {
      running: this.guard !== null,
      hostState: this.guard?.state ?? null,
      lastKillAt:
        this.guard && Number.isFinite(this.guard.lastKill)
          ? Math.floor(this.guard.lastKill / 1000)
          : null,
      paneCapFile: this.capFile,
    }
  }
}

/** The guard runs on the default instance only, unless TETHER_MEMORY_GUARD=off. */
export function memoryGuardEnabled(paths: TetherPaths, env: NodeJS.ProcessEnv): boolean {
  return paths.legacy && env.TETHER_MEMORY_GUARD !== 'off' && env.TETHER_RECONCILE !== 'off'
}

export function startMemoryGuard(
  paths: TetherPaths,
  store: Store,
  env: NodeJS.ProcessEnv,
  hooks: { foreground: () => string | null; sessionOf: () => Map<string, string> },
): MemoryPolicyService {
  const home = env.HOME ?? homedir()
  if (!memoryGuardEnabled(paths, env)) return new MemoryPolicyService(store, null)
  const service = new MemoryPolicyService(store, systemdPaneCapFiles(env, home))
  const guard = new JobGuard({
    uid: process.getuid?.() ?? -1,
    admissionPath: nightshiftAdmissionPath(env),
    eventsPath: memoryEventsPath(env, home),
    heartbeatPath: join(paths.runtimeDir, 'memory-guard.json'),
    policy: () => service.get(),
    foreground: hooks.foreground,
    sessionOf: hooks.sessionOf,
  })
  service.startGuard(guard)
  return service
}

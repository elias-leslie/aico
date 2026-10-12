/**
 * Foreground pane memory protection.
 *
 * The pane the owner is looking at gets MemoryLow=2G so reclaim takes from
 * background panes first. Exactly one pane holds it: a focus change moves it,
 * and the first move after a daemon start clears any pane a previous daemon
 * left protected. Runtime-only properties vanish with the scope, so nothing
 * persists across reboots. Failures are logged and never block a focus.
 */

import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { isOwnedPaneScope } from './ownership'

export const FOREGROUND_MEMORY_LOW = '2G'

export interface PaneMemoryHost {
  setMemoryLow(unit: string, value: string): Promise<void>
  /** Owned pane scopes whose memory.low is currently above zero. */
  protectedScopes(): Promise<string[]>
}

export class ForegroundPaneMemory {
  private current: string | null = null
  private swept = false
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly host: PaneMemoryHost,
    private readonly log: (message: string) => void = console.warn,
  ) {}

  /** Give `unit` the foreground protection and take it from every other pane. */
  focus(unit: string | null): Promise<void> {
    const next = this.tail.then(() => this.move(unit))
    this.tail = next.catch(() => {})
    return next
  }

  get foreground(): string | null {
    return this.current
  }

  private async move(unit: string | null): Promise<void> {
    if (!isOwnedPaneScope(unit) || unit === this.current) return
    try {
      await this.host.setMemoryLow(unit, FOREGROUND_MEMORY_LOW)
    } catch (error) {
      this.log(`[tether:memory] could not protect ${unit}: ${(error as Error).message}`)
      return
    }
    const previous = new Set<string>(this.current ? [this.current] : [])
    if (!this.swept) {
      this.swept = true
      try {
        for (const scope of await this.host.protectedScopes()) previous.add(scope)
      } catch (error) {
        this.log(`[tether:memory] could not list protected panes: ${(error as Error).message}`)
      }
    }
    previous.delete(unit)
    this.current = unit
    for (const scope of previous) {
      // A scope that already ended has nothing left to release.
      await this.host.setMemoryLow(scope, '0').catch(() => {})
    }
  }
}

const exec = promisify(execFile)

/** `owned` limits the sweep to this instance's panes, so a test instance
 * never strips the default instance's foreground pane. */
export function systemdPaneMemoryHost(
  appSliceDir: string,
  owned: () => Set<string>,
): PaneMemoryHost {
  return {
    async setMemoryLow(unit, value) {
      await exec('systemctl', ['--user', 'set-property', '--runtime', unit, `MemoryLow=${value}`], {
        timeout: 5_000,
      })
    },
    async protectedScopes() {
      const scopes: string[] = []
      const mine = owned()
      for (const entry of await readdir(appSliceDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !isOwnedPaneScope(entry.name) || !mine.has(entry.name)) continue
        const low = await readFile(`${appSliceDir}/${entry.name}/memory.low`, 'utf8').catch(
          () => '0',
        )
        if (low.trim() !== '0') scopes.push(entry.name)
      }
      return scopes
    },
  }
}

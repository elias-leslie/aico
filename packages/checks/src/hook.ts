// What the coordination store (aico-hook, the same leases and writer sets the edit hook keeps)
// says about paths: who else wrote or leases them, whether a hold or deploy refuses an operation,
// and dropping the caller's leases once a commit settled its paths.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Coordination {
  /** Path -> other agents that wrote it (`unknown` when not told apart) or lease it (`lease:<agent>`),
   * less those whose yes to request withAck hands their work over. */
  foreign(root: string, paths: string[], withAck?: string): Record<string, string[]>
  /** The holder line refusing op, or null when nothing does. Throws when the store does not answer. */
  guard(root: string, op: 'commit' | 'acceptance', withAck?: string): string | null
  /** Drops the caller's leases on these committed paths and their writer sets; the hook's message. */
  committed(root: string, paths: string[]): string
}

export class CoordinationError extends Error {}

function hookBinary(env: NodeJS.ProcessEnv): string {
  if (env.AICO_HOOK_BIN) return env.AICO_HOOK_BIN
  for (const dir of (env.PATH ?? '').split(':'))
    if (dir && existsSync(join(dir, 'aico-hook'))) return join(dir, 'aico-hook')
  return join(homedir(), '.local/bin/aico-hook')
}

/** The live store through the installed aico-hook. */
export function hookCoordination(env: NodeJS.ProcessEnv = process.env): Coordination {
  const run = (root: string, args: string[]) => {
    const result = spawnSync(hookBinary(env), ['lease', ...args], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    })
    return {
      code: result.status,
      out: result.stdout?.trim() ?? '',
      err: (result.stderr?.trim() || result.error?.message) ?? '',
    }
  }
  // Long path lists go in chunks so one call never exceeds the argument limit.
  const chunks = (paths: string[]) =>
    Array.from({ length: Math.ceil(paths.length / 500) }, (_, i) =>
      paths.slice(i * 500, i * 500 + 500),
    )
  return {
    foreign(root, paths, withAck) {
      const out: Record<string, string[]> = {}
      for (const chunk of chunks(paths)) {
        const result = run(root, [
          '--foreign',
          ...chunk,
          ...(withAck ? ['--with-ack', withAck] : []),
        ])
        if (result.code !== 0)
          throw new CoordinationError(`the lease store did not answer: ${result.err || result.out}`)
        Object.assign(out, JSON.parse(result.out || '{}'))
      }
      return out
    },
    guard(root, op, withAck) {
      const result = run(root, ['--guard', op, ...(withAck ? ['--with-ack', withAck] : [])])
      if (result.code === 0) return null
      if (result.code === 1 && result.out) return result.out
      throw new CoordinationError(
        `${op} refused: other agents' holds are unknown (${result.err || result.out || `exit ${result.code}`})`,
      )
    },
    committed(root, paths) {
      let released = 0
      for (const chunk of chunks(paths)) {
        const result = run(root, ['--committed', ...chunk])
        if (result.code !== 0) return `Leases not released: ${result.err || result.out}`
        released += Number(/Released (\d+)/.exec(result.out)?.[1] ?? 0)
      }
      return `Released ${released} lease(s).`
    },
  }
}

/** Another agent's claim on a path: a named writer or a live lease (`unknown` writers do not count). */
export const othersClaim = (ids: string[] = []) => ids.some((id) => id !== 'unknown')

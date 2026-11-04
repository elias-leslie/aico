// Read-only access to Agent Hub for the import: its Postgres through
// `st db query` (run in its checkout, which holds the connection) and files of
// the checkout. Large answers arrive in a details file, read and then removed
// (also when the query failed); nothing from a row is ever printed.

import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import settings from '../data/agent-hub-import.json' with { type: 'json' }
import type { AgentHubSource } from './import'

const TIMEOUTS = settings.timeouts_seconds

/** Why a finished `st` child did not succeed, or null when it did. */
function failure(
  child: ReturnType<typeof spawnSync>,
  what: string,
  seconds: number,
): string | null {
  const error = child.error as NodeJS.ErrnoException | undefined
  if (error?.code === 'ETIMEDOUT' || child.signal === 'SIGTERM')
    return `${what} did not answer within ${seconds}s`
  if (error) return `${what} could not run: ${error.message}`
  if (child.status !== 0)
    return `${what} failed (exit ${child.status}): ${String(child.stderr).split('\n')[0] ?? ''}`
  return null
}

export function agentHubSource(checkout: string): AgentHubSource {
  return {
    rows(sql) {
      const child = spawnSync('st', ['db', 'query', '--plain', sql.replace(/\s+/g, ' ')], {
        cwd: checkout,
        encoding: 'utf8',
        maxBuffer: 512 * 1024 * 1024,
        timeout: TIMEOUTS.query * 1000,
      })
      const out = child.stdout ?? ''
      const head = out.startsWith('DB:') ? (out.split('\n')[0] as string) : null
      const details = head ? /\|details:([^|]+)/.exec(head)?.[1]?.trim() : undefined
      const path = details ? resolve(checkout, details) : null
      try {
        const failed = failure(child, 'st db query', TIMEOUTS.query)
        if (failed) throw new Error(failed)
        if (head === null) return out.split('\n').filter((line) => line.length > 0)
        // A summary line instead of rows: never show its hint, which quotes row text.
        if (!head.startsWith('DB:OK'))
          throw new Error(`st db query: ${head.split('|hint:')[0] ?? 'failed'}`)
        if (!path) return []
        return readFileSync(path, 'utf8')
          .split('\n')
          .filter((line) => line.length > 0)
      } finally {
        if (path) rmSync(path, { force: true })
      }
    },
    file(path) {
      return readFileSync(join(checkout, path), 'utf8')
    },
  }
}

/**
 * Agent Hub's launch-defaults answer with usage facts for a role
 * (`st models route --role R [--project P] --json`), the usage source until Aico
 * collects it (M8), or why there is none.
 */
export function agentHubRoute(
  role: string,
  project?: string,
): { payload: unknown } | { error: string } {
  const argv = [
    'models',
    'route',
    '--role',
    role,
    ...(project ? ['--project', project] : []),
    '--json',
  ]
  const child = spawnSync('st', argv, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: TIMEOUTS.route * 1000,
  })
  const failed = failure(child, 'Agent Hub usage facts', TIMEOUTS.route)
  if (failed) return { error: failed }
  try {
    return { payload: JSON.parse(child.stdout) }
  } catch {
    return { error: 'Agent Hub usage facts were not JSON' }
  }
}

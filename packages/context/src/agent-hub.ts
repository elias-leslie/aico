// Read-only access to Agent Hub for the import: its Postgres through
// `st db query` (run in its checkout, which holds the connection) and files of
// the checkout. Large answers arrive in a details file, read and then removed;
// nothing from a row is ever printed.

import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AgentHubSource } from './import'

export function agentHubSource(checkout: string): AgentHubSource {
  return {
    rows(sql) {
      const child = spawnSync('st', ['db', 'query', '--plain', sql.replace(/\s+/g, ' ')], {
        cwd: checkout,
        encoding: 'utf8',
        maxBuffer: 512 * 1024 * 1024,
      })
      if (child.error) throw new Error(`st db query could not run: ${child.error.message}`)
      if (child.status !== 0)
        throw new Error(
          `st db query failed (exit ${child.status}): ${child.stderr.split('\n')[0] ?? ''}`,
        )
      const out = child.stdout
      if (!out.startsWith('DB:')) return out.split('\n').filter((line) => line.length > 0)
      // A summary line instead of rows: never show its hint, which quotes row text.
      const head = out.split('\n')[0] as string
      if (!head.startsWith('DB:OK'))
        throw new Error(`st db query: ${head.split('|hint:')[0] ?? 'failed'}`)
      const details = /\|details:([^|]+)/.exec(head)?.[1]?.trim()
      if (!details) return []
      const path = resolve(checkout, details)
      try {
        return readFileSync(path, 'utf8')
          .split('\n')
          .filter((line) => line.length > 0)
      } finally {
        rmSync(path, { force: true })
      }
    },
    file(path) {
      return readFileSync(join(checkout, path), 'utf8')
    },
  }
}

/**
 * Agent Hub's launch-defaults answer with usage facts for a role
 * (`st models route --role R [--project P] --json`), the usage source until Aico collects it
 * (M8); null when Agent Hub does not answer.
 */
export function agentHubRoute(role: string, project?: string): unknown | null {
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
  })
  if (child.error || child.status !== 0) return null
  try {
    return JSON.parse(child.stdout)
  } catch {
    return null
  }
}

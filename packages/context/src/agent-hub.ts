// Agent Hub owns the bounded export and authentication. Rows stay opaque here and never enter logs.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import settings from '../data/agent-hub-import.json' with { type: 'json' }
import type { AgentHubSource } from './import'

export function agentHubSource(checkout: string): AgentHubSource {
  return {
    rows(dataset, agentRoles = []) {
      const rows: string[] = []
      let offset = 0
      for (;;) {
        const child = spawnSync(
          'st',
          [
            'agents',
            'context-export',
            dataset,
            '--offset',
            String(offset),
            '--limit',
            String(settings.page_rows),
            ...agentRoles.flatMap((role) => ['--agent-role', role]),
          ],
          {
            cwd: checkout,
            encoding: 'utf8',
            maxBuffer: 512 * 1024 * 1024,
            timeout: settings.timeouts_seconds.query * 1000,
          },
        )
        if (
          (child.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ||
          child.signal === 'SIGTERM'
        )
          throw new Error(
            `Agent Hub context export did not answer within ${settings.timeouts_seconds.query}s`,
          )
        if (child.error) throw new Error('Agent Hub context export could not run')
        if (child.status !== 0)
          throw new Error(`Agent Hub context export failed (exit ${child.status})`)
        let page: { rows: string[]; next_offset: number | null }
        try {
          page = JSON.parse(child.stdout)
          if (
            !page ||
            !Array.isArray(page.rows) ||
            page.rows.some((row) => typeof row !== 'string') ||
            (page.next_offset !== null &&
              (!Number.isSafeInteger(page.next_offset) || page.next_offset <= offset))
          )
            throw new Error('invalid page')
        } catch {
          throw new Error('Invalid Agent Hub context export response')
        }
        rows.push(...page.rows)
        if (page.next_offset === null) return rows
        offset = page.next_offset
      }
    },
    file(path) {
      return readFileSync(join(checkout, path), 'utf8')
    },
  }
}

// The repo's last check result as one Status row (`check:<project>`): green on a pass, amber for a
// failed quick or working-tree check (work in progress), red for a failed acceptance (which alerts
// the phone). Posting is best effort: a check never fails because aico-web is down.

import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { machineId, postStatusRows, type StatusRow } from '@aico/status'
import { registryProjects } from '@aico/tasks'
import type { StepResult } from './run'

export interface CheckSummary {
  lane: 'quick' | 'full' | 'acceptance'
  passed: boolean
  results: StepResult[]
  ms: number
  /** The accepted commit (acceptance only). */
  sha?: string
}

/** The registry project that holds root, else the inherited id, else the directory name. */
export function projectId(root: string, env: NodeJS.ProcessEnv = process.env): string {
  try {
    const hit = registryProjects(env)
      .filter((project) => root === project.root || root.startsWith(`${project.root}/`))
      .sort((a, b) => b.root.length - a.root.length)[0]
    if (hit) return hit.id
  } catch {}
  // Outside every registered project the inherited id stands in.
  return env.ST_PROJECT_ID?.trim() || basename(root).toLowerCase()
}

export function checkRow(project: string, summary: CheckSummary, now = new Date()): StatusRow {
  const failed = summary.results.filter(
    (result) => result.required && result.state !== 'pass' && result.state !== 'skip',
  )
  const ran = summary.results.filter((result) => result.state !== 'skip').length
  const what = { quick: 'Quick check', full: 'Check', acceptance: 'Acceptance' }[summary.lane]
  const seconds = `${(summary.ms / 1000).toFixed(0)} s`
  const meaning = summary.passed
    ? `${what} passed: ${ran} stages in ${seconds}${summary.sha ? ` at ${summary.sha.slice(0, 10)}` : ''}`
    : `${what} failed: ${failed.map((result) => result.id).join(', ')}`
  return {
    id: `check:${project}`,
    what: `${project} checks`,
    kind: 'check',
    machine: machineId(),
    project,
    state: summary.passed ? 'ok' : summary.lane === 'acceptance' ? 'failed' : 'warn',
    meaning: meaning.slice(0, 300),
    last_run: now.toISOString(),
  }
}

/** aico-web's base URL: AICO_WEB_URL, else loopback on AICO_WEB_PORT or the identity file's backend port. */
export function webUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.AICO_WEB_URL?.trim()) return env.AICO_WEB_URL.trim()
  let port = Number(env.AICO_WEB_PORT)
  if (!port) {
    let dir = dirname(fileURLToPath(import.meta.url))
    for (;;) {
      const file = join(dir, 'project.identity.json')
      if (existsSync(file)) {
        try {
          port = Number(JSON.parse(readFileSync(file, 'utf8')).runtime?.backend_port)
        } catch {}
        break
      }
      if (dirname(dir) === dir) break
      dir = resolve(dir, '..')
    }
  }
  return port ? `http://127.0.0.1:${port}` : null
}

export async function postCheckRow(
  root: string,
  summary: CheckSummary,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const base = webUrl(env)
  if (!base || env.AICO_CHECK_STATUS === '0') return null
  try {
    const res = await postStatusRows(base, [checkRow(projectId(root, env), summary)], {
      timeoutMs: 3_000,
    })
    return res.ok ? null : `Status row not recorded: aico-web answered ${res.status}`
  } catch (error) {
    return `Status row not recorded: ${(error as Error).message}`
  }
}

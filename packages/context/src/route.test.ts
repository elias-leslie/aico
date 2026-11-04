// route() against `st models route --role R [--project P] --json` answers (policy v5)
// captured 2026-11-03, and formatOptions against `st models route` text for the same
// answer (rendered by st-cli's own formatter, New York time).

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatLaunch, formatOptions } from './format'
import type { LaunchPolicy } from './launch'
import { Catalog } from './models'
import { factsFromAgentHub, type RoutePayload, route, UnknownLaunchKey } from './route'

process.env.TZ = 'America/New_York'

const DIR = join(import.meta.dirname, 'fixtures')
const policy = JSON.parse(readFileSync(join(DIR, 'policy.json'), 'utf8')) as LaunchPolicy
const catalog = new Catalog()
const cases = readdirSync(join(DIR, 'route'))
  .filter((name) => name.endsWith('.json'))
  .map((name) => name.slice(0, -5))

describe('route', () => {
  it.each(cases)('%s matches Agent Hub field for field', (name) => {
    const expected = JSON.parse(
      readFileSync(join(DIR, 'route', `${name}.json`), 'utf8'),
    ) as RoutePayload
    const [role, project] = name.split('@') as [string, string | undefined]
    const payload = route(
      policy,
      catalog,
      { role, ...(project && { project }) },
      factsFromAgentHub(expected),
      expected.facts_as_of,
    )
    expect(payload).toEqual(expected)
    const text = readFileSync(join(DIR, 'route', `${name}.txt`), 'utf8').trimEnd()
    expect(formatOptions(payload, role, project)).toBe(text)
  })

  it('refuses a denied provider and says why', () => {
    const payload = route(policy, catalog, {
      role: 'verification',
      project: 'neri-hunters',
      tool: 'claude-code',
    })
    expect(payload.rows).toHaveLength(1)
    expect(payload.rows[0]?.allowed).toBe(false)
    expect(formatLaunch(payload)).toContain('DENIED:')
    const checked = route(policy, catalog, { role: 'recon', tool: 'claude-code', model: 'opus' })
    expect(checked.rows[0]?.allowed).toBe(false)
  })

  it('names the choices for an unknown role or tool, and says when facts are missing', () => {
    expect(() => route(policy, catalog, { role: 'nope' })).toThrow(UnknownLaunchKey)
    expect(() => route(policy, catalog, { tool: 'nope' })).toThrow(/claude-code/)
    const bare = route(policy, catalog, { role: 'implementation' })
    expect(bare.facts_as_of).toBeUndefined()
    expect(formatOptions(bare, 'implementation')).toContain('usage facts unavailable')
  })
})

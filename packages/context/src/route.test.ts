// route() against `st models route --role R [--project P] [--model M] --json` answers (policy v5)
// captured 2026-11-03 (named role[@project][~model]), and formatOptions against `st models route` text for the same
// answer (rendered by st-cli's own formatter, New York time).

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { formatLaunch, formatOptions } from './format'
import type { LaunchPolicy } from './launch'
import { Catalog } from './models'
import {
  type Credit,
  type Facts,
  type Reading,
  type Refusal,
  type RoutePayload,
  route,
  UnknownLaunchKey,
  type Usage,
} from './route'

process.env.TZ = 'America/New_York'

const micros = (iso: string) => {
  const match = /\.(\d+)/.exec(iso)
  const fraction = match ? Number((match[1] as string).padEnd(6, '0').slice(0, 6)) : 0
  return Date.parse(iso.replace(/\.\d+/, '')) * 1000 + fraction
}

/**
 * Usage facts from an Agent Hub launch-defaults answer (`st models route --json`):
 * how the fixtures (captured from Agent Hub) become facts. Window states are kept by
 * giving passed readings a past reset; refusals keep each model's newest one and count.
 */
export function factsFromAgentHub(payload: { rows?: unknown }): Facts {
  const readings = new Map<string, Reading>()
  const credits: Record<string, Credit> = {}
  const refusals = new Map<string, Refusal>()
  const rows = Array.isArray(payload.rows) ? (payload.rows as Record<string, unknown>[]) : []
  const addRefusal = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    const refusal = value as Refusal
    refusals.set(`${refusal.requested_model}\n${refusal.at}`, { ...refusal })
  }
  for (const row of rows) {
    const usage = row.usage as Usage | undefined
    if (usage?.provider) {
      for (const window of usage.windows) {
        const passed = window.state === 'unknown' || window.state === 'not_reported'
        readings.set(`${usage.provider}\n${window.window_minutes}`, {
          provider: usage.provider,
          window_minutes: window.window_minutes,
          observed_at: window.observed_at,
          used_percent: window.used_percent ?? 0,
          resets_at: passed ? window.observed_at : window.resets_at,
          source: window.source,
        })
      }
      if (usage.credits)
        credits[usage.provider] = {
          balance: usage.credits.balance,
          pace_per_day_7d: usage.credits.pace_per_day_7d,
          earliest_expiry: usage.credits.earliest_expiry,
        }
    }
    addRefusal(row.last_refusal)
    for (const alt of (row.alternates as Record<string, unknown>[] | undefined) ?? [])
      addRefusal(alt.last_refusal)
  }
  return {
    readings: [...readings.values()],
    credits,
    refusals: [...refusals.values()].sort((a, b) => micros(b.at) - micros(a.at)),
  }
}

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
    const [where, model] = name.split('~') as [string, string | undefined]
    const [role, project] = where.split('@') as [string, string | undefined]
    const payload = route(
      policy,
      catalog,
      { role, ...(project && { project }), ...(model && { model }) },
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

  it.each(['hunting', 'recon'])(
    'refuses a model it does not know on %s, whatever the tool',
    (role) => {
      const payload = route(policy, catalog, { role, model: 'mystery-model-9' })
      expect(payload.rows.map((row) => row.allowed)).toEqual(payload.rows.map(() => false))
      for (const row of payload.rows.filter((row) => row.tool !== 'claude-code'))
        expect(row.deny_reason).toMatch(/^Unknown model 'mystery-model-9'/)
      // No deny row covers implementation, so there is nothing to refuse.
      const free = route(policy, catalog, { role: 'implementation', model: 'mystery-model-9' })
      expect(free.rows.every((row) => row.allowed)).toBe(true)
    },
  )

  it('names the choices for an unknown role or tool, and says when facts are missing', () => {
    expect(() => route(policy, catalog, { role: 'nope' })).toThrow(UnknownLaunchKey)
    expect(() => route(policy, catalog, { tool: 'nope' })).toThrow(/claude-code/)
    const bare = route(policy, catalog, { role: 'implementation' })
    expect(bare.facts_as_of).toBeUndefined()
    expect(formatOptions(bare, 'implementation')).toContain('usage facts unavailable')
    bare.facts_error = 'Agent Hub usage facts did not answer within 20s'
    expect(formatOptions(bare, 'implementation')).toContain(
      '  usage facts unavailable (Agent Hub usage facts did not answer within 20s); allowed and denied are still right',
    )
  })

  it('says when the facts were collected, and reads stale or failed providers as unknown', () => {
    const now = '2026-11-04T12:00:00.000Z'
    const reading = {
      provider: 'codex',
      window_minutes: 10080,
      observed_at: '2026-10-30T12:00:00.000Z',
      used_percent: 10,
      resets_at: '2026-11-06T12:00:00.000Z',
      source: 'codex',
    }
    const roomy: Facts = {
      readings: [reading, { ...reading, provider: 'claude' }],
      credits: { codex: { balance: 900, pace_per_day_7d: 10, earliest_expiry: null } },
      refusals: [],
      collected_at: '2026-10-30T12:00:00.000Z',
    }
    const codex = (facts: Facts) => {
      const payload = route(policy, catalog, { role: 'implementation', tool: 'codex' }, facts, now)
      return { payload, usage: payload.rows[0]?.usage }
    }
    // As of the real collection time, not now.
    expect(codex(roomy).payload.facts_as_of).toBe('2026-10-30T12:00:00.000Z')
    expect(codex(roomy).usage?.status).toBe('ok')
    // Collected five days ago: unknown, with no windows and no credit room.
    const stale = codex({ ...roomy, unreadable: { codex: 'last collected 7200 minutes ago' } })
    expect(stale.usage).toMatchObject({ status: 'unknown', windows: [], credits: null })
    expect(formatOptions(stale.payload, 'implementation')).toContain('last collected 7200')
    expect(formatOptions(stale.payload, 'implementation')).not.toContain('has room')
    // A plan that ended says so plainly, and the old windows say nothing any more.
    const ended = codex({
      ...roomy,
      credits: {},
      plan_ended: { codex: '2026-10-30T11:00:00.000Z' },
    })
    expect(ended.usage).toMatchObject({ status: 'no_plan', windows: [] })
    const options = formatOptions(ended.payload, 'implementation')
    expect(options).toContain('  no plan')
    expect(options).toContain('no plan since Oct 30')
    expect(options).not.toContain('has room')
    expect(options).not.toContain('% left')
    expect(ended.payload.rows[0]?.allowed).toBe(true)
    // An explicit model is judged by its own subscription: a Pi model elsewhere isn't OpenCode's.
    const pi = (model: string) =>
      route(
        policy,
        catalog,
        { role: 'implementation', tool: 'pi', model },
        { ...roomy, plan_ended: { 'opencode-go': '2026-10-30T11:00:00.000Z' } },
        now,
      ).rows[0]?.usage?.status
    expect(pi('opencode-go/glm-5.3')).toBe('no_plan')
    expect(pi('zai/some-model')).toBe('untracked')
    // A failed collection of one provider leaves the others alone.
    const failed = { ...roomy, unreadable: { claude: 'its last collection failed' } }
    expect(codex(failed).usage?.status).toBe('ok')
  })

  it('names the used-up window that resets last when two are out', () => {
    const now = '2026-11-06T12:00:00.000Z'
    const reading = (window_minutes: number, resets_at: string) => ({
      provider: 'opencode-go',
      window_minutes,
      observed_at: now,
      used_percent: 100,
      resets_at,
      source: 'opencode_go_usage',
    })
    const facts: Facts = {
      readings: [
        reading(300, '2026-11-06T14:00:00.000Z'),
        reading(10080, '2026-11-08T19:00:00.000Z'),
      ],
      credits: {},
      refusals: [],
      collected_at: now,
    }
    const payload = route(policy, catalog, { role: 'testing', tool: 'pi' }, facts, now)
    expect(formatOptions(payload, 'testing')).toContain('weekly used up  |')
  })

  it('names the window that is used up, shows local times with a zone, and no reset for an untouched window', () => {
    const now = '2026-11-06T12:00:00.000Z'
    const reading = (window_minutes: number, used_percent: number, resets_at: string) => ({
      provider: 'opencode-go',
      window_minutes,
      observed_at: now,
      used_percent,
      resets_at,
      source: 'opencode_go_usage',
    })
    const facts: Facts = {
      readings: [
        reading(300, 0, '2026-11-06T17:00:00.000Z'),
        reading(10080, 100, '2026-11-08T19:00:00.000Z'),
      ],
      credits: {},
      refusals: [],
      collected_at: now,
    }
    const payload = route(policy, catalog, { role: 'testing', tool: 'pi' }, facts, now)
    const text = formatOptions(payload, 'testing')
    expect(text).toContain('pi  opencode-go/deepseek-v4.1-flash xhigh  weekly used up  |')
    expect(text).toContain('5h 100% left, read <1m ago;')
    expect(text).not.toContain('5h 100% left, resets')
    expect(text).toContain('weekly used up until Nov 8, 2:00 PM EST (')
    expect(text).toContain('facts as of Nov 6, 7:00 AM EST;')
    expect(text).toContain('then st aico create')
    vi.stubEnv('AICO_CLI_NAME', 'aico')
    expect(formatOptions(payload, 'testing')).toContain('then aico create')
    vi.unstubAllEnvs()
  })
})

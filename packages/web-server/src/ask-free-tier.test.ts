import type { AskResult } from '@aico/agent'
import type { generate } from '@aico/video'
import { describe, expect, it, vi } from 'vitest'
import { askFreeTier, FREE_TIER_PROVIDER, wantsFreeTier } from './ask-free-tier'
import { SERVICE_APPS } from './service-apps'

const policy = { models: ['flash', 'lite'], wire_silence_seconds: 300 }
const first: AskResult = {
  outcome: { kind: 'error', model: 'gemini-4-argon', detail: 'agy: authentication failed' },
  tokens: { input: 0, output: 0 },
  wallMs: 5,
}
const answers = (...results: (string | Error)[]) => {
  const send = vi.fn(async (model: string) => {
    const next = results.shift()
    if (next instanceof Error || next === undefined) throw next ?? new Error('none left')
    return { text: next, model, usage: { prompt: 3, output: 2, thoughts: 0 }, key: 'k' }
  })
  return send as unknown as typeof generate & typeof send
}
const SCHEMA = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] }

describe('which roles may fall to the free tier', () => {
  it('allows public price research but no private household or financial roles', () => {
    const marked = Object.values(SERVICE_APPS).flatMap((app) =>
      Object.entries(app.agents)
        .filter(([, profile]) => profile.free_tier)
        .map(([slug]) => slug),
    )
    expect(
      marked.filter((slug) => /household|financial|chat|offer|risk|equity/.test(slug)),
    ).toEqual(['household-price-scout'])
  })
})

describe('free tier', () => {
  it('takes a dead model and a too-big prompt, not a refusal or a bad answer', () => {
    expect(wantsFreeTier(first.outcome)).toBe(true)
    expect(wantsFreeTier({ kind: 'silent', model: 'm', seconds: 300 })).toBe(true)
    expect(wantsFreeTier({ kind: 'bad_input', detail: 'big', too_big: true })).toBe(true)
    expect(wantsFreeTier({ kind: 'bad_input', detail: 'bad image' })).toBe(false)
    expect(wantsFreeTier({ kind: 'schema_invalid', model: 'm', errors: [], text: '' })).toBe(false)
  })

  it('answers and says which route it came from', async () => {
    const result = await askFreeTier(policy, 'q', undefined, first, {}, answers('hello'))
    expect(result.outcome).toMatchObject({ kind: 'done', model: 'flash', text: 'hello' })
    expect(result.provider).toBe(FREE_TIER_PROVIDER)
  })

  it('checks a schema, and goes to the next model when the answer does not fit', async () => {
    const send = answers('not json', '{"n": 7}')
    const result = await askFreeTier(policy, 'q', SCHEMA, first, {}, send)
    expect(result.outcome).toMatchObject({ kind: 'done', model: 'lite', data: { n: 7 } })
    expect(JSON.stringify(send.mock.calls[0])).toContain('JSON Schema')
  })

  it('both down: one pass down the list, one failure naming both routes', async () => {
    const send = answers(new Error('Gemini 429 (key): quota'), new Error('Gemini 429 (key): quota'))
    const result = await askFreeTier(policy, 'q', undefined, first, {}, send)
    expect(send).toHaveBeenCalledTimes(2)
    expect(result.outcome).toMatchObject({ kind: 'error', model: 'gemini-4-argon' })
    expect(JSON.stringify(result.outcome)).toContain('authentication failed')
    expect(JSON.stringify(result.outcome)).toContain('429')
  })
})

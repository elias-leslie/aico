import { describe, expect, it } from 'vitest'
import { effortChoices, effortFor } from './effort'

const values = (model: Parameters<typeof effortChoices>[0]) =>
  effortChoices(model).map((choice) => choice.value)

describe('effort choices', () => {
  it('offers the whole ladder to a model that reasons, extra high only when the catalog says so', () => {
    expect(
      values({ id: 'a', capabilities: { has_thinking: true, supports_xhigh: false } }),
    ).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(values({ id: 'b', capabilities: { has_thinking: true, supports_xhigh: true } })).toEqual(
      ['minimal', 'low', 'medium', 'high', 'ultrathink'],
    )
  })

  it('names Agent Hub’s xhigh level the way the turn API takes it, with a plain label', () => {
    const last = effortChoices({
      id: 'b',
      capabilities: { has_thinking: true, supports_xhigh: true },
    }).at(-1)
    expect(last).toEqual({ value: 'ultrathink', label: 'Extra high' })
  })

  it('drops a level the catalog map sets to null, and keeps a level it maps or leaves out', () => {
    expect(
      values({
        id: 'deepseek',
        capabilities: {
          has_thinking: true,
          supports_xhigh: false,
          thinking_level_map: {
            low: 'low',
            max: 'max',
            off: null,
            high: 'high',
            xhigh: null,
            medium: null,
            minimal: null,
          },
        },
      }),
    ).toEqual(['low', 'high'])
    // Claude maps minimal to low: still a choice.
    expect(
      values({
        id: 'claude',
        capabilities: {
          has_thinking: true,
          supports_xhigh: true,
          thinking_level_map: { minimal: 'low' },
        },
      }),
    ).toEqual(['minimal', 'low', 'medium', 'high', 'ultrathink'])
  })

  it('offers nothing for a model without reasoning, an unknown model or no model', () => {
    expect(
      values({ id: 'c', capabilities: { has_thinking: false, supports_xhigh: true } }),
    ).toEqual([])
    expect(values({ id: 'd', capabilities: {} })).toEqual([])
    expect(values({ id: 'e' })).toEqual([])
    expect(values(undefined)).toEqual([])
  })

  it('keeps a chosen level only while the model takes it', () => {
    const low = effortChoices({ id: 'a', capabilities: { has_thinking: true } })
    expect(effortFor(low, 'high')).toBe('high')
    expect(effortFor(low, 'ultrathink')).toBe('')
    expect(effortFor([], 'high')).toBe('')
  })
})

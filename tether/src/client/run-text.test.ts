import { describe, expect, it } from 'vitest'
import type { RunMember } from './contracts'
import { attemptText, modelLine, runDetail, shortModel } from './run-text'

const step = (extra: Partial<RunMember>): RunMember =>
  ({
    kind: 'step',
    word: 'writing',
    requestedModel: 'opencode-go/deepseek-v4.1-flash',
    servedModel: null,
    fallback: false,
    attempt: 2,
    attemptLimit: 3,
    ...extra,
  }) as RunMember

describe('run text', () => {
  it('shortens model ids and shows both models when another one answered', () => {
    expect(shortModel('opencode-go/deepseek-v4.1-flash')).toBe('deepseek-v4.1-flash')
    expect(shortModel(null)).toBeNull()
    expect(modelLine(step({}))).toBe('deepseek-v4.1-flash')
    expect(modelLine(step({ servedModel: 'x/other' }))).toBe('deepseek-v4.1-flash → other')
    expect(modelLine(step({ requestedModel: null }))).toBeNull()
  })

  it('counts attempts only once a step started', () => {
    expect(attemptText(step({}))).toBe('try 2 of 3')
    expect(attemptText(step({ attempt: 0 }))).toBeNull()
    expect(attemptText(step({ attemptLimit: null }))).toBe('try 2')
  })

  it('says a step in one line and a run by its state', () => {
    expect(runDetail(step({ fallback: true, servedModel: 'x/other' }))).toBe(
      'writing · deepseek-v4.1-flash → other · fallback · try 2 of 3',
    )
    expect(runDetail({ kind: 'run', word: 'running' } as RunMember)).toBe('running')
  })
})

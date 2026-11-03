import { describe, expect, it } from 'vitest'
import { fromTether } from './sessions'
import { descriptor } from './testing'

const REFUSAL = {
  key: 'k1',
  kind: 'refusal',
  from: 'claude-opus-5-5',
  to: 'claude-opus-4-8',
  category: 'cyber',
  at: 1_761_998_400_000,
  stopped: true,
  commit: 'e5a9695',
  worktreeChanged: false,
  checked: true,
  rewindTo: '0b6f2a8e-1c0d-4d3e-9a51-2f7c1e8b9d40',
}

const modelSwitch = (value: unknown) =>
  fromTether(descriptor({ modelSwitch: value } as never), null).model_switch

describe('model_switch', () => {
  it('maps Tether’s modelSwitch in snake_case', () => {
    expect(modelSwitch(REFUSAL)).toEqual({
      key: 'k1',
      kind: 'refusal',
      from: 'claude-opus-5-5',
      to: 'claude-opus-4-8',
      category: 'cyber',
      at: 1_761_998_400_000,
      stopped: true,
      commit: 'e5a9695',
      worktree_changed: false,
      checked: true,
      rewind_to: '0b6f2a8e-1c0d-4d3e-9a51-2f7c1e8b9d40',
    })
  })

  it('keeps the unknowns unknown', () => {
    expect(
      modelSwitch({
        ...REFUSAL,
        kind: 'changed',
        category: null,
        at: 'soon',
        stopped: 'yes',
        commit: null,
        worktreeChanged: null,
        checked: 1,
        rewindTo: 42,
      }),
    ).toMatchObject({
      kind: 'changed',
      category: null,
      at: 0,
      stopped: false,
      commit: null,
      worktree_changed: null,
      checked: false,
      rewind_to: null,
    })
  })

  it('is null when missing or not a switch', () => {
    expect(fromTether(descriptor(), null).model_switch).toBeNull()
    expect(modelSwitch(null)).toBeNull()
    expect(modelSwitch('refusal')).toBeNull()
    expect(modelSwitch({ ...REFUSAL, kind: 'fallback' })).toBeNull()
    expect(modelSwitch({ ...REFUSAL, from: 5 })).toBeNull()
    expect(modelSwitch({ ...REFUSAL, to: '' })).toBeNull()
    expect(modelSwitch({ ...REFUSAL, key: undefined })).toBeNull()
  })
})

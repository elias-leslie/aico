import { describe, expect, it } from 'vitest'
import { fromTether, nameAndProject } from './sessions'
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

describe("a session's name", () => {
  it('is what its owner typed, with the project beside it, not in front', () => {
    expect(nameAndProject('Aico — ux-test', 'ux-test')).toEqual({
      name: 'ux-test',
      project: 'Aico',
    })
    expect(nameAndProject('Aico — ux-test · prompt@3', 'ux-test')).toEqual({
      name: 'ux-test · prompt@3',
      project: 'Aico',
    })
  })

  it('keeps the title when nothing was typed or it only says the project', () => {
    expect(nameAndProject('Aico', null)).toEqual({ name: 'Aico', project: null })
    expect(nameAndProject(undefined, 'x')).toEqual({
      name: undefined,
      project: null,
    })
  })

  it('reaches the web app as name and project_name', () => {
    const session = fromTether(
      descriptor({ displayTitle: 'Aico — ux-test', name: 'ux-test' } as never),
      null,
    )
    expect(session.name).toBe('ux-test')
    expect(session.project_name).toBe('Aico')
  })

  it('is the conversation name when none was typed, never the project alone', () => {
    const session = fromTether(
      descriptor({
        displayTitle: 'Aico — Login form fix',
        name: null,
        taskName: 'Login form fix',
        doing: 'Editing LoginForm.tsx',
      } as never),
      null,
    )
    expect(session.name).toBe('Login form fix')
    expect(session.project_name).toBe('Aico')
    expect(session.task).toBe('Login form fix')
    expect(session.doing).toBe('Editing LoginForm.tsx')
    expect(fromTether(descriptor({ doing: ' ' } as never), null).doing).toBeNull()
  })
})

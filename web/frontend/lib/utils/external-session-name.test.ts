import { describe, expect, it } from 'vitest'
import { getExternalSessionDisplayName } from './external-session-name'

const session = {
  name: 'Label/description',
  project_id: 'neri',
  mode: 'codex',
  is_external: true,
  tmux_source: 'aico-server',
  tmux_session_name: 'aico-12345678',
}

describe('getExternalSessionDisplayName', () => {
  it.each([
    ['Neri - Label/description', 'Neri - Label/description'],
    ['Neri · Label/description', 'Neri · Label/description'],
    ['Label/description', 'Neri · Label/description'],
    ['Nerium - Label', 'Neri · Nerium - Label'],
    ['Neri -Label', 'Neri · Neri -Label'],
    ['Neri', 'Neri'],
    ['neri', 'Neri'],
    ['aico-12345678', 'Neri'],
  ])('formats project session %s as %s', (name, expected) => {
    expect(getExternalSessionDisplayName({ ...session, name }, 'Neri')).toBe(
      expected,
    )
  })

  it('preserves a custom name when there is no project', () => {
    expect(
      getExternalSessionDisplayName({ ...session, project_id: null }, 'Neri'),
    ).toBe('Label/description')
  })

  it('uses the mode for a generated name when there is no project', () => {
    expect(
      getExternalSessionDisplayName({
        ...session,
        name: 'aico-12345678',
        project_id: null,
      }),
    ).toBe('Ad-Hoc Codex')
  })

  it('preserves the name when the project display name is unavailable', () => {
    expect(getExternalSessionDisplayName(session)).toBe('Label/description')
  })
})

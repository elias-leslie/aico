import { describe, expect, it } from 'vitest'
import { getExternalSessionDisplayName } from './external-session-name'

const session = {
  name: 'Label/description',
  project_id: 'neri',
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

  it('preserves the name when the project display name is unavailable', () => {
    expect(getExternalSessionDisplayName(session)).toBe('Label/description')
  })
})

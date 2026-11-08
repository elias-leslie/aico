import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StandbyTag } from './StandbyTag'

describe('StandbyTag', () => {
  it('says the state beside the Standby’s name, and that it’s the standby under another', () => {
    const { rerender } = render(
      <StandbyTag
        standby={{ ready: true, state: 'ready', behind: [] }}
        name="Standby"
        className=""
      />,
    )
    expect(screen.getByTestId('standby-tag')).toHaveTextContent(/^Ready$/)
    rerender(
      <StandbyTag
        standby={{ ready: false, state: 'behind', behind: ['Copy: late'] }}
        name="Workstation"
        className=""
      />,
    )
    expect(screen.getByTestId('standby-tag')).toHaveTextContent(
      /^Standby · Behind$/,
    )
    rerender(
      <StandbyTag
        standby={{ ready: false, state: 'off', behind: [] }}
        name="Standby"
        className=""
      />,
    )
    const tag = screen.getByTestId('standby-tag')
    expect(tag).toHaveTextContent(/^Off$/)
    expect(tag.title).toContain('can’t take over')
    expect(tag.title).not.toContain('Ready to take over')
    rerender(
      <StandbyTag
        standby={{ ready: false, state: 'unknown', behind: [] }}
        name="Standby"
        className=""
      />,
    )
    expect(screen.getByTestId('standby-tag')).toHaveTextContent(/^Unknown$/)
  })
})

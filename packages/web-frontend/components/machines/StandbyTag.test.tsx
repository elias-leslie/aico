import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StandbyTag } from './StandbyTag'

describe('StandbyTag', () => {
  it('says the state beside the Standby’s name, and that it’s the standby under another', () => {
    const { rerender } = render(
      <StandbyTag
        standby={{ ready: true, behind: [] }}
        name="Standby"
        className=""
      />,
    )
    expect(screen.getByTestId('standby-tag')).toHaveTextContent(/^Ready$/)
    rerender(
      <StandbyTag
        standby={{ ready: false, behind: ['Copy: late'] }}
        name="Workstation"
        className=""
      />,
    )
    expect(screen.getByTestId('standby-tag')).toHaveTextContent(
      /^Standby · Behind$/,
    )
  })
})

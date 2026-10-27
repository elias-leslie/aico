import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PaneStatusBadge } from './PaneStatusBadge'

describe('PaneStatusBadge', () => {
  it('says Live while connected', () => {
    render(<PaneStatusBadge status="connected" />)
    expect(screen.getByRole('status')).toHaveTextContent('Live')
  })

  it('shows Live as the dot alone on a phone, and names any other state', () => {
    const { rerender } = render(<PaneStatusBadge status="connected" compact />)
    expect(screen.getByRole('status')).toHaveTextContent('')
    expect(screen.getByRole('status')).toHaveAccessibleName('Connection: Live')
    rerender(<PaneStatusBadge status="disconnected" compact />)
    expect(screen.getByRole('status')).toHaveTextContent('Disconnected')
  })

  it('says Connecting while it connects', () => {
    render(<PaneStatusBadge status="connecting" />)
    expect(screen.getByRole('status')).toHaveTextContent('Connecting')
  })

  it('names a dropped connection and leaves Reconnect to the terminal area', () => {
    render(<PaneStatusBadge status="disconnected" />)
    expect(screen.getByRole('status')).toHaveTextContent('Disconnected')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('names a timeout', () => {
    render(<PaneStatusBadge status="timeout" />)
    expect(screen.getByRole('status')).toHaveTextContent('Timed out')
  })
})

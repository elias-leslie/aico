import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PaneStatusBadge, shouldShowPaneStatus } from './PaneStatusBadge'

describe('PaneStatusBadge', () => {
  it('stays hidden for connected panes', () => {
    render(<PaneStatusBadge status="connected" />)

    expect(
      screen.queryByLabelText(/Pane status:/i),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByLabelText(/Reconnect A-Term session/i),
    ).not.toBeInTheDocument()
  })

  it('renders reconnect affordance for disconnected panes', () => {
    const onReconnect = vi.fn()

    render(<PaneStatusBadge status="disconnected" onReconnect={onReconnect} />)

    expect(
      screen.getByRole('button', { name: 'Reconnect A-Term session' }),
    ).toBeInTheDocument()
  })
})

describe('shouldShowPaneStatus', () => {
  it('hides healthy connected state', () => {
    expect(shouldShowPaneStatus('connected')).toBe(false)
  })

  it('keeps unhealthy states visible', () => {
    expect(shouldShowPaneStatus('disconnected')).toBe(true)
    expect(shouldShowPaneStatus('error')).toBe(true)
  })
})

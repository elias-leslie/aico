import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PaneStatusBadge } from './PaneStatusBadge'

describe('PaneStatusBadge', () => {
  it('says Live while connected', () => {
    render(<PaneStatusBadge status="connected" />)
    expect(screen.getByRole('status')).toHaveTextContent('Live')
  })

  it('says Connecting while it connects', () => {
    render(<PaneStatusBadge status="connecting" onReconnect={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('Connecting')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('offers Reconnect after a transient failure', () => {
    const onReconnect = vi.fn()
    render(<PaneStatusBadge status="disconnected" onReconnect={onReconnect} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect session' }))
    expect(onReconnect).toHaveBeenCalledTimes(1)
  })

  it('names the failure when there is no way to reconnect', () => {
    render(<PaneStatusBadge status="timeout" />)
    expect(screen.getByRole('status')).toHaveTextContent('Timed out')
  })
})

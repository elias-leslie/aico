import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Disclosure } from './Disclosure'
import { GlancePopover } from './GlancePopover'

const show = (open: boolean, toggle = vi.fn()) => (
  <Disclosure
    title="Quota"
    head={{ value: '73% left', tone: null }}
    open={open}
    onToggle={toggle}
  >
    <p>body</p>
  </Disclosure>
)

describe('Disclosure', () => {
  it('is one line with its value, and says whether it is open', () => {
    const toggle = vi.fn()
    const { rerender } = render(show(false, toggle))
    const button = screen.getByRole('button', { name: /Quota/ })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button).toHaveTextContent('73% left')
    expect(screen.queryByText('body')).toBeNull()
    fireEvent.click(button)
    expect(toggle).toHaveBeenCalled()
    rerender(show(true, toggle))
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('body')).toBeVisible()
    // Open or closed there is no link out and no second line.
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('wears a state value as a chip', () => {
    render(
      <Disclosure
        title="Status"
        head={{ value: '3 problems', tone: 'failed' }}
        open={false}
        onToggle={vi.fn()}
      >
        <p>body</p>
      </Disclosure>,
    )
    expect(screen.getByText('3 problems')).toHaveClass('status-chip', 'failed')
  })

  it('says nothing beside the label while there is no value', () => {
    render(
      <Disclosure
        title="Status"
        head={{ value: null, tone: null }}
        open={false}
        onToggle={vi.fn()}
      >
        <p>body</p>
      </Disclosure>,
    )
    expect(screen.getByRole('button', { name: 'Status' })).toBeVisible()
  })
})

describe('GlancePopover', () => {
  it('shows the heading, its value and the whole body', () => {
    render(
      <GlancePopover title="Projects" head={{ value: '20 active', tone: null }}>
        <p>everything</p>
      </GlancePopover>,
    )
    expect(screen.getByRole('heading', { name: /Projects/ })).toHaveTextContent(
      '20 active',
    )
    expect(screen.getByText('everything')).toBeVisible()
    expect(screen.queryByRole('link')).toBeNull()
  })
})

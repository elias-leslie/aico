import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Group, Row } from './kit'

describe('Settings rows', () => {
  it('open their detail in place, and close it again', () => {
    render(
      <Group title="Keys" count={1}>
        <Row name="scratch" meta="Last used 2h ago" chip="ok" chipText="In use">
          <button type="button">Replace</button>
        </Row>
      </Group>,
    )
    const head = screen.getByRole('button', { name: /scratch/ })
    expect(head).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('In use')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Replace' })).toBeNull()
    fireEvent.click(head)
    expect(head).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Replace' })).toBeInTheDocument()
    fireEvent.click(head)
    expect(screen.queryByRole('button', { name: 'Replace' })).toBeNull()
  })

  it('a row with no detail is plain text, not a button', () => {
    render(
      <Group title="Phones">
        <Row name="Pixel" meta="Last heard 3m ago" />
      </Group>,
    )
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('Pixel')).toBeInTheDocument()
  })
})

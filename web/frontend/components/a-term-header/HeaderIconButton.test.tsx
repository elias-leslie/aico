import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HeaderIconButton } from './HeaderIconButton'

describe('HeaderIconButton', () => {
  it('names the button by its tooltip', () => {
    render(
      <HeaderIconButton
        icon={<span data-testid="icon" />}
        onClick={vi.fn()}
        tooltip="Files"
      />,
    )
    const button = screen.getByRole('button', { name: 'Files' })
    expect(button).toHaveAttribute('title', 'Files')
    expect(screen.getByTestId('icon')).toBeInTheDocument()
  })

  it('calls onClick when clicked', () => {
    const handleClick = vi.fn()
    render(
      <HeaderIconButton
        icon={<span />}
        onClick={handleClick}
        tooltip="Files"
      />,
    )
    fireEvent.click(screen.getByRole('button'))
    expect(handleClick).toHaveBeenCalledTimes(1)
  })

  it('is a full-size touch target on a phone and compact on a desktop', () => {
    const { rerender } = render(
      <HeaderIconButton
        icon={<span />}
        onClick={vi.fn()}
        tooltip="Files"
        isMobile
      />,
    )
    expect(screen.getByRole('button').className).not.toContain('compact')
    rerender(
      <HeaderIconButton icon={<span />} onClick={vi.fn()} tooltip="Files" />,
    )
    expect(screen.getByRole('button').className).toContain('compact')
  })
})

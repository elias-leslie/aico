import { fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { HeaderIconButton } from './HeaderIconButton'

describe('HeaderIconButton', () => {
  it('renders with tooltip and aria-label', () => {
    const icon = createElement('span', { 'data-testid': 'icon' }, 'X')
    render(
      <HeaderIconButton icon={icon} onClick={vi.fn()} tooltip="Close A-Term" />,
    )

    const button = screen.getByTitle('Close A-Term')
    expect(button).toBeInTheDocument()
    expect(button).toHaveAttribute('aria-label', 'Close A-Term')
    expect(screen.getByTestId('icon')).toBeInTheDocument()
  })

  it('calls onClick when clicked', () => {
    const handleClick = vi.fn()
    const icon = createElement('span', null, 'X')
    render(
      <HeaderIconButton icon={icon} onClick={handleClick} tooltip="Click me" />,
    )

    fireEvent.click(screen.getByTitle('Click me'))
    expect(handleClick).toHaveBeenCalledTimes(1)
  })

  it('applies danger variant styling', () => {
    const icon = createElement('span', null, 'X')
    render(
      <HeaderIconButton
        icon={icon}
        onClick={vi.fn()}
        tooltip="Delete"
        variant="danger"
      />,
    )

    const button = screen.getByTitle('Delete')
    expect(button.style.color).toBe('var(--term-error)')
  })

  it('applies default variant styling when no variant specified', () => {
    const icon = createElement('span', null, 'X')
    render(
      <HeaderIconButton icon={icon} onClick={vi.fn()} tooltip="Settings" />,
    )

    const button = screen.getByTitle('Settings')
    expect(button.style.color).toBe('var(--term-text-muted)')
  })

  it('applies mobile sizing classes when isMobile is true', () => {
    const icon = createElement('span', null, 'X')
    render(
      <HeaderIconButton
        icon={icon}
        onClick={vi.fn()}
        tooltip="Mobile button"
        isMobile
      />,
    )

    const button = screen.getByTitle('Mobile button')
    expect(button.className).toContain('w-8')
    expect(button.className).toContain('h-8')
  })

  it('applies desktop sizing classes when isMobile is false', () => {
    const icon = createElement('span', null, 'X')
    render(
      <HeaderIconButton
        icon={icon}
        onClick={vi.fn()}
        tooltip="Desktop button"
        isMobile={false}
      />,
    )

    const button = screen.getByTitle('Desktop button')
    expect(button.className).toContain('w-6')
    expect(button.className).toContain('h-6')
  })
})

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentTool } from '@/lib/hooks/use-agent-tools'
import { ModeToggle } from './ModeToggle'

const mockTool = (overrides: Partial<AgentTool>): AgentTool => ({
  id: 'tool-id',
  name: 'Claude',
  slug: 'claude',
  command: 'claude',
  process_name: 'claude',
  description: null,
  color: null,
  display_order: 0,
  is_default: true,
  enabled: true,
  created_at: null,
  updated_at: null,
  ...overrides,
})

describe('ModeToggle', () => {
  it('renders in shell mode with correct aria-label', () => {
    const onChange = vi.fn()
    render(
      <ModeToggle
        value="shell"
        onChange={onChange}
        agentTools={[mockTool({})]}
      />,
    )

    const button = screen.getByTestId('mode-toggle')
    expect(button).toBeInTheDocument()
    expect(button).toHaveAttribute(
      'aria-label',
      'Shell mode — click for Claude',
    )
  })

  it('renders in agent mode with tool name in aria-label', () => {
    const onChange = vi.fn()
    render(
      <ModeToggle
        value="claude"
        onChange={onChange}
        agentTools={[mockTool({})]}
      />,
    )

    const button = screen.getByTestId('mode-toggle')
    expect(button).toHaveAttribute(
      'aria-label',
      'Claude mode — click for Shell',
    )
  })

  it('calls onChange with opposite mode when clicked in shell mode', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined)
    render(
      <ModeToggle
        value="shell"
        onChange={onChange}
        agentTools={[mockTool({})]}
      />,
    )

    const button = screen.getByTestId('mode-toggle')
    fireEvent.click(button)

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('claude')
    })
  })

  it('calls onChange with opposite mode when clicked in claude mode', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined)
    render(
      <ModeToggle
        value="claude"
        onChange={onChange}
        agentTools={[mockTool({})]}
      />,
    )

    const button = screen.getByTestId('mode-toggle')
    fireEvent.click(button)

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('shell')
    })
  })

  it('disables agent entry when no agent tools are loaded yet', () => {
    const onChange = vi.fn()
    render(<ModeToggle value="shell" onChange={onChange} />)

    const button = screen.getByTestId('mode-toggle')
    expect(button).toHaveAttribute(
      'aria-label',
      'Shell mode — no agent tools configured',
    )
    expect(button).toBeDisabled()
  })

  it('shows loading state via aria-busy when isLoading is true', () => {
    const onChange = vi.fn()
    render(<ModeToggle value="shell" onChange={onChange} isLoading />)

    const button = screen.getByTestId('mode-toggle')
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveAttribute('aria-label', 'Switching mode...')
  })

  it('disables the button when disabled prop is true', () => {
    const onChange = vi.fn()
    render(<ModeToggle value="shell" onChange={onChange} disabled />)

    const button = screen.getByTestId('mode-toggle')
    expect(button).toBeDisabled()
  })

  it('does not call onChange when disabled', () => {
    const onChange = vi.fn()
    render(<ModeToggle value="shell" onChange={onChange} disabled />)

    const button = screen.getByTestId('mode-toggle')
    fireEvent.click(button)

    expect(onChange).not.toHaveBeenCalled()
  })

  it('does not call onChange when isLoading', () => {
    const onChange = vi.fn()
    render(<ModeToggle value="shell" onChange={onChange} isLoading />)

    const button = screen.getByTestId('mode-toggle')
    fireEvent.click(button)

    expect(onChange).not.toHaveBeenCalled()
  })

  it('resets loading state after onChange rejects', async () => {
    const onChange = vi.fn().mockRejectedValue(new Error('fail'))
    render(
      <ModeToggle
        value="shell"
        onChange={onChange}
        agentTools={[mockTool({})]}
      />,
    )

    fireEvent.click(screen.getByTestId('mode-toggle'))

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled()
    })

    // Button should not remain in loading state
    await waitFor(() => {
      expect(screen.getByTestId('mode-toggle')).not.toBeDisabled()
    })
  })

  it('applies reduced opacity when disabled', () => {
    const onChange = vi.fn()
    render(<ModeToggle value="shell" onChange={onChange} disabled />)

    const button = screen.getByTestId('mode-toggle')
    expect(button.style.opacity).toBe('0.5')
  })
})

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentTool } from '@/lib/hooks/use-agent-tools'
import { ModeToggle } from './ModeToggle'

const mockTool = (overrides: Partial<AgentTool>): AgentTool => ({
  id: 'tool-id',
  name: 'Claude',
  slug: 'claude-code',
  command: 'claude',
  argv: ['claude'],
  process_name: 'claude',
  description: null,
  color: null,
  display_order: 0,
  is_default: true,
  enabled: true,
  aliases: ['claude'],
  context_hook: null,
  created_at: null,
  updated_at: null,
  ...overrides,
})

describe('ModeToggle', () => {
  it('is a labelled control saying what runs, without claiming a restart', () => {
    render(
      <ModeToggle
        value="claude-code"
        onChange={vi.fn()}
        agentTools={[mockTool({ name: 'Claude Code' })]}
      />,
    )
    const button = screen.getByTestId('mode-toggle')
    expect(button).toHaveTextContent('RunsClaude Code')
    expect(button).toHaveAttribute(
      'aria-label',
      'Runs Claude Code. Change what runs here.',
    )
  })

  it('shows the label alone on a phone', () => {
    render(
      <ModeToggle
        value="shell"
        isMobile
        onChange={vi.fn()}
        agentTools={[mockTool({})]}
      />,
    )
    expect(screen.getByTestId('mode-toggle')).toHaveTextContent(/^Shell$/)
  })

  it('opens an explanation and each option with what it does, never switching on the first click', () => {
    const onChange = vi.fn()
    render(
      <ModeToggle
        value="claude-code"
        onChange={onChange}
        agentTools={[
          mockTool({ name: 'Claude Code' }),
          mockTool({ id: 'agy', name: 'Antigravity', slug: 'agy' }),
        ]}
      />,
    )
    fireEvent.click(screen.getByTestId('mode-toggle'))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByTestId('mode-explainer')).toHaveTextContent(
      'ends Claude Code and starts the new one',
    )
    expect(
      screen.getByRole('menuitem', { name: /Claude Code.*Running now/ }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('menuitem', { name: /Antigravity.*replaces it/ }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('menuitem', { name: /Shell.*opens the shell/ }),
    ).toBeInTheDocument()
  })

  it('from a shell, the menu says the shell keeps running beside the agent', () => {
    render(
      <ModeToggle
        value="shell"
        onChange={vi.fn()}
        agentTools={[mockTool({ name: 'Claude Code' })]}
      />,
    )
    fireEvent.click(screen.getByTestId('mode-toggle'))
    expect(screen.getByTestId('mode-explainer')).toHaveTextContent(
      'starts it beside the shell, which keeps running',
    )
  })

  it('from a shell, an agent row says it starts it', () => {
    render(
      <ModeToggle
        value="shell"
        onChange={vi.fn()}
        agentTools={[mockTool({ name: 'Claude Code' })]}
      />,
    )
    fireEvent.click(screen.getByTestId('mode-toggle'))
    expect(
      screen.getByRole('menuitem', { name: /Claude Code.*starts it/ }),
    ).toBeInTheDocument()
  })

  it('shows each option with its tinted mark next to the label', () => {
    render(
      <ModeToggle
        value="shell"
        onChange={vi.fn()}
        agentTools={[
          mockTool({}),
          mockTool({ id: 'agy', name: 'Antigravity', slug: 'agy' }),
        ]}
      />,
    )

    fireEvent.click(screen.getByTestId('mode-toggle'))

    for (const [label, slug, fill] of [
      ['Shell', 'shell', '#8A8F98'],
      ['Claude', 'claude-code', '#D97757'],
      ['Antigravity', 'agy', '#3186FF'],
    ]) {
      const item = screen.getByRole('menuitem', {
        name: new RegExp(`^${label}`),
      })
      const mark = item.querySelector(`[data-agent-icon="${slug}"]`)
      expect(mark).toHaveAttribute('aria-hidden', 'true')
      expect(mark?.querySelector('svg')).toHaveAttribute('fill', fill)
    }
  })

  it('switches only when an option is picked', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined)
    render(
      <ModeToggle
        value="shell"
        onChange={onChange}
        agentTools={[mockTool({})]}
      />,
    )
    fireEvent.click(screen.getByTestId('mode-toggle'))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Claude/ }))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('claude-code'))
  })

  it('picking the running mode changes nothing', () => {
    const onChange = vi.fn()
    render(
      <ModeToggle
        value="shell"
        onChange={onChange}
        agentTools={[mockTool({})]}
      />,
    )
    fireEvent.click(screen.getByTestId('mode-toggle'))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Shell/ }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('closes the mode menu on Escape and returns focus to the toggle', async () => {
    render(
      <ModeToggle
        value="shell"
        onChange={vi.fn()}
        agentTools={[
          mockTool({}),
          mockTool({ id: 't2', name: 'Codex', slug: 'codex' }),
        ]}
      />,
    )
    const button = screen.getByTestId('mode-toggle')
    fireEvent.click(button)
    await screen.findByRole('menu')
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(document.activeElement).toBe(button)
  })

  it('is disabled and says why when no agent tools are loaded', () => {
    render(<ModeToggle value="shell" onChange={vi.fn()} />)
    const button = screen.getByTestId('mode-toggle')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute(
      'aria-label',
      'This session runs a shell. No agents are set up to switch to.',
    )
  })

  it('shows loading state via aria-busy when isLoading is true', () => {
    render(
      <ModeToggle
        value="shell"
        onChange={vi.fn()}
        isLoading
        agentTools={[mockTool({})]}
      />,
    )
    const button = screen.getByTestId('mode-toggle')
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-label', 'Switching what runs here…')
  })

  it('does not open when disabled', () => {
    render(
      <ModeToggle
        value="shell"
        onChange={vi.fn()}
        disabled
        agentTools={[mockTool({})]}
      />,
    )
    fireEvent.click(screen.getByTestId('mode-toggle'))
    expect(screen.queryByRole('menu')).toBeNull()
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
    fireEvent.click(screen.getByRole('menuitem', { name: /^Claude/ }))
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    await waitFor(() => {
      expect(screen.getByTestId('mode-toggle')).not.toBeDisabled()
    })
  })
})

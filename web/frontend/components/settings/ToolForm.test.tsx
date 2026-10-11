import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_FORM, parseAliases, ToolForm } from './ToolForm'

describe('ToolForm', () => {
  it('normalizes submitted values and derives the process name from the command', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)

    render(
      <ToolForm
        initial={EMPTY_FORM}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        isEdit={false}
      />,
    )

    fireEvent.change(screen.getByLabelText('Tool name'), {
      target: { value: ' Codex CLI ' },
    })
    fireEvent.change(screen.getByLabelText('Tool command'), {
      target: { value: '  codex   --model  gpt-5.4  ' },
    })
    fireEvent.change(screen.getByLabelText('Tool description'), {
      target: { value: '  Local coding agent  ' },
    })
    fireEvent.change(screen.getByLabelText('Tool color'), {
      target: { value: '#00ff9f' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        name: 'Codex CLI',
        slug: 'codex-cli',
        command: 'codex --model gpt-5.4',
        process_name: 'codex',
        description: 'Local coding agent',
        color: '#00FF9F',
        aliases: '',
      })
    })
  })

  it('shows a validation error for invalid hex colors', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)

    render(
      <ToolForm
        initial={{
          ...EMPTY_FORM,
          name: 'Codex',
          slug: 'codex',
          command: 'codex',
          process_name: 'codex',
        }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        isEdit={false}
      />,
    )

    fireEvent.change(screen.getByLabelText('Tool color'), {
      target: { value: '#12' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    expect(
      await screen.findByText('Color must be a 6-digit hex value like #00FF9F'),
    ).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('prefills Hermes slug and built-in color from the tool name', () => {
    render(
      <ToolForm
        initial={EMPTY_FORM}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        isEdit={false}
      />,
    )

    fireEvent.change(screen.getByLabelText('Tool name'), {
      target: { value: 'Hermes' },
    })

    expect(screen.getByLabelText('Tool slug')).toHaveValue('hermes')
    expect(screen.getByLabelText('Tool color')).toHaveValue('#F59E0B')
  })

  it('normalizes aliases into a deduplicated slug list', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <ToolForm
        initial={{
          ...EMPTY_FORM,
          name: 'Claude Code',
          slug: 'claude-code',
          command: 'claude --dangerously-skip-permissions',
          process_name: 'claude',
        }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        isEdit
      />,
    )

    fireEvent.change(screen.getByLabelText('Tool aliases'), {
      target: { value: ' Claude, cc ,claude,' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'claude-code', aliases: 'claude, cc' }),
      )
    })
    expect(parseAliases(' Claude, cc ,claude,')).toEqual(['claude', 'cc'])
  })

  it('lets the bare shell tool keep an empty command and shows its context hook', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <ToolForm
        initial={{ ...EMPTY_FORM, name: 'Shell', slug: 'shell' }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        isEdit
        contextHook="codex-hooks"
      />,
    )

    expect(screen.getByLabelText('Tool slug')).toHaveAttribute('readonly')
    expect(screen.getByLabelText('Tool context hook')).toHaveValue(
      'codex-hooks',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'shell', command: '' }),
      )
    })
  })
})

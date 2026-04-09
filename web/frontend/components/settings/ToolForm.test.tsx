import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_FORM, ToolForm } from './ToolForm'

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
})

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./PromptCleaner.module.css', () => ({
  default: new Proxy(
    {},
    {
      get: (_target, prop) => String(prop),
    },
  ),
}))

import { PromptCleaner } from './PromptCleaner'

function renderPromptCleaner(
  overrides: Partial<React.ComponentProps<typeof PromptCleaner>> = {},
) {
  const onSend = vi.fn()
  const onCancel = vi.fn()
  const cleanPrompt = vi.fn().mockResolvedValue('Cleaned prompt')
  const onClearError = vi.fn()

  const props: React.ComponentProps<typeof PromptCleaner> = {
    rawPrompt: 'Original prompt',
    onSend,
    onCancel,
    cleanPrompt,
    errorMessage: null,
    onClearError,
    isCleaning: false,
    showDiffToggle: true,
    ...overrides,
  }

  return {
    ...render(<PromptCleaner {...props} />),
    props,
    onClearError,
  }
}

describe('PromptCleaner', () => {
  it('exposes an accessible close button and waits for the close animation before cancelling', async () => {
    vi.useFakeTimers()

    try {
      const { props, onClearError } = renderPromptCleaner({
        errorMessage: 'Agent Hub is unavailable',
      })

      await act(async () => {
        await Promise.resolve()
      })
      expect(props.cleanPrompt).toHaveBeenCalledWith(
        'Original prompt',
        undefined,
      )

      const closeButton = screen.getByRole('button', {
        name: /close prompt cleaner/i,
      })
      onClearError.mockClear()
      fireEvent.click(closeButton)

      expect(props.onClearError).toHaveBeenCalledTimes(1)
      expect(props.onCancel).not.toHaveBeenCalled()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(299)
      })
      expect(props.onCancel).not.toHaveBeenCalled()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(props.onCancel).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets the user edit the cleaned prompt before sending', async () => {
    const onSend = vi.fn()
    const { props } = renderPromptCleaner({ onSend })

    await waitFor(() => {
      expect(props.cleanPrompt).toHaveBeenCalledTimes(1)
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Edit prompt' }))

    const editTextarea = await screen.findByLabelText('Edit cleaned prompt')
    fireEvent.change(editTextarea, {
      target: { value: '  Rewritten cleaned prompt  ' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Send cleaned prompt' }))

    expect(onSend).toHaveBeenCalledWith('Rewritten cleaned prompt')
  })

  it('refines the prompt when Enter is pressed in the refinement input', async () => {
    const cleanPrompt = vi
      .fn()
      .mockResolvedValueOnce('Cleaned prompt')
      .mockResolvedValueOnce('Shorter prompt')

    renderPromptCleaner({ cleanPrompt })

    await waitFor(() => {
      expect(cleanPrompt).toHaveBeenCalledTimes(1)
    })

    const refinementInput = await screen.findByLabelText(
      'Refine cleaned prompt',
    )
    fireEvent.change(refinementInput, {
      target: { value: 'make it shorter' },
    })
    fireEvent.keyDown(refinementInput, { key: 'Enter' })

    await waitFor(() => {
      expect(cleanPrompt).toHaveBeenNthCalledWith(
        2,
        'Original prompt',
        'make it shorter',
      )
    })
    await waitFor(() => {
      expect(screen.getByLabelText('Refine cleaned prompt')).toHaveValue('')
    })
  })
})

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { VoiceTranscriptPanel } from './VoiceTranscriptPanel'

vi.mock('./VoiceTranscriptPanel.module.css', () => ({
  default: new Proxy(
    {},
    {
      get: (_target, property) => String(property),
    },
  ),
}))

describe('VoiceTranscriptPanel', () => {
  it('sends interim-only mobile speech text', () => {
    const onSend = vi.fn()

    render(
      <VoiceTranscriptPanel
        transcript=""
        interimTranscript="hello world"
        status="listening"
        error={null}
        onSend={onSend}
        onInsert={vi.fn()}
        onCancel={vi.fn()}
        onToggleListening={vi.fn()}
        onReset={vi.fn()}
        isMobile={true}
      />,
    )

    fireEvent.click(screen.getByLabelText('Send transcript'))

    expect(onSend).toHaveBeenCalledWith('hello world')
  })

  it('deduplicates cumulative interim text in the mobile transcript bubble', () => {
    const { container } = render(
      <VoiceTranscriptPanel
        transcript="hello"
        interimTranscript="hello world"
        status="listening"
        error={null}
        onSend={vi.fn()}
        onInsert={vi.fn()}
        onCancel={vi.fn()}
        onToggleListening={vi.fn()}
        onReset={vi.fn()}
        isMobile={true}
      />,
    )

    expect(container.textContent).toContain('hello world')
    expect(container.textContent).not.toContain('hello hello world')
  })
})

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { VoiceTranscriptPanel } from './VoiceTranscriptPanel'

function panelProps() {
  return {
    transcript: 'hello',
    interimTranscript: '',
    status: 'idle' as const,
    error: null,
    onSend: vi.fn(),
    onInsert: vi.fn(),
    onCancel: vi.fn(),
    onToggleListening: vi.fn(),
    onReset: vi.fn(),
    isMobile: true,
  }
}

vi.mock('./VoiceTranscriptPanel.module.css', () => ({
  default: new Proxy(
    {},
    {
      get: (_target, property) => String(property),
    },
  ),
}))

describe('VoiceTranscriptPanel', () => {
  it('offers a separate mobile pause control while speech is ready to send', () => {
    const onSend = vi.fn()
    const onToggleListening = vi.fn()

    render(
      <VoiceTranscriptPanel
        transcript="hello"
        interimTranscript="hello world"
        status="listening"
        error={null}
        onSend={onSend}
        onInsert={vi.fn()}
        onCancel={vi.fn()}
        onToggleListening={onToggleListening}
        onReset={vi.fn()}
        isMobile={true}
      />,
    )

    fireEvent.click(screen.getByLabelText('Pause dictation'))

    expect(onToggleListening).toHaveBeenCalledOnce()
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('Send transcript'))
    expect(onSend).toHaveBeenCalledWith('hello world')
  })

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

  it('deduplicates cumulative interim text in the mobile transcript', () => {
    render(
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

    expect(screen.getByLabelText('Voice transcript')).toHaveValue('hello world')
  })

  it('only toggles listening with Talk, Pause, and Resume', () => {
    const props = panelProps()
    const { rerender } = render(
      <VoiceTranscriptPanel {...props} transcript="" />,
    )
    fireEvent.click(screen.getByLabelText('Talk'))
    rerender(<VoiceTranscriptPanel {...props} status="listening" />)
    fireEvent.click(screen.getByLabelText('Pause dictation'))
    rerender(<VoiceTranscriptPanel {...props} />)
    fireEvent.click(screen.getByLabelText('Resume dictation'))

    expect(props.onToggleListening).toHaveBeenCalledTimes(3)
    expect(props.onSend).not.toHaveBeenCalled()
  })

  it('allows corrections after pausing and sends the edited interim-inclusive draft', () => {
    const props = panelProps()
    const { rerender } = render(
      <VoiceTranscriptPanel
        {...props}
        interimTranscript="hello world"
        status="listening"
      />,
    )
    expect(screen.getByLabelText('Voice transcript')).toHaveProperty(
      'readOnly',
      true,
    )
    rerender(
      <VoiceTranscriptPanel
        {...props}
        interimTranscript="hello world"
        status="processing"
      />,
    )
    expect(screen.getByLabelText('Voice transcript')).toHaveProperty(
      'readOnly',
      true,
    )
    rerender(
      <VoiceTranscriptPanel {...props} interimTranscript="hello world" />,
    )
    expect(screen.getByLabelText('Voice transcript')).toHaveProperty(
      'readOnly',
      false,
    )
    fireEvent.change(screen.getByLabelText('Voice transcript'), {
      target: { value: 'hi earth' },
    })
    fireEvent.click(screen.getByLabelText('Send transcript'))

    expect(props.onSend).toHaveBeenCalledWith('hi earth')
  })

  it('keeps corrections while resumed live speech becomes final', () => {
    const props = panelProps()
    const { rerender } = render(<VoiceTranscriptPanel {...props} />)
    fireEvent.change(screen.getByLabelText('Voice transcript'), {
      target: { value: 'hi' },
    })
    fireEvent.click(screen.getByLabelText('Resume dictation'))
    rerender(
      <VoiceTranscriptPanel
        {...props}
        status="listening"
        interimTranscript="hello world"
      />,
    )
    expect(screen.getByLabelText('Voice transcript')).toHaveValue('hi world')
    rerender(
      <VoiceTranscriptPanel
        {...props}
        transcript="hello world"
        status="listening"
      />,
    )
    expect(screen.getByLabelText('Voice transcript')).toHaveValue('hi world')
    rerender(<VoiceTranscriptPanel {...props} transcript="hello world" />)
    fireEvent.change(screen.getByLabelText('Voice transcript'), {
      target: { value: 'hi earth' },
    })
    rerender(
      <VoiceTranscriptPanel
        {...props}
        transcript="hello world again"
        status="listening"
      />,
    )
    expect(screen.getByLabelText('Voice transcript')).toHaveValue(
      'hi earth again',
    )
    fireEvent.click(screen.getByLabelText('Send transcript'))
    expect(props.onSend).toHaveBeenCalledWith('hi earth again')
  })

  it('keeps the paused field mounted when all words are erased', () => {
    const props = panelProps()
    render(<VoiceTranscriptPanel {...props} />)
    const field = screen.getByLabelText('Voice transcript')
    fireEvent.change(field, { target: { value: '' } })
    expect(screen.getByLabelText('Voice transcript')).toBe(field)
    expect(field).toHaveValue('')
    expect(screen.queryByLabelText('Send transcript')).toBeNull()
    fireEvent.change(field, { target: { value: 'replacement' } })
    fireEvent.click(screen.getByLabelText('Send transcript'))
    expect(props.onSend).toHaveBeenCalledWith('replacement')
  })

  it('retries a failed mobile session without clearing draft corrections', () => {
    const props = panelProps()
    const { rerender } = render(<VoiceTranscriptPanel {...props} />)
    fireEvent.change(screen.getByLabelText('Voice transcript'), {
      target: { value: 'corrected words' },
    })
    rerender(<VoiceTranscriptPanel {...props} status="error" error="network" />)
    fireEvent.click(screen.getByLabelText('Resume dictation'))

    expect(props.onReset).not.toHaveBeenCalled()
    expect(props.onToggleListening).toHaveBeenCalledOnce()
    expect(screen.getByLabelText('Voice transcript')).toHaveValue(
      'corrected words',
    )
    rerender(
      <VoiceTranscriptPanel
        {...props}
        status="listening"
        interimTranscript="hello again"
      />,
    )
    expect(screen.getByLabelText('Voice transcript')).toHaveValue(
      'corrected words again',
    )
  })

  it('drops prior corrections on an explicit transcript reset', () => {
    const props = panelProps()
    const { rerender } = render(<VoiceTranscriptPanel {...props} />)
    fireEvent.change(screen.getByLabelText('Voice transcript'), {
      target: { value: 'hi' },
    })
    rerender(<VoiceTranscriptPanel {...props} transcript="" />)
    expect(screen.getByLabelText('Voice transcript')).toHaveValue('')
    rerender(
      <VoiceTranscriptPanel
        {...props}
        transcript="new phrase"
        status="listening"
      />,
    )
    expect(screen.getByLabelText('Voice transcript')).toHaveValue('new phrase')
  })

  it('preserves desktop corrections when resumed words are sent or inserted', () => {
    const props = panelProps()
    const { rerender } = render(
      <VoiceTranscriptPanel {...props} isMobile={false} />,
    )
    fireEvent.change(screen.getByLabelText('Voice transcript'), {
      target: { value: 'hi' },
    })
    rerender(
      <VoiceTranscriptPanel
        {...props}
        isMobile={false}
        transcript="hello world"
        status="listening"
      />,
    )
    expect(screen.getByLabelText('Voice transcript')).toHaveValue('hi world')
    fireEvent.click(screen.getByLabelText('Insert transcript without enter'))
    fireEvent.click(screen.getByLabelText('Send transcript'))
    expect(props.onInsert).toHaveBeenCalledWith('hi world')
    expect(props.onSend).toHaveBeenCalledWith('hi world')
  })
})

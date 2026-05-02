import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type RecognitionHandler<T> = ((event: T) => void) | null

class FakeSpeechRecognition {
  static instances: FakeSpeechRecognition[] = []

  continuous = false
  interimResults = false
  lang = ''
  onstart: RecognitionHandler<Event> = null
  onresult: RecognitionHandler<{
    resultIndex: number
    results: ArrayLike<{
      isFinal: boolean
      0: { transcript: string }
      length: number
    }>
  }> = null
  onerror: RecognitionHandler<{ error: string }> = null
  onend: RecognitionHandler<Event> = null
  start = vi.fn(() => {
    this.onstart?.(new Event('start'))
  })
  stop = vi.fn(() => {
    this.onend?.(new Event('end'))
  })
  abort = vi.fn(() => {
    this.onend?.(new Event('end'))
  })

  constructor() {
    FakeSpeechRecognition.instances.push(this)
  }

  emitResult(
    results: Array<{
      isFinal: boolean
      transcript: string
    }>,
    options?: {
      resultIndex?: number
    },
  ) {
    this.onresult?.({
      resultIndex: options?.resultIndex ?? 0,
      results: results.map((result) => ({
        isFinal: result.isFinal,
        0: { transcript: result.transcript },
        length: 1,
      })),
    })
  }
}

describe('useTranscription', () => {
  beforeEach(() => {
    vi.resetModules()
    FakeSpeechRecognition.instances = []
    window.SpeechRecognition =
      FakeSpeechRecognition as unknown as typeof window.SpeechRecognition
    window.webkitSpeechRecognition = undefined
  })

  afterEach(() => {
    delete window.SpeechRecognition
    delete window.webkitSpeechRecognition
  })

  it('falls back to browser speech recognition when Agent Hub voice is unavailable', async () => {
    const { useTranscription } = await import('./use-transcription')
    const { result } = renderHook(() => useTranscription())

    expect(result.current.engine).toBe('web-speech')
    expect(result.current.isSupported).toBe(true)

    act(() => {
      result.current.startListening()
    })

    await waitFor(() => {
      expect(result.current.status).toBe('listening')
    })

    act(() => {
      FakeSpeechRecognition.instances[0]?.emitResult([
        { isFinal: false, transcript: 'draft text' },
        { isFinal: true, transcript: 'final text' },
      ])
    })

    await waitFor(() => {
      expect(result.current.interimTranscript).toBe('draft text')
      expect(result.current.finalTranscript).toBe('final text')
    })

    act(() => {
      result.current.stopListening()
    })

    await waitFor(() => {
      expect(result.current.status).toBe('idle')
    })
  })

  it('does not duplicate final phrases when the browser re-delivers prior finalized results', async () => {
    const { useTranscription } = await import('./use-transcription')
    const { result } = renderHook(() => useTranscription())

    act(() => {
      result.current.startListening()
    })

    await waitFor(() => {
      expect(result.current.status).toBe('listening')
    })

    act(() => {
      FakeSpeechRecognition.instances[0]?.emitResult([
        { isFinal: true, transcript: 'hello' },
      ])
    })

    await waitFor(() => {
      expect(result.current.finalTranscript).toBe('hello')
    })

    act(() => {
      FakeSpeechRecognition.instances[0]?.emitResult(
        [
          { isFinal: true, transcript: 'hello' },
          { isFinal: true, transcript: 'world' },
        ],
        { resultIndex: 0 },
      )
    })

    await waitFor(() => {
      expect(result.current.finalTranscript).toBe('hello world')
    })
  })

  it('does not duplicate final phrases when a later result contains prior words', async () => {
    const { useTranscription } = await import('./use-transcription')
    const { result } = renderHook(() => useTranscription())

    act(() => {
      result.current.startListening()
    })

    await waitFor(() => {
      expect(result.current.status).toBe('listening')
    })

    act(() => {
      FakeSpeechRecognition.instances[0]?.emitResult([
        { isFinal: true, transcript: 'hello' },
      ])
    })

    await waitFor(() => {
      expect(result.current.finalTranscript).toBe('hello')
    })

    act(() => {
      FakeSpeechRecognition.instances[0]?.emitResult(
        [
          { isFinal: true, transcript: 'hello' },
          { isFinal: true, transcript: 'hello world' },
        ],
        { resultIndex: 1 },
      )
    })

    await waitFor(() => {
      expect(result.current.finalTranscript).toBe('hello world')
    })
  })

  it('reports unsupported when no speech recognition engine is available', async () => {
    delete window.SpeechRecognition
    delete window.webkitSpeechRecognition

    const { useTranscription } = await import('./use-transcription')
    const { result } = renderHook(() => useTranscription())

    expect(result.current.isSupported).toBe(false)
    expect(result.current.engine).toBe('none')

    act(() => {
      result.current.startListening()
    })

    await waitFor(() => {
      expect(result.current.status).toBe('error')
      expect(result.current.error).toBe('not-supported')
    })
  })
})

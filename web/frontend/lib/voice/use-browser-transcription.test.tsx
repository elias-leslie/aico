import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBrowserTranscription } from './use-browser-transcription'

class FakeSpeechRecognition {
  static instances: FakeSpeechRecognition[] = []
  static failNextStart = false

  continuous = false
  interimResults = false
  lang = ''
  onstart: ((event: Event) => void) | null = null
  onresult:
    | ((event: {
        resultIndex: number
        results: ArrayLike<{
          isFinal: boolean
          0: { transcript: string }
          length: number
        }>
      }) => void)
    | null = null
  onerror: ((event: { error: string }) => void) | null = null
  onend: ((event: Event) => void) | null = null
  start = vi.fn(() => {
    if (FakeSpeechRecognition.failNextStart) {
      FakeSpeechRecognition.failNextStart = false
      throw new Error('Recognition start failed')
    }
    this.onstart?.(new Event('start'))
  })
  stop = vi.fn(() => this.end())
  abort = vi.fn(() => this.end())

  constructor() {
    FakeSpeechRecognition.instances.push(this)
  }

  end() {
    this.onend?.(new Event('end'))
  }

  emitResult(
    results: Array<{ isFinal: boolean; transcript: string }>,
    resultIndex = 0,
  ) {
    this.onresult?.({
      resultIndex,
      results: results.map((result) => ({
        isFinal: result.isFinal,
        0: { transcript: result.transcript },
        length: 1,
      })),
    })
  }
}

describe('useBrowserTranscription', () => {
  beforeEach(() => {
    FakeSpeechRecognition.instances = []
    FakeSpeechRecognition.failNextStart = false
    window.SpeechRecognition =
      FakeSpeechRecognition as unknown as typeof window.SpeechRecognition
    delete window.webkitSpeechRecognition
  })

  afterEach(() => {
    delete window.SpeechRecognition
    delete window.webkitSpeechRecognition
  })

  it('keeps listening after a browser pause and preserves text across reset result indexes', () => {
    const { result } = renderHook(() => useBrowserTranscription())

    act(() => result.current.startListening())
    const first = FakeSpeechRecognition.instances[0]
    act(() => first.emitResult([{ isFinal: true, transcript: 'hello' }]))
    act(() => first.end())

    expect(result.current.status).toBe('listening')
    expect(result.current.finalTranscript).toBe('hello')
    expect(FakeSpeechRecognition.instances).toHaveLength(2)

    const second = FakeSpeechRecognition.instances[1]
    act(() => second.emitResult([{ isFinal: true, transcript: 'world' }]))
    act(() =>
      second.emitResult([
        { isFinal: true, transcript: 'world' },
        { isFinal: true, transcript: 'world again' },
      ]),
    )

    expect(result.current.finalTranscript).toBe('hello world again')
    act(() => second.end())
    expect(FakeSpeechRecognition.instances).toHaveLength(3)
    expect(result.current.status).toBe('listening')
    expect(result.current.finalTranscript).toBe('hello world again')
  })

  it('keeps a silent active session listening after no-speech', () => {
    const { result } = renderHook(() => useBrowserTranscription())
    act(() => result.current.startListening())
    const first = FakeSpeechRecognition.instances[0]

    act(() => {
      first.onerror?.({ error: 'no-speech' })
      first.end()
    })

    expect(result.current.status).toBe('listening')
    expect(result.current.error).toBeNull()
    expect(FakeSpeechRecognition.instances).toHaveLength(2)
  })

  it('ends the session on explicit stop without discarding finalized speech', () => {
    const { result } = renderHook(() => useBrowserTranscription())
    act(() => result.current.startListening())
    const first = FakeSpeechRecognition.instances[0]
    act(() => first.emitResult([{ isFinal: true, transcript: 'hello' }]))
    act(() => result.current.stopListening())

    expect(first.stop).toHaveBeenCalledOnce()
    expect(result.current.status).toBe('idle')
    expect(result.current.finalTranscript).toBe('hello')
    expect(FakeSpeechRecognition.instances).toHaveLength(1)
  })

  it('waits for the last final result after pause without restarting recognition', () => {
    const { result } = renderHook(() => useBrowserTranscription())
    act(() => result.current.startListening())
    const first = FakeSpeechRecognition.instances[0]
    act(() => first.emitResult([{ isFinal: false, transcript: 'hello' }]))
    const lateStart = first.onstart
    const lateResult = first.onresult
    first.stop.mockImplementation(() => {})
    act(() => result.current.stopListening())

    expect(result.current.status).toBe('processing')
    expect(result.current.interimTranscript).toBe('hello')
    act(() => lateStart?.(new Event('start')))
    expect(result.current.status).toBe('processing')
    act(() => first.emitResult([{ isFinal: true, transcript: 'hello world' }]))
    expect(result.current.status).toBe('processing')
    expect(result.current.finalTranscript).toBe('hello world')
    act(() => first.end())
    expect(result.current.status).toBe('idle')
    expect(result.current.finalTranscript).toBe('hello world')
    expect(result.current.interimTranscript).toBe('')
    act(() =>
      lateResult?.({
        resultIndex: 0,
        results: [{ isFinal: true, 0: { transcript: 'stale' }, length: 1 }],
      }),
    )
    expect(result.current.finalTranscript).toBe('hello world')
    expect(FakeSpeechRecognition.instances).toHaveLength(1)
  })

  it('resumes the paused draft without clearing prior final or pending words', () => {
    const { result } = renderHook(() => useBrowserTranscription())
    act(() => result.current.startListening())
    const first = FakeSpeechRecognition.instances[0]
    act(() =>
      first.emitResult([
        { isFinal: true, transcript: 'hello' },
        { isFinal: false, transcript: 'hello draft' },
      ]),
    )
    act(() => result.current.stopListening())
    expect(result.current.finalTranscript).toBe('hello')
    expect(result.current.interimTranscript).toBe('hello draft')
    act(() => result.current.startListening())
    act(() =>
      FakeSpeechRecognition.instances[1].emitResult([
        { isFinal: true, transcript: 'next words' },
      ]),
    )

    expect(result.current.status).toBe('listening')
    expect(result.current.finalTranscript).toBe('hello')
    expect(result.current.interimTranscript).toBe('draft next words')
  })

  it('keeps unfinished words in order across browser-ended cycles without marking them final', () => {
    const { result } = renderHook(() => useBrowserTranscription())
    act(() => result.current.startListening())
    const first = FakeSpeechRecognition.instances[0]
    act(() =>
      first.emitResult([
        { isFinal: true, transcript: 'hello' },
        { isFinal: false, transcript: 'draft' },
      ]),
    )
    act(() => first.end())
    expect(result.current.interimTranscript).toBe('draft')
    const second = FakeSpeechRecognition.instances[1]
    act(() => second.emitResult([{ isFinal: false, transcript: 'next words' }]))
    expect(result.current.interimTranscript).toBe('draft next words')
    act(() => second.emitResult([{ isFinal: true, transcript: 'next words' }]))
    expect(result.current.finalTranscript).toBe('hello')
    expect(result.current.interimTranscript).toBe('draft next words')
    act(() => second.end())
    act(() =>
      FakeSpeechRecognition.instances[2].emitResult([
        { isFinal: true, transcript: 'more words' },
      ]),
    )
    expect(result.current.finalTranscript).toBe('hello')
    expect(result.current.interimTranscript).toBe('draft next words more words')
  })

  it('promotes preserved provisional words only when a browser final confirms them', () => {
    const { result } = renderHook(() => useBrowserTranscription())
    act(() => result.current.startListening())
    const first = FakeSpeechRecognition.instances[0]
    act(() =>
      first.emitResult([
        { isFinal: true, transcript: 'hello' },
        { isFinal: false, transcript: 'hello world' },
      ]),
    )
    act(() => first.end())
    act(() =>
      FakeSpeechRecognition.instances[1].emitResult([
        { isFinal: true, transcript: 'world again' },
      ]),
    )
    expect(result.current.finalTranscript).toBe('hello world again')
    expect(result.current.interimTranscript).toBe('')
  })

  it('ignores stale result and end callbacks from a prior recognition cycle', () => {
    const { result } = renderHook(() => useBrowserTranscription())
    act(() => result.current.startListening())
    const first = FakeSpeechRecognition.instances[0]
    const lateResult = first.onresult
    const lateEnd = first.onend
    act(() => first.end())
    act(() => {
      lateResult?.({
        resultIndex: 0,
        results: [{ isFinal: true, 0: { transcript: 'stale' }, length: 1 }],
      })
      lateEnd?.(new Event('end'))
    })
    expect(result.current.finalTranscript).toBe('')
    expect(result.current.status).toBe('listening')
    expect(FakeSpeechRecognition.instances).toHaveLength(2)
  })

  it('aborts safely when stop fails, ignoring a late start or end', () => {
    const { result } = renderHook(() => useBrowserTranscription())
    act(() => result.current.startListening())
    const first = FakeSpeechRecognition.instances[0]
    const lateStart = first.onstart
    const lateEnd = first.onend
    first.stop.mockImplementation(() => {
      throw new Error('Already stopped')
    })
    act(() => result.current.stopListening())
    act(() => {
      lateStart?.(new Event('start'))
      lateEnd?.(new Event('end'))
    })
    expect(first.abort).toHaveBeenCalledOnce()
    expect(result.current.status).toBe('idle')
    expect(FakeSpeechRecognition.instances).toHaveLength(1)
  })

  it('stops retrying and retains the draft when starting the next cycle fails', () => {
    const { result } = renderHook(() => useBrowserTranscription())
    act(() => result.current.startListening())
    const first = FakeSpeechRecognition.instances[0]
    act(() => first.emitResult([{ isFinal: true, transcript: 'hello' }]))
    FakeSpeechRecognition.failNextStart = true
    act(() => first.end())
    expect(result.current.status).toBe('error')
    expect(result.current.error).toBe('not-allowed')
    expect(result.current.finalTranscript).toBe('hello')
    expect(FakeSpeechRecognition.instances[1].abort).toHaveBeenCalledOnce()
    expect(FakeSpeechRecognition.instances).toHaveLength(2)
  })

  it('does not replace an already-active recognition session', () => {
    const { result } = renderHook(() => useBrowserTranscription())
    act(() => result.current.startListening())
    const first = FakeSpeechRecognition.instances[0]
    act(() => first.emitResult([{ isFinal: true, transcript: 'hello' }]))
    act(() => result.current.startListening())
    expect(FakeSpeechRecognition.instances).toHaveLength(1)
    expect(first.abort).not.toHaveBeenCalled()
    expect(result.current.finalTranscript).toBe('hello')
  })

  it.each([
    'not-allowed',
    'service-not-allowed',
    'audio-capture',
    'network',
    'aborted',
  ])('does not restart after the %s error', (error) => {
    const { result } = renderHook(() => useBrowserTranscription())
    act(() => result.current.startListening())
    const first = FakeSpeechRecognition.instances[0]
    act(() => {
      first.onerror?.({ error })
      first.end()
    })

    expect(result.current.status).toBe('error')
    expect(result.current.error).not.toBeNull()
    expect(first.abort).toHaveBeenCalledOnce()
    expect(FakeSpeechRecognition.instances).toHaveLength(1)
  })

  it('reset cancels recognition and ignores late callbacks', () => {
    const { result } = renderHook(() => useBrowserTranscription())
    act(() => result.current.startListening())
    const first = FakeSpeechRecognition.instances[0]
    const lateEnd = first.onend
    const lateStart = first.onstart
    act(() => result.current.resetTranscript())
    act(() => {
      lateEnd?.(new Event('end'))
      lateStart?.(new Event('start'))
    })

    expect(first.abort).toHaveBeenCalledOnce()
    expect(result.current.status).toBe('idle')
    expect(result.current.finalTranscript).toBe('')
    expect(FakeSpeechRecognition.instances).toHaveLength(1)
  })

  it('unmount aborts recognition and ignores a late end callback', () => {
    const { result, unmount } = renderHook(() => useBrowserTranscription())
    act(() => result.current.startListening())
    const first = FakeSpeechRecognition.instances[0]
    const lateEnd = first.onend
    unmount()
    act(() => lateEnd?.(new Event('end')))

    expect(first.abort).toHaveBeenCalledOnce()
    expect(FakeSpeechRecognition.instances).toHaveLength(1)
  })
})

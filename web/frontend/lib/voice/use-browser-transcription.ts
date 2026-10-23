'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getTranscriptAppendSuffix,
  mergeTranscriptSegments,
  normalizeTranscript,
} from './transcript-merge'
import type {
  TranscriptionError,
  UseTranscriptionOptions,
  UseTranscriptionReturn,
} from './types'

interface SpeechRecognitionAlternativeLike {
  transcript: string
}

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean
  readonly length: number
  [index: number]: SpeechRecognitionAlternativeLike
}

interface SpeechRecognitionResultListLike {
  readonly length: number
  [index: number]: SpeechRecognitionResultLike
}

interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number
  readonly results: SpeechRecognitionResultListLike
}

interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string
}

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  onstart: ((event: Event) => void) | null
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null
  onend: ((event: Event) => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

interface SpeechRecognitionConstructorLike {
  new (): SpeechRecognitionLike
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructorLike
    webkitSpeechRecognition?: SpeechRecognitionConstructorLike
  }
}

function getRecognitionConstructor(): SpeechRecognitionConstructorLike | null {
  if (typeof window === 'undefined') return null

  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null
}

function normalizeError(error: string | undefined): TranscriptionError {
  switch (error) {
    case 'aborted':
      return 'aborted'
    case 'audio-capture':
      return 'not-supported'
    case 'network':
      return 'network'
    case 'no-speech':
      return 'no-speech'
    case 'not-allowed':
    case 'service-not-allowed':
      return 'not-allowed'
    default:
      return 'not-supported'
  }
}

function getDefaultLanguage(preferredLanguage?: string): string {
  if (preferredLanguage) return preferredLanguage
  if (typeof navigator !== 'undefined' && navigator.language) {
    return navigator.language
  }
  return 'en-US'
}

function detachRecognition(recognition: SpeechRecognitionLike) {
  recognition.onstart = null
  recognition.onresult = null
  recognition.onerror = null
  recognition.onend = null
}

function abortRecognition(recognition: SpeechRecognitionLike) {
  detachRecognition(recognition)
  try {
    recognition.abort()
  } catch {
    // Ignore cleanup failures from already-stopped recognizers.
  }
}

export function useBrowserTranscription(
  options?: UseTranscriptionOptions,
): UseTranscriptionReturn {
  const [status, setStatus] = useState<UseTranscriptionReturn['status']>('idle')
  const [error, setError] = useState<TranscriptionError>(null)
  const [interimTranscript, setInterimTranscript] = useState('')
  const [finalTranscript, setFinalTranscript] = useState('')
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const listeningRequestedRef = useRef(false)
  const finalTranscriptRef = useRef('')
  const interimTranscriptRef = useRef('')
  const errorRef = useRef<TranscriptionError>(null)
  const isSupported = getRecognitionConstructor() !== null

  useEffect(() => {
    return () => {
      listeningRequestedRef.current = false
      const recognition = recognitionRef.current
      recognitionRef.current = null
      if (recognition) abortRecognition(recognition)
    }
  }, [])

  const resetTranscript = useCallback(() => {
    listeningRequestedRef.current = false
    const recognition = recognitionRef.current
    recognitionRef.current = null
    if (recognition) abortRecognition(recognition)
    finalTranscriptRef.current = ''
    interimTranscriptRef.current = ''
    errorRef.current = null
    setFinalTranscript('')
    setInterimTranscript('')
    setError(null)
    setStatus('idle')
  }, [])

  const stopListening = useCallback(() => {
    listeningRequestedRef.current = false
    const recognition = recognitionRef.current
    if (!recognition) return
    setStatus((currentStatus) =>
      currentStatus === 'listening' ? 'processing' : currentStatus,
    )
    try {
      recognition.stop()
    } catch {
      recognitionRef.current = null
      abortRecognition(recognition)
      setStatus(errorRef.current ? 'error' : 'idle')
    }
  }, [])

  const startListening = useCallback(() => {
    if (listeningRequestedRef.current) return
    const Recognition = getRecognitionConstructor()
    if (!Recognition) {
      setError('not-supported')
      setStatus('error')
      return
    }

    const previousRecognition = recognitionRef.current
    recognitionRef.current = null
    if (previousRecognition) abortRecognition(previousRecognition)

    listeningRequestedRef.current = true
    errorRef.current = null
    setError(null)

    const startRecognition = () => {
      if (!listeningRequestedRef.current) return
      const recognition = new Recognition()
      recognition.continuous = true
      recognition.interimResults = true
      recognition.lang = getDefaultLanguage(options?.lang)
      // Browser result indexes start over after every native recognition cycle.
      const previousFinalTranscript = finalTranscriptRef.current
      let previousInterimTranscript = interimTranscriptRef.current
      let finalTranscriptSegments: string[] = []

      recognition.onstart = () => {
        if (
          recognitionRef.current !== recognition ||
          !listeningRequestedRef.current
        ) {
          return
        }
        setStatus('listening')
        setError(null)
      }

      recognition.onresult = (event) => {
        if (recognitionRef.current !== recognition) return
        const nextFinalTranscriptSegments = [...finalTranscriptSegments]
        const nextInterimTranscriptSegments: string[] = []

        for (
          let index = event.resultIndex;
          index < event.results.length;
          index += 1
        ) {
          const result = event.results[index]
          const transcript = normalizeTranscript(result[0]?.transcript)

          if (result.isFinal) {
            if (transcript) {
              nextFinalTranscriptSegments[index] = transcript
            } else {
              delete nextFinalTranscriptSegments[index]
            }
          } else if (transcript) {
            nextInterimTranscriptSegments.push(transcript)
          }
        }

        const cycleFinalTranscript = mergeTranscriptSegments(
          nextFinalTranscriptSegments,
        )
        if (
          previousInterimTranscript &&
          (cycleFinalTranscript === previousInterimTranscript ||
            cycleFinalTranscript.startsWith(`${previousInterimTranscript} `))
        ) {
          previousInterimTranscript = ''
        }
        // An unfinished prior cycle must remain provisional and before later
        // words until the browser confirms it, or the user sends the text.
        const nextFinalTranscript = previousInterimTranscript
          ? previousFinalTranscript
          : mergeTranscriptSegments([
              previousFinalTranscript,
              cycleFinalTranscript,
            ])
        const nextInterimTranscript = mergeTranscriptSegments([
          previousInterimTranscript,
          previousInterimTranscript ? cycleFinalTranscript : '',
          ...nextInterimTranscriptSegments,
        ])

        finalTranscriptSegments = nextFinalTranscriptSegments
        finalTranscriptRef.current = nextFinalTranscript
        interimTranscriptRef.current = getTranscriptAppendSuffix(
          nextFinalTranscript,
          nextInterimTranscript,
        )
        setFinalTranscript(nextFinalTranscript)
        setInterimTranscript(nextInterimTranscript)
        if (nextFinalTranscript || nextInterimTranscript) {
          errorRef.current = null
          setError(null)
        }
      }

      recognition.onerror = (event) => {
        if (recognitionRef.current !== recognition) return
        // Silence ends some mobile browser cycles even with continuous enabled.
        if (event.error === 'no-speech') return
        const normalizedError = normalizeError(event.error)
        listeningRequestedRef.current = false
        recognitionRef.current = null
        abortRecognition(recognition)
        errorRef.current = normalizedError
        setError(normalizedError)
        setStatus('error')
      }

      recognition.onend = () => {
        if (recognitionRef.current !== recognition) return
        recognitionRef.current = null
        detachRecognition(recognition)
        if (listeningRequestedRef.current) {
          startRecognition()
        } else {
          setStatus(errorRef.current ? 'error' : 'idle')
        }
      }

      recognitionRef.current = recognition
      setStatus('listening')

      try {
        recognition.start()
      } catch {
        listeningRequestedRef.current = false
        recognitionRef.current = null
        abortRecognition(recognition)
        errorRef.current = 'not-allowed'
        setError('not-allowed')
        setStatus('error')
      }
    }
    startRecognition()
  }, [options?.lang])

  return {
    engine: isSupported ? 'web-speech' : 'none',
    isSupported,
    status,
    error,
    interimTranscript,
    finalTranscript,
    startListening,
    stopListening,
    resetTranscript,
  }
}

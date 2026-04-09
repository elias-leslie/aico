'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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

export function useBrowserTranscription(
  options?: UseTranscriptionOptions,
): UseTranscriptionReturn {
  const [status, setStatus] = useState<UseTranscriptionReturn['status']>('idle')
  const [error, setError] = useState<TranscriptionError>(null)
  const [interimTranscript, setInterimTranscript] = useState('')
  const [finalTranscript, setFinalTranscript] = useState('')
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const stopRequestedRef = useRef(false)
  const finalTranscriptRef = useRef('')
  const errorRef = useRef<TranscriptionError>(null)
  const isSupported = getRecognitionConstructor() !== null

  useEffect(() => {
    finalTranscriptRef.current = finalTranscript
  }, [finalTranscript])

  useEffect(() => {
    errorRef.current = error
  }, [error])

  useEffect(() => {
    return () => {
      const recognition = recognitionRef.current
      if (!recognition) return
      recognition.onstart = null
      recognition.onresult = null
      recognition.onerror = null
      recognition.onend = null
      try {
        recognition.abort()
      } catch {
        // Ignore cleanup failures from already-stopped recognizers.
      }
      recognitionRef.current = null
    }
  }, [])

  const resetTranscript = useCallback(() => {
    const recognition = recognitionRef.current
    if (recognition) {
      recognition.onstart = null
      recognition.onresult = null
      recognition.onerror = null
      recognition.onend = null
      try {
        recognition.abort()
      } catch {
        // Ignore reset failures from already-stopped recognizers.
      }
      recognitionRef.current = null
    }
    stopRequestedRef.current = false
    finalTranscriptRef.current = ''
    errorRef.current = null
    setFinalTranscript('')
    setInterimTranscript('')
    setError(null)
    setStatus('idle')
  }, [])

  const stopListening = useCallback(() => {
    const recognition = recognitionRef.current
    if (!recognition) return
    stopRequestedRef.current = true
    setStatus((currentStatus) =>
      currentStatus === 'listening' ? 'processing' : currentStatus,
    )
    try {
      recognition.stop()
    } catch {
      recognitionRef.current = null
      setStatus(errorRef.current ? 'error' : 'idle')
    }
  }, [])

  const startListening = useCallback(() => {
    const Recognition = getRecognitionConstructor()
    if (!Recognition) {
      setError('not-supported')
      setStatus('error')
      return
    }

    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort()
      } catch {
        // Ignore abort failures while replacing a stale recognizer.
      }
      recognitionRef.current = null
    }

    stopRequestedRef.current = false
    errorRef.current = null
    setError(null)
    setInterimTranscript('')

    const recognition = new Recognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = getDefaultLanguage(options?.lang)

    recognition.onstart = () => {
      setStatus('listening')
      setError(null)
    }

    recognition.onresult = (event) => {
      let nextFinalTranscript = finalTranscriptRef.current
      let nextInterimTranscript = ''

      for (
        let index = event.resultIndex;
        index < event.results.length;
        index += 1
      ) {
        const result = event.results[index]
        const transcript = result[0]?.transcript?.trim()
        if (!transcript) continue

        if (result.isFinal) {
          nextFinalTranscript = nextFinalTranscript
            ? `${nextFinalTranscript} ${transcript}`
            : transcript
        } else {
          nextInterimTranscript = nextInterimTranscript
            ? `${nextInterimTranscript} ${transcript}`
            : transcript
        }
      }

      finalTranscriptRef.current = nextFinalTranscript
      setFinalTranscript(nextFinalTranscript)
      setInterimTranscript(nextInterimTranscript)
      if (nextFinalTranscript || nextInterimTranscript) {
        errorRef.current = null
        setError(null)
      }
    }

    recognition.onerror = (event) => {
      const normalizedError = normalizeError(event.error)
      errorRef.current = normalizedError
      setError(normalizedError)
      setInterimTranscript('')
      setStatus('error')
    }

    recognition.onend = () => {
      recognitionRef.current = null
      setInterimTranscript('')
      stopRequestedRef.current = false
      setStatus(errorRef.current ? 'error' : 'idle')
    }

    recognitionRef.current = recognition

    try {
      recognition.start()
    } catch {
      recognitionRef.current = null
      errorRef.current = 'not-allowed'
      setError('not-allowed')
      setStatus('error')
    }
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

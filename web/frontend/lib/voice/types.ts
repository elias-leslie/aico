/**
 * Voice transcription types.
 *
 * These mirror the types from @agent-hub/passport-client so Terminal
 * can build and run without that package installed. When passport-client
 * is available, the real useTranscription hook is used; otherwise a
 * no-op stub provides safe defaults.
 */

export type TranscriptionEngine = 'web-speech' | 'whisper' | 'none'
export type TranscriptionStatus = 'idle' | 'listening' | 'processing' | 'error'
export type TranscriptionError =
  | 'not-supported'
  | 'not-allowed'
  | 'no-speech'
  | 'network'
  | 'aborted'
  | 'whisper-unavailable'
  | null

export interface UseTranscriptionOptions {
  whisperWsUrl?: string
  preferredEngine?: 'web-speech' | 'whisper'
  lang?: string
}

export interface UseTranscriptionReturn {
  engine: TranscriptionEngine
  isSupported: boolean
  status: TranscriptionStatus
  error: TranscriptionError
  interimTranscript: string
  finalTranscript: string
  startListening: () => void
  stopListening: () => void
  resetTranscript: () => void
}

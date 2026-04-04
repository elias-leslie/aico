/**
 * Transcription hook with optional passport-client dependency.
 *
 * Tries to load useTranscription from @agent-hub/passport-client at build time.
 * If the package is not installed, exports a no-op stub that reports
 * voice as unsupported. All voice UI gracefully disables itself in that case.
 */

import type { UseTranscriptionOptions, UseTranscriptionReturn } from './types'

const noop = () => {}

function useTranscriptionStub(
  _options?: UseTranscriptionOptions,
): UseTranscriptionReturn {
  return {
    engine: 'none',
    isSupported: false,
    status: 'idle',
    error: null,
    interimTranscript: '',
    finalTranscript: '',
    startListening: noop,
    stopListening: noop,
    resetTranscript: noop,
  }
}

// Resolve once at module load: real hook or stub
let resolved: (opts?: UseTranscriptionOptions) => UseTranscriptionReturn

try {
  const dynamicRequire = Function(
    'return typeof require !== "undefined" ? require : null',
  )() as ((id: string) => { useTranscription?: typeof useTranscriptionStub }) | null
  const mod = dynamicRequire?.('@agent-hub/passport-client')
  resolved = mod?.useTranscription ?? useTranscriptionStub
} catch {
  resolved = useTranscriptionStub
}

/**
 * Use voice transcription if @agent-hub/passport-client is installed,
 * otherwise return a safe no-op (isSupported: false).
 */
export const useTranscription: (
  options?: UseTranscriptionOptions,
) => UseTranscriptionReturn = resolved

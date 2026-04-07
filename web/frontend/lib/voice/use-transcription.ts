/**
 * Transcription hook with optional passport-client dependency.
 *
 * Tries to load useTranscription from @agent-hub/passport-client at build time.
 * If the package is not installed, falls back to browser-native speech
 * recognition so standalone installs still support STT where the browser does.
 */

import type { UseTranscriptionOptions, UseTranscriptionReturn } from './types'
import { useBrowserTranscription } from './use-browser-transcription'

let resolvedPassport:
  | ((opts?: UseTranscriptionOptions) => UseTranscriptionReturn)
  | null = null

try {
  const dynamicRequire = Function(
    'return typeof require !== "undefined" ? require : null',
  )() as ((id: string) => {
    useTranscription?: (
      options?: UseTranscriptionOptions,
    ) => UseTranscriptionReturn
  }) | null
  const mod = dynamicRequire?.('@agent-hub/passport-client')
  resolvedPassport = mod?.useTranscription ?? null
} catch {
  resolvedPassport = null
}

/**
 * Prefer the Agent Hub whisper client when it is installed and supported.
 * Fall back to browser-native STT so standalone installs still work.
 */
export function useTranscription(
  options?: UseTranscriptionOptions,
): UseTranscriptionReturn {
  const browserTranscription = useBrowserTranscription(options)

  if (!resolvedPassport) {
    return browserTranscription
  }

  const passportTranscription = resolvedPassport(options)
  if (passportTranscription.isSupported) {
    return passportTranscription
  }

  return browserTranscription
}

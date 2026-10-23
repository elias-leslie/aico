export const ERROR_MESSAGES: Record<string, string> = {
  'not-allowed': 'Microphone access denied. Check browser permissions.',
  'no-speech': 'No speech detected. Tap mic to try again.',
  network: 'Network error. Speech recognition requires internet.',
  'whisper-unavailable': 'Voice server unavailable. Try a different browser.',
  'not-supported': 'Speech recognition not supported in this browser.',
  aborted: 'Speech recognition was aborted.',
}

export const SHORT_ERROR_MESSAGES: Record<string, string> = {
  'not-allowed': 'Mic access denied',
  'no-speech': 'No speech detected',
  network: 'Network error',
  'whisper-unavailable': 'Voice unavailable',
  'not-supported': 'Not supported',
  aborted: 'Aborted',
}

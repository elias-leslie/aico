export function normalizeTranscript(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ')
}

function getWords(value: string): string[] {
  return normalizeTranscript(value).split(' ').filter(Boolean)
}

export function getTranscriptAppendSuffix(
  base: string,
  addition: string,
): string {
  const baseWords = getWords(base)
  const additionWords = getWords(addition)

  if (additionWords.length === 0) {
    return ''
  }
  if (baseWords.length === 0) {
    return additionWords.join(' ')
  }

  const maxOverlap = Math.min(baseWords.length, additionWords.length)
  for (let size = maxOverlap; size > 0; size -= 1) {
    const baseSuffix = baseWords.slice(baseWords.length - size).join(' ')
    const additionPrefix = additionWords.slice(0, size).join(' ')
    if (baseSuffix === additionPrefix) {
      return additionWords.slice(size).join(' ')
    }
  }

  return additionWords.join(' ')
}

export function mergeTranscriptSegments(
  segments: Array<string | null | undefined>,
): string {
  let merged = ''

  for (const segment of segments) {
    const normalized = normalizeTranscript(segment)
    if (!normalized) {
      continue
    }

    const suffix = getTranscriptAppendSuffix(merged, normalized)
    if (!suffix) {
      continue
    }
    merged = merged ? `${merged} ${suffix}` : suffix
  }

  return merged
}

export function normalizeTranscript(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ')
}

function getWords(value: string): string[] {
  return normalizeTranscript(value).split(' ').filter(Boolean)
}

// Phone recognizers re-send a phrase they already finalized, often heard a
// little differently the second time ("Aiko" / "Iko", "double-checking" /
// "double checking"). A seam overlap this long, differing in this few words,
// is the same speech, not the speaker repeating themselves.
const FUZZY_MIN_WORDS = 4
const FUZZY_MAX_EDIT_RATIO = 0.2
const FUZZY_MAX_WORDS = 150

/** Comparison keys per word: case and punctuation dropped, hyphens split. */
function wordKeys(word: string): string[] {
  return word
    .toLowerCase()
    .split('-')
    .map((part) => part.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean)
}

/** Word edit distance, or Infinity once it must exceed `limit`. */
function editDistance(a: string[], b: string[], limit: number): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost,
      )
      rowMin = Math.min(rowMin, current[j])
    }
    if (rowMin > limit) return Number.POSITIVE_INFINITY
    previous = current
  }
  return previous[b.length]
}

/** Words of `addition` that a near-identical copy of `base`'s tail covers. */
function fuzzyOverlap(baseWords: string[], additionWords: string[]): number {
  const base = baseWords.slice(-FUZZY_MAX_WORDS).flatMap(wordKeys)
  const addition: string[] = []
  // wordsAt[k]: whole addition words covered by its first k keys (-1 mid-word).
  const wordsAt = [0]
  additionWords.forEach((word, index) => {
    const keys = wordKeys(word)
    addition.push(...keys)
    for (let part = 1; part <= keys.length; part += 1) {
      wordsAt.push(part === keys.length ? index + 1 : -1)
    }
  })
  for (let size = base.length; size >= FUZZY_MIN_WORDS; size -= 1) {
    const tail = base.slice(base.length - size)
    if (tail[0] !== addition[0] && tail[1] !== addition[1]) continue
    const limit = Math.floor(size * FUZZY_MAX_EDIT_RATIO)
    for (let delta = 0; delta <= limit; delta += 1) {
      for (const covered of delta ? [size - delta, size + delta] : [size]) {
        if (covered < 1 || covered > addition.length || wordsAt[covered] < 1)
          continue
        if (editDistance(tail, addition.slice(0, covered), limit) <= limit)
          return wordsAt[covered]
      }
    }
  }
  return 0
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

  return additionWords.slice(fuzzyOverlap(baseWords, additionWords)).join(' ')
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

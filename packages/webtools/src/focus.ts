// Focus a long page on a question: split it into heading-led chunks, score them with BM25
// (Okapi, k1 1.5, b 0.75, as Agent Hub's rank_bm25 did) and keep the best ones in page order.

export const normalizeWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim()

const tokens = (text: string) => text.toLowerCase().match(/[a-z0-9_]+/g) ?? []

function splitLong(block: string, max: number): string[] {
  if (block.length <= max) return [block]
  const sentences = block
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (sentences.length <= 1) {
    const out: string[] = []
    for (let i = 0; i < block.length; i += max) out.push(block.slice(i, i + max).trim())
    return out
  }
  const chunks: string[] = []
  let current: string[] = []
  let length = 0
  for (const sentence of sentences) {
    const added = sentence.length + (current.length ? 1 : 0)
    if (current.length && length + added > max) {
      chunks.push(current.join(' ').trim())
      current = [sentence]
      length = sentence.length
      continue
    }
    current.push(sentence)
    length += added
  }
  if (current.length) chunks.push(current.join(' ').trim())
  return chunks
}

function buildChunks(content: string): string[] {
  const blocks = content
    .split(/\n\s*\n+/)
    .map((b) => b.trim())
    .filter(Boolean)
  if (!blocks.length) return content.trim() ? [content.trim()] : []
  const chunks: string[] = []
  let heading: string | null = null
  let index = 0
  while (index < blocks.length) {
    let block = blocks[index] as string
    if (block.startsWith('#') && !block.includes('\n')) heading = block
    if (index + 1 < blocks.length && block.length <= 120 && block.startsWith('#')) {
      block = `${block}\n\n${blocks[index + 1]}`
      index += 2
    } else {
      index += 1
      if (heading && !block.startsWith('#')) block = `${heading}\n\n${block}`
    }
    chunks.push(...splitLong(block, 1200))
  }
  return chunks.filter((c) => c.trim())
}

/** BM25 Okapi scores of each chunk for the query terms (duplicates count each time). */
function bm25(chunks: string[], query: string[]): number[] {
  const docs = chunks.map(tokens)
  if (!docs.some((d) => d.length)) return []
  const n = docs.length
  const avg = docs.reduce((s, d) => s + d.length, 0) / n
  const df = new Map<string, number>()
  for (const doc of docs) for (const term of new Set(doc)) df.set(term, (df.get(term) ?? 0) + 1)
  const idf = new Map<string, number>()
  let sum = 0
  const negative: string[] = []
  for (const [term, count] of df) {
    const value = Math.log(n - count + 0.5) - Math.log(count + 0.5)
    idf.set(term, value)
    sum += value
    if (value < 0) negative.push(term)
  }
  const floor = 0.25 * (sum / df.size)
  for (const term of negative) idf.set(term, floor)
  return docs.map((doc) => {
    const freq = new Map<string, number>()
    for (const term of doc) freq.set(term, (freq.get(term) ?? 0) + 1)
    let score = 0
    for (const term of query) {
      const f = freq.get(term) ?? 0
      score += (idf.get(term) ?? 0) * ((f * 2.5) / (f + 1.5 * (0.25 + (0.75 * doc.length) / avg)))
    }
    return score
  })
}

function termWindow(text: string, terms: string[], max: number): string | null {
  const stripped = text.trim()
  if (stripped.length <= max) return stripped
  const lowered = stripped.toLowerCase()
  const unique = [...new Set(terms)].filter(Boolean)
  const found = unique.map((t) => lowered.indexOf(t)).filter((p) => p >= 0)
  if (!found.length) return null
  let bestStart = 0
  let bestScore = -1
  for (const pos of found) {
    const start = Math.min(
      Math.max(0, pos - Math.floor(max / 3)),
      Math.max(0, stripped.length - max),
    )
    const window = lowered.slice(start, start + max)
    const score = unique.filter((t) => window.includes(t)).length
    if (score > bestScore) {
      bestStart = start
      bestScore = score
    }
  }
  if (bestStart > 0) {
    const boundary = stripped.lastIndexOf(' ', bestStart - 1)
    if (boundary >= Math.max(0, bestStart - 40)) bestStart = boundary + 1
  }
  return stripped.slice(bestStart, bestStart + max).trim() || null
}

export interface FocusMeta {
  focused: boolean
  focus_strategy?: string
  selected_chunk_count?: number
  candidate_chunk_count?: number
}

export function selectFocused(
  content: string,
  focusQuery: string | null | undefined,
  max: number,
): { text: string; meta: FocusMeta } {
  const stripped = content.trim()
  const query = normalizeWhitespace(focusQuery ?? '')
  const unfocused = { text: content, meta: { focused: false } }
  if (!query || !stripped || stripped.length <= max) return unfocused
  const chunks = buildChunks(stripped)
  const terms = tokens(query)
  if (!chunks.length || !terms.length) return unfocused
  const scores = bm25(chunks, terms)
  if (!scores.length) return unfocused
  const ranked = chunks
    .map((_, i) => i)
    .sort((a, b) => (scores[b] as number) - (scores[a] as number))

  const selected: number[] = []
  let chars = 0
  for (const i of ranked) {
    const chunk = chunks[i] as string
    if (!chunk.trim() || (scores[i] as number) <= 0) continue
    const projected = chars + chunk.length + (selected.length ? 2 : 0)
    if (selected.length && projected > max) continue
    selected.push(i)
    chars = projected
    if (chars >= max) break
  }
  selected.sort((a, b) => a - b)

  if (!selected.length) {
    let window: string | null = null
    for (const i of ranked) {
      if ((scores[i] as number) <= 0) continue
      window = termWindow(chunks[i] as string, terms, max)
      if (window) break
    }
    window ??= termWindow(chunks.join('\n\n'), terms, max)
    if (!window || window === stripped) return unfocused
    return {
      text: window,
      meta: {
        focused: true,
        focus_strategy: 'bm25_term_window',
        selected_chunk_count: 1,
        candidate_chunk_count: chunks.length,
      },
    }
  }
  const chosen: string[] = []
  let lastHeading: string | null = null
  for (const i of selected) {
    let chunk = chunks[i] as string
    const first = chunk.split('\n', 1)[0] as string
    if (first.startsWith('#')) {
      if (first === lastHeading) chunk = chunk.slice(first.length).trim()
      else lastHeading = first
    }
    if (chunk) chosen.push(chunk)
  }
  const focused = chosen.join('\n\n').trim()
  if (!focused) return unfocused
  return {
    text: focused,
    meta: {
      focused: focused !== stripped,
      focus_strategy: 'bm25_chunks',
      selected_chunk_count: selected.length,
      candidate_chunk_count: chunks.length,
    },
  }
}

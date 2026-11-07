// WebVTT captions to clean, timestamped lines. YouTube's auto-captions "roll": each cue carries
// the previous line again plus a new one, with word timing tags inside, and tiny 10 ms cues that
// only repeat a line. A line counts once, at the first cue that shows it.
import { clock } from './url'

export interface Cue {
  /** Seconds from the start of the video. */
  t: number
  text: string
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
}
const clean = (line: string) =>
  line
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (e) => ENTITIES[e])
    .replace(/\s+/g, ' ')
    .trim()

const STAMP = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})/
const toSeconds = (match: RegExpMatchArray) =>
  Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000

export function parseVtt(vtt: string): Cue[] {
  const cues: Cue[] = []
  let last = { text: '', end: -1 }
  for (const block of vtt.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n')
    const at = lines.findIndex((l) => l.includes('-->'))
    if (at < 0) continue
    const [from, to] = lines[at].split('-->')
    const start = from.match(STAMP),
      stop = to?.match(STAMP)
    if (!start || !stop) continue
    const t = toSeconds(start),
      end = toSeconds(stop)
    for (const raw of lines.slice(at + 1)) {
      const text = clean(raw)
      if (!text) continue
      // The same line again while the cue chain is unbroken is the roll, not new speech.
      if (text === last.text && t <= last.end + 0.05) {
        last.end = Math.max(last.end, end)
        continue
      }
      cues.push({ t, text })
      last = { text, end }
    }
  }
  return cues
}

export interface Window {
  start?: number
  end?: number | null
}
export const inWindow = (cues: Cue[], { start = 0, end = null }: Window = {}) =>
  cues.filter((c) => c.t >= start && (end === null || c.t < end))

/** `[mm:ss] text` paragraphs, one per `paragraphSeconds` of speech; `[h:mm:ss]` once the video passes an hour. */
export function renderTranscript(cues: Cue[], paragraphSeconds: number): string {
  const long = cues.some((c) => c.t >= 3600)
  const paragraphs: string[] = []
  let opened = -Infinity,
    words: string[] = []
  const flush = () => {
    if (words.length) paragraphs.push(words.join(' '))
  }
  for (const cue of cues) {
    if (cue.t >= opened + paragraphSeconds) {
      flush()
      opened = cue.t
      words = [`[${clock(cue.t, long)}]`]
    }
    words.push(cue.text)
  }
  flush()
  return paragraphs.join('\n\n')
}

export interface CaptionInfo {
  subtitles?: Record<string, unknown>
  automatic_captions?: Record<string, unknown>
}
export interface CaptionPick {
  file: string
  lang: string
  kind: 'manual' | 'auto'
}
/** Manual captions beat automatic ones; among automatic ones the original-language track (`en-orig`) beats a translation. */
export function pickCaptions(info: CaptionInfo, files: string[], lang: string): CaptionPick | null {
  const rank = (code: string): number => {
    const manual = info.subtitles && code in info.subtitles
    const original = code.endsWith('-orig')
    const exact = code === lang
    return (manual ? 0 : 10) + (original ? 0 : 1) + (exact || original ? 0 : 1)
  }
  const found = files.flatMap((file) => {
    const code = file.match(/\.([A-Za-z0-9-]+)\.vtt$/)?.[1]
    return code && (code === lang || code.startsWith(`${lang}-`)) ? [{ file, code }] : []
  })
  found.sort((a, b) => rank(a.code) - rank(b.code) || a.code.localeCompare(b.code))
  const best = found[0]
  if (!best) return null
  return {
    file: best.file,
    lang: best.code,
    kind: info.subtitles && best.code in info.subtitles ? 'manual' : 'auto',
  }
}

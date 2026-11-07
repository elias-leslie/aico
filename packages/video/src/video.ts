// `aico video`: fetch what YouTube gives for free (metadata, captions), have Gemini watch the
// video with the cleaned captions attached, and say honestly which of those sources fed the answer.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LoginStore } from '@aico/fleet/logins'
import { type Cue, inWindow, parseVtt, renderTranscript } from './captions'
import { cacheRoot, config, type Resolution } from './config'
import { type GeminiError, type Generated, generate, type Part, type Post } from './gemini'
import { clock, parseRange, type Range, UsageError, videoId, watchUrl } from './url'
import { type Exec, fetchCaptions, type VideoMeta } from './ytdlp'

export { UsageError }
export interface Request {
  url: string
  ask?: string
  transcript?: boolean
  range?: string
  model?: string
  refresh?: boolean
  resolution?: Resolution
  lang?: string
}
export interface Deps {
  env: NodeJS.ProcessEnv
  out(text: string): void
  err(text: string): void
  exec: Exec
  post?: Post
  store?: () => LoginStore
  now(): Date
  sleep?: (ms: number) => Promise<void>
}

interface Stored extends Partial<VideoMeta> {
  id: string
  url: string
  captions: {
    status: 'ok' | 'none' | 'error'
    requested: string
    lang?: string
    kind?: string
    note?: string | null
    words?: number
  }
  fetched: string
}
interface Answer {
  mode: 'video+captions' | 'video' | 'captions'
  model: string
  key: string
  usage: Generated['usage']
  seconds: number
  created: string
  note: string | null
}

const words = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0)
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n))
const readJson = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}
const writeJson = (path: string, value: unknown) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)

function cap(text: string, limit: number, file: string): string {
  const body = text.trim()
  let seen = 0
  for (const m of body.matchAll(/\S+/g)) {
    if (++seen > limit)
      return `${body.slice(0, m.index).trimEnd()} ...\n(cut at ${limit} words; the full text is in ${file})`
  }
  return body
}

export async function runVideo(req: Request, deps: Deps): Promise<number> {
  const { out, err } = deps
  const id = videoId(req.url)
  if (!id) throw new UsageError(`"${req.url}" is not a YouTube link or video id`)
  const range: Range | null = req.range ? parseRange(req.range) : null
  if (req.ask !== undefined && !req.ask.trim()) throw new UsageError('--ask needs a question')
  if (req.ask !== undefined && req.transcript)
    throw new UsageError('use --ask or --transcript, not both')
  const lang = req.lang || config.ytdlp.defaultLang
  const dir = join(cacheRoot(deps.env, existsSync), id)
  const url = watchUrl(id)

  // 1. Metadata and captions (cached; a failed fetch is tried again next time).
  let stored = readJson<Stored>(join(dir, 'meta.json'))
  if (
    !stored ||
    req.refresh ||
    stored.captions.status === 'error' ||
    stored.captions.requested !== lang
  ) {
    err('aico video: reading metadata and captions with yt-dlp...\n')
    const got = await fetchCaptions(id, url, dir, lang, deps.exec)
    rmSync(join(dir, `${id}.info.json`), { force: true })
    let cues: Cue[] = []
    if (got.captions) {
      cues = parseVtt(got.captions.vtt)
      writeJson(join(dir, 'cues.json'), cues)
      writeFileSync(
        join(dir, 'transcript.txt'),
        `${renderTranscript(cues, config.transcript.paragraphSeconds)}\n`,
      )
    }
    stored = {
      id,
      url,
      ...got.meta,
      captions: got.captions
        ? {
            status: cues.length ? 'ok' : 'none',
            requested: lang,
            lang: got.captions.pick.lang,
            kind: got.captions.pick.kind,
            note: cues.length ? null : 'the caption file was empty',
            words: words(cues.map((c) => c.text).join(' ')),
          }
        : {
            status: got.meta.title === undefined ? 'error' : 'none',
            requested: lang,
            note: got.note,
          },
      fetched: deps.now().toISOString(),
    }
    mkdirSync(dir, { recursive: true })
    writeJson(join(dir, 'meta.json'), stored)
  }
  const cues =
    stored.captions.status === 'ok' ? (readJson<Cue[]>(join(dir, 'cues.json')) ?? []) : []
  const slice = range ? inWindow(cues, range) : cues
  const transcript = renderTranscript(slice, config.transcript.paragraphSeconds)
  const files = [...(cues.length ? [join(dir, 'transcript.txt')] : []), join(dir, 'meta.json')]
  const head = [
    `Title: ${stored.title ?? '(unknown: metadata unavailable)'}`,
    `Channel: ${stored.channel ?? 'unknown'}   Duration: ${stored.duration ? clock(stored.duration) : 'unknown'}   Published: ${stored.uploaded ? stored.uploaded.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : 'unknown'}`,
    `URL: ${url}${range ? `   Range: ${clock(range.start)}-${range.end === null ? 'end' : clock(range.end)}` : ''}`,
  ]
  const captionLine = cues.length
    ? `captions (${stored.captions.lang}, ${stored.captions.kind === 'manual' ? 'written by hand' : 'auto-generated'}, ${k(stored.captions.words ?? 0)} words)`
    : `no captions (${stored.captions.note ?? 'none found'})`

  // --transcript: no model involved.
  if (req.transcript) {
    if (!slice.length) {
      err(
        `aico video: ${range && cues.length ? 'no captions fall in that range' : `no captions for this video: ${stored.captions.note ?? 'none found'}`}. Drop --transcript to have Gemini watch it.\n`,
      )
      return 1
    }
    out(
      `${head.join('\n')}\nSource: ${captionLine}\nFile: ${join(dir, 'transcript.txt')}\n---\n${transcript}`,
    )
    return 0
  }

  // 2. A model answers (or, failing that, the transcript is handed over).
  const asking = req.ask !== undefined
  const model = req.model || config.gemini.videoModel
  const label = asking ? 'answer' : 'review'
  const tag = createHash('sha1')
    .update(JSON.stringify([req.ask ?? '', req.range ?? '', model, req.resolution ?? '']))
    .digest('hex')
    .slice(0, 10)
  const base = asking
    ? join(dir, 'asks', tag)
    : join(dir, req.range || req.model || req.resolution ? `review-${tag}` : 'review')
  mkdirSync(join(dir, 'asks'), { recursive: true })
  const prior = readJson<Answer>(`${base}.json`)
  const limit = asking ? config.output.askWords : config.output.reviewWords
  const show = (text: string, answer: Answer, cached: boolean, at = base) => {
    const sources =
      answer.mode === 'captions'
        ? `captions only, read by ${answer.model} (it did not see the video)`
        : `Gemini watched the video (${answer.model})${answer.mode === 'video+captions' ? ` with ${captionLine} attached` : `; ${captionLine}`}`
    out(
      [
        ...head,
        `Source: ${sources}${cached ? `   [cached ${answer.created.slice(0, 16).replace('T', ' ')} UTC]` : ''}`,
        ...(answer.note ? [`Note: ${answer.note}`] : []),
        `${cached ? '' : `Cost: ${k(answer.usage.prompt)} tokens in, ${k(answer.usage.output)} out${answer.usage.thoughts ? `, ${k(answer.usage.thoughts)} thinking` : ''}; ${answer.seconds.toFixed(0)} s.   `}Files: ${[`${at}.md`, ...files].join(', ')}`,
        '---',
        cap(text, limit, `${at}.md`),
      ].join('\n'),
    )
  }
  if (prior && !req.refresh && prior.mode !== 'captions' && existsSync(`${base}.md`)) {
    show(readFileSync(`${base}.md`, 'utf8'), prior, true)
    return 0
  }

  const info = [
    `Title: ${stored.title ?? 'unknown'}`,
    `Channel: ${stored.channel ?? 'unknown'}`,
    `Duration: ${stored.duration ? clock(stored.duration) : 'unknown'}`,
    ...(stored.chapters?.length
      ? [`Chapters: ${stored.chapters.map((c) => `${clock(c.start)} ${c.title}`).join('; ')}`]
      : []),
    ...(stored.description ? [`Description (cut): ${stored.description}`] : []),
    ...(range
      ? [
          `Only the part from ${clock(range.start)} to ${range.end === null ? 'the end' : clock(range.end)} is in scope. Timestamps are always minutes:seconds from the start of the full video.`,
        ]
      : []),
  ].join('\n')
  const captionText = slice.length
    ? `Captions (${stored.captions.kind === 'manual' ? 'written by hand' : 'auto-generated, may mishear names and terms'}; [mm:ss] is the start of each paragraph):\n${transcript}`
    : 'No captions are available; rely on the audio and the picture.'
  const question = asking ? `Question: ${req.ask}` : ''
  const instructions = (asking ? config.prompts.ask : config.prompts.review).join('\n')
  const fallbackInstructions = (
    asking ? config.prompts.askCaptionsOnly : config.prompts.reviewCaptionsOnly
  ).join('\n')
  const videoPart: Part = {
    file_data: { file_uri: url },
    ...(range
      ? {
          video_metadata: {
            start_offset: `${range.start}s`,
            ...(range.end === null ? {} : { end_offset: `${range.end}s` }),
          },
        }
      : {}),
  }
  const resolution =
    config.gemini.mediaResolution[req.resolution ?? (config.gemini.defaultResolution as Resolution)]
  const options = { env: deps.env, post: deps.post, store: deps.store, sleep: deps.sleep }

  let result: Generated | null = null
  let mode: Answer['mode'] = 'video+captions'
  let note: string | null = null
  let started = Date.now()
  err(
    `aico video: ${model} is watching the video; the first run usually takes 2-4 minutes (run long commands in the background).\n`,
  )
  try {
    result = await generate(
      model,
      [
        videoPart,
        { text: [instructions, info, captionText, question].filter(Boolean).join('\n\n') },
      ],
      { ...options, resolution },
    )
    mode = slice.length ? 'video+captions' : 'video'
  } catch (error) {
    const failed = error as GeminiError
    note = `Gemini could not watch the video: ${failed.message}`
    if (slice.length && failed.kind !== 'no-key') {
      err(`aico video: ${note}; trying the captions alone...\n`)
      started = Date.now()
      try {
        result = await generate(
          config.gemini.textModel,
          [
            {
              text: [fallbackInstructions, info, captionText, question]
                .filter(Boolean)
                .join('\n\n'),
            },
          ],
          options,
        )
        mode = 'captions'
        note = `${note}. This ${label} comes from the captions alone: nothing on screen was seen.`
      } catch (second) {
        note = `${note}; the captions-only call failed too: ${(second as Error).message}`
      }
    }
  }
  if (!result) {
    if (slice.length) {
      out(
        `${head.join('\n')}\nNo ${label}: ${note}\nThe cleaned transcript is on disk, read it yourself: ${join(dir, 'transcript.txt')} (${k(words(transcript))} words${range ? ' in range; whole video in that file' : ''}).`,
      )
      return 0
    }
    err(
      `aico video: no captions and Gemini failed. Captions: ${stored.captions.note ?? 'none'}. ${note}\n`,
    )
    return 1
  }
  const answer: Answer = {
    mode,
    model: result.model,
    key: result.key,
    usage: result.usage,
    seconds: (Date.now() - started) / 1000,
    created: deps.now().toISOString(),
    note,
  }
  const text = asking ? `**Q: ${req.ask}**\n\n${result.text}\n` : `${result.text}\n`
  // A captions-only result never replaces a video review: it gets its own files.
  const at = mode === 'captions' ? `${base}-captions` : base
  if (mode === 'captions' && prior && prior.mode !== 'captions' && existsSync(`${base}.md`))
    answer.note = `${answer.note} An earlier answer from the video is still on disk: ${base}.md`
  writeFileSync(`${at}.md`, text)
  writeJson(`${at}.json`, { ...answer, ask: req.ask ?? null, range: req.range ?? null })
  show(text, answer, false, at)
  return 0
}

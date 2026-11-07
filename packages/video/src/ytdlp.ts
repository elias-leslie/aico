// yt-dlp supplies the metadata and the caption file; nothing is downloaded but those.
import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type CaptionPick, pickCaptions } from './captions'
import { config } from './config'

export type Exec = (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
export const exec: Exec = (argv) =>
  new Promise((done) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '',
      stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d
    })
    child.stderr.on('data', (d) => {
      stderr += d
    })
    child.on('error', (error) => done({ code: 127, stdout, stderr: error.message }))
    child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }))
  })

export interface VideoMeta {
  id: string
  url: string
  title: string | null
  channel: string | null
  duration: number | null
  uploaded: string | null
  description: string
  chapters: { start: number; title: string }[]
}
export interface Fetched {
  meta: Partial<VideoMeta>
  captions: { pick: CaptionPick; vtt: string } | null
  /** Why there is no metadata or no captions, in a line an agent can pass on. */
  note: string | null
}

/** yt-dlp's last ERROR line, or its first line of output when it printed none. */
const failure = (stderr: string) => {
  const lines = stderr.split('\n').filter((l) => l.trim())
  return (lines.reverse().find((l) => l.startsWith('ERROR')) ?? lines[0] ?? 'no output')
    .replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '')
    .slice(0, 300)
}

export async function fetchCaptions(
  id: string,
  url: string,
  dir: string,
  lang: string,
  run: Exec,
): Promise<Fetched> {
  mkdirSync(dir, { recursive: true })
  const { code, stderr } = await run([
    config.ytdlp.command,
    ...config.ytdlp.args,
    '--write-info-json',
    '--write-subs',
    '--write-auto-subs',
    '--sub-langs',
    config.ytdlp.subLangs.map((l) => l.replaceAll('{lang}', lang)).join(','),
    '--sub-format',
    'vtt',
    '-o',
    join(dir, id),
    url,
  ])
  const infoFile = join(dir, `${id}.info.json`)
  let info: Record<string, any> = {}
  try {
    info = JSON.parse(readFileSync(infoFile, 'utf8'))
  } catch {
    return {
      meta: {},
      captions: null,
      note:
        code === 127
          ? `${config.ytdlp.command} is not available (${stderr.trim()})`
          : `${config.ytdlp.command} could not read the video: ${failure(stderr)}`,
    }
  }
  const meta: Partial<VideoMeta> = {
    title: info.title ?? null,
    channel: info.channel ?? info.uploader ?? null,
    duration: typeof info.duration === 'number' ? info.duration : null,
    uploaded: typeof info.upload_date === 'string' ? info.upload_date : null,
    description: String(info.description ?? '').slice(0, config.descriptionChars),
    chapters: Array.isArray(info.chapters)
      ? info.chapters.map((c: any) => ({ start: Number(c.start_time), title: String(c.title) }))
      : [],
  }
  const files = readdirSync(dir).filter((f) => f.startsWith(`${id}.`) && f.endsWith('.vtt'))
  const pick = pickCaptions(info, files, lang)
  if (!pick) {
    const reason = code !== 0 ? `; ${config.ytdlp.command} said: ${failure(stderr)}` : ''
    return { meta, captions: null, note: `no ${lang} captions found${reason}` }
  }
  const vtt = readFileSync(join(dir, pick.file), 'utf8')
  return { meta, captions: { pick, vtt }, note: null }
}

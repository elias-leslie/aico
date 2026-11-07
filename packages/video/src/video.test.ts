import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LoginStore } from '@aico/fleet/logins'
import { beforeEach, describe, expect, it } from 'vitest'
import { runVideoCli } from './cli'
import { config } from './config'
import type { Post } from './gemini'
import type { Exec } from './ytdlp'

const SECRET = 'AIza-test-secret-key'
const ID = 'nl3bSrUfvXQ'
const rolling = readFileSync(new URL('./fixtures/rolling.en-orig.vtt', import.meta.url), 'utf8')

/** yt-dlp stand-in: writes the info.json and caption files yt-dlp would, next to the -o template. */
const ytdlp = (options: { captions?: boolean; fail?: boolean } = {}) => {
  const calls: string[][] = []
  const exec: Exec = async (argv) => {
    calls.push(argv)
    if (options.fail) return { code: 1, stdout: '', stderr: 'ERROR: [youtube] x: Private video' }
    const base = argv[argv.indexOf('-o') + 1]
    writeFileSync(
      `${base}.info.json`,
      JSON.stringify({
        title: 'Why I am rethinking my setup',
        channel: 'Web Dev Cody',
        duration: 1053,
        upload_date: '20261107',
        description: 'desc',
        chapters: [{ start_time: 0, title: 'Intro' }],
        subtitles: {},
      }),
    )
    if (options.captions !== false) {
      writeFileSync(`${base}.en-orig.vtt`, rolling)
      writeFileSync(`${base}.en.vtt`, 'WEBVTT\n')
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { exec, calls }
}

interface Sent {
  url: string
  headers: Record<string, string>
  body: any
}
const gemini = (answers: ((sent: Sent) => { status: number; text: string })[]) => {
  const sent: Sent[] = []
  const post: Post = async (url, headers, body) => {
    const entry = { url, headers, body: JSON.parse(body) }
    sent.push(entry)
    return answers[Math.min(sent.length - 1, answers.length - 1)](entry)
  }
  return { post, sent }
}
const ok =
  (text: string, model = 'gemini-test-1') =>
  () => ({
    status: 200,
    text: JSON.stringify({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: {
        promptTokenCount: 96000,
        candidatesTokenCount: 900,
        thoughtsTokenCount: 200,
      },
      modelVersion: model,
    }),
  })
const failure = (status: number, message: string) => () => ({
  status,
  text: JSON.stringify({ error: { message } }),
})

let dir: string
let out: string[]
let err: string[]
let waits: number[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'video-test-'))
  out = []
  err = []
  waits = []
})
const go = (
  argv: string[],
  fakes: { exec: Exec; post?: Post; store?: () => LoginStore },
  env: NodeJS.ProcessEnv = { GEMINI_API_KEY: SECRET },
) =>
  runVideoCli(argv, {
    env: { AICO_VIDEO_DIR: dir, ...env },
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    exec: fakes.exec,
    post: fakes.post,
    store:
      fakes.store ??
      (() => {
        throw new Error('no logins here')
      }),
    now: () => new Date('2026-11-07T15:00:00Z'),
    sleep: async (ms) => {
      waits.push(ms)
    },
  })
const stdout = () => out.join('\n')

describe('aico video review', () => {
  it('has Gemini watch the video with the cleaned captions attached, and caches it', async () => {
    const yt = ytdlp()
    const g = gemini([ok('## What it is\nA talk. [00:16] point')])
    expect(await go([`https://youtu.be/${ID}`], { exec: yt.exec, post: g.post })).toBe(0)

    const request = g.sent[0]
    expect(request.url).toContain(`/models/${config.gemini.videoModel}:generateContent`)
    expect(request.headers['x-goog-api-key']).toBe(SECRET)
    expect(request.body.contents[0].parts[0].file_data.file_uri).toBe(
      `https://www.youtube.com/watch?v=${ID}`,
    )
    expect(request.body.generationConfig.mediaResolution).toBe('MEDIA_RESOLUTION_LOW')
    const prompt: string = request.body.contents[0].parts[1].text
    expect(prompt).toContain(
      "[00:00] So, I'm kind of obsessed with building my own agent coding tools.",
    )
    expect(prompt).toContain('Chapters: 00:00 Intro')
    expect(yt.calls[0]).toEqual(
      expect.arrayContaining(['--js-runtimes', 'node', '--write-auto-subs']),
    )

    const shown = stdout()
    expect(shown).toContain('Title: Why I am rethinking my setup')
    expect(shown).toContain('Published: 2026-11-07')
    expect(shown).toContain(
      'Gemini watched the video (gemini-test-1) with captions (en-orig, auto-generated',
    )
    expect(shown).toContain('96.0K tokens in')
    expect(shown).toContain(join(dir, ID, 'review.md'))
    expect(shown).toContain('A talk. [00:16] point')
    expect(shown + err.join('')).not.toContain(SECRET)
    expect(readdirSync(join(dir, ID)).sort()).toEqual(
      expect.arrayContaining([
        'asks',
        'cues.json',
        'meta.json',
        'review.json',
        'review.md',
        'transcript.txt',
      ]),
    )
    expect(readFileSync(join(dir, ID, 'transcript.txt'), 'utf8')).toMatch(/^\[00:00\] So, I'm kind/)

    out.length = 0
    expect(await go([ID], { exec: yt.exec, post: g.post })).toBe(0)
    expect(g.sent).toHaveLength(1)
    expect(yt.calls).toHaveLength(1)
    expect(stdout()).toContain('[cached 2026-11-07 15:00 UTC]')
  })

  it('tries the next stored key when one is rate limited', async () => {
    const g = gemini([failure(429, 'quota'), ok('fine')])
    const store = () =>
      ({ value: (name: string) => Buffer.from(`key-of-${name}\n`) }) as unknown as LoginStore
    expect(await go([ID], { exec: ytdlp().exec, post: g.post, store }, {})).toBe(0)
    expect(g.sent.map((s) => s.headers['x-goog-api-key'])).toEqual([
      `key-of-${config.gemini.loginNames[0]}`,
      `key-of-${config.gemini.loginNames[1]}`,
    ])
    expect(stdout()).toContain('Gemini watched the video')
    expect(stdout() + err.join('')).not.toContain('key-of-')
  })

  it('falls back to a captions-only review and says so', async () => {
    const g = gemini([failure(400, 'The video is private'), ok('captions review', 'lite-1')])
    expect(await go([ID], { exec: ytdlp().exec, post: g.post })).toBe(0)
    expect(g.sent[1].url).toContain(config.gemini.textModel)
    expect(JSON.stringify(g.sent[1].body)).not.toContain('file_data')
    const shown = stdout()
    expect(shown).toContain('captions only, read by lite-1 (it did not see the video)')
    expect(shown).toContain(
      'Gemini could not watch the video: Gemini 400 ($GEMINI_API_KEY): The video is private',
    )
    expect(shown).toContain('nothing on screen was seen')
    // A captions-only review is not kept as the video's review: the next run tries Gemini again.
    out.length = 0
    const again = gemini([ok('now with video')])
    await go([ID], { exec: ytdlp().exec, post: again.post })
    expect(again.sent).toHaveLength(1)
    expect(stdout()).toContain('now with video')
  })

  it('retries a busy Gemini (503) after a pause, then succeeds', async () => {
    const g = gemini([failure(503, 'high demand'), failure(503, 'high demand'), ok('third time')])
    expect(await go([ID], { exec: ytdlp().exec, post: g.post })).toBe(0)
    expect(g.sent).toHaveLength(3)
    expect(waits).toEqual(config.gemini.retry.waitSeconds.map((n) => n * 1000))
    expect(stdout()).toContain('third time')
  })

  it('keeps a video review when a later --refresh can only manage captions', async () => {
    await go([ID], { exec: ytdlp().exec, post: gemini([ok('the real review')]).post })
    out.length = 0
    const g = gemini([failure(400, 'nope'), ok('weaker review')])
    await go([ID, '--refresh'], { exec: ytdlp().exec, post: g.post })
    expect(stdout()).toContain(
      `An earlier answer from the video is still on disk: ${join(dir, ID, 'review.md')}`,
    )
    expect(readFileSync(join(dir, ID, 'review.md'), 'utf8')).toBe('the real review\n')
    expect(readFileSync(join(dir, ID, 'review-captions.md'), 'utf8')).toBe('weaker review\n')
  })

  it('cuts long output by words without flattening its layout', async () => {
    const long = `## A\n${Array.from({ length: 800 }, (_, i) => `w${i}`).join(' ')}\n\n## B\nend`
    await go([ID], { exec: ytdlp().exec, post: gemini([ok(long)]).post })
    const shown = stdout()
    expect(shown).toContain('## A\nw0 w1')
    expect(shown).toContain(
      `(cut at ${config.output.reviewWords} words; the full text is in ${join(dir, ID, 'review.md')})`,
    )
    expect(shown).not.toContain('w799')
    expect(readFileSync(join(dir, ID, 'review.md'), 'utf8')).toContain('w799')
  })

  it('hands over the transcript path when there is no Gemini at all', async () => {
    expect(await go([ID], { exec: ytdlp().exec }, {})).toBe(0)
    const shown = stdout()
    expect(shown).toContain('No review: Gemini could not watch the video: no Gemini key')
    expect(shown).toContain(join(dir, ID, 'transcript.txt'))
  })

  it('lets Gemini watch alone when there are no captions', async () => {
    const g = gemini([ok('picture only')])
    expect(await go([ID], { exec: ytdlp({ captions: false }).exec, post: g.post })).toBe(0)
    expect(g.sent[0].body.contents[0].parts[1].text).toContain('No captions are available')
    expect(stdout()).toContain(
      'Gemini watched the video (gemini-test-1); no captions (no en captions found)',
    )
  })

  it('exits 1 saying so when there are no captions and Gemini fails', async () => {
    const g = gemini([failure(500, 'boom')])
    expect(await go([ID], { exec: ytdlp({ captions: false }).exec, post: g.post })).toBe(1)
    expect(err.join('')).toContain('no captions and Gemini failed')
  })

  it('still asks Gemini when yt-dlp cannot read the video', async () => {
    const g = gemini([ok('from the video alone')])
    expect(await go([ID], { exec: ytdlp({ fail: true }).exec, post: g.post })).toBe(0)
    expect(stdout()).toContain('Title: (unknown: metadata unavailable)')
    expect(stdout()).toContain('no captions (yt-dlp could not read the video: x: Private video)')
  })
})

describe('aico video --ask, --transcript, --range', () => {
  it('answers a question on the clip named by --range, with only that part of the captions', async () => {
    const g = gemini([ok('A dashboard.')])
    const code = await go(['--ask', "what's on screen?", '--range', '0:10-0:17', ID], {
      exec: ytdlp().exec,
      post: g.post,
    })
    expect(code).toBe(0)
    const parts = g.sent[0].body.contents[0].parts
    expect(parts[0].video_metadata).toEqual({ start_offset: '10s', end_offset: '17s' })
    expect(parts[1].text).toContain("what's on screen?")
    expect(parts[1].text).toContain('from 00:10 to 00:17')
    expect(parts[1].text).toContain('[00:10] ')
    expect(parts[1].text).not.toContain('obsessed')
    expect(stdout()).toContain("**Q: what's on screen?**")
    const ask = readdirSync(join(dir, ID, 'asks'))
    expect(ask.sort()).toHaveLength(2)

    out.length = 0
    await go(['--ask', "what's on screen?", '--range', '0:10-0:17', ID], {
      exec: ytdlp().exec,
      post: g.post,
    })
    expect(g.sent).toHaveLength(1)
  })

  it('answers from the captions alone when the video cannot be watched', async () => {
    const g = gemini([failure(400, 'cannot process'), ok('He says X at 00:03.')])
    await go(['--ask', 'who?', ID], { exec: ytdlp().exec, post: g.post })
    expect(g.sent[1].body.contents[0].parts[0].text).toContain('from its captions only')
    expect(stdout()).toContain('He says X')
    expect(stdout()).toContain('This answer comes from the captions alone')
  })

  it('prints the cleaned transcript for a range without calling a model', async () => {
    const g = gemini([ok('never')])
    expect(
      await go(['--transcript', '--range', '0:06-0:17', ID], { exec: ytdlp().exec, post: g.post }),
    ).toBe(0)
    expect(g.sent).toHaveLength(0)
    expect(stdout()).toMatch(/---\n\[00:07\] /)
    expect(stdout()).not.toContain('obsessed')
    expect(stdout()).toContain('Source: captions (en-orig')
  })

  it('refuses --transcript with no captions, and bad input', async () => {
    expect(await go(['--transcript', ID], { exec: ytdlp({ captions: false }).exec })).toBe(1)
    expect(err.join('')).toContain('no captions for this video')
    expect(await go(['not a link'], { exec: ytdlp().exec })).toBe(2)
    expect(await go(['--range', '5:00-1:00', ID], { exec: ytdlp().exec })).toBe(2)
    expect(await go(['--ask', 'x', '--transcript', ID], { exec: ytdlp().exec })).toBe(2)
    expect(await go(['--resolution', 'ultra', ID], { exec: ytdlp().exec })).toBe(2)
  })

  it('prints its own help', async () => {
    expect(await go(['--help'], { exec: ytdlp().exec })).toBe(0)
    expect(stdout()).toMatch(/^Usage: aico video URL/)
  })
})

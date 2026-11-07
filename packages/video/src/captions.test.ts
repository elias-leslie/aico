import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { inWindow, parseVtt, pickCaptions, renderTranscript } from './captions'
import { parseRange, videoId } from './url'

// The first ~18 s of a real auto-caption file: rolling two-line cues with word timing tags and
// 10 ms cues that only repeat the previous line.
const rolling = readFileSync(new URL('./fixtures/rolling.en-orig.vtt', import.meta.url), 'utf8')

describe('parseVtt', () => {
  it('turns rolling auto-captions into each line once, at the cue that first shows it', () => {
    const cues = parseVtt(rolling)
    expect(cues.slice(0, 4)).toEqual([
      { t: 0.08, text: "So, I'm kind of obsessed with building" },
      { t: 1.839, text: "my own agent coding tools. I don't know" },
      { t: 3.439, text: "why. There's like a million out there" },
      { t: 4.72, text: 'that probably can achieve exactly what I' },
    ])
    const lines = cues.map((c) => c.text)
    expect(new Set(lines).size).toBe(lines.length)
    expect(lines.join(' ')).toContain("that's something I spent a lot of time doing. For example")
    expect(rolling).toContain('<c>')
    expect(lines.join('')).not.toMatch(/[<>]|\d\d:\d\d:\d\d/)
  })

  it('keeps a repeated line when the cue chain is broken, decodes entities, skips blank cues', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:02.000
No.

00:00:05.000 --> 00:00:06.000
No.

00:00:06.000 --> 00:00:07.000
Tom &amp; Jerry &gt; the rest&nbsp;of it

00:00:08.000 --> 00:00:09.000
 `
    expect(parseVtt(vtt)).toEqual([
      { t: 1, text: 'No.' },
      { t: 5, text: 'No.' },
      { t: 6, text: 'Tom & Jerry > the rest of it' },
    ])
  })
})

describe('renderTranscript', () => {
  const cues = [
    { t: 0, text: 'a' },
    { t: 30, text: 'b' },
    { t: 61, text: 'c' },
    { t: 3725, text: 'd' },
  ]
  it('starts a [mm:ss] paragraph about every minute, with hours once the video passes one', () => {
    expect(renderTranscript(cues.slice(0, 3), 60)).toBe('[00:00] a b\n\n[01:01] c')
    expect(renderTranscript(cues, 60)).toBe('[0:00:00] a b\n\n[0:01:01] c\n\n[1:02:05] d')
  })
  it('slices by range and labels the slice from its own first line', () => {
    expect(renderTranscript(inWindow(cues, { start: 30, end: 100 }), 60)).toBe('[00:30] b c')
    expect(inWindow(cues, parseRange('1:00-'))).toHaveLength(2)
  })
})

describe('pickCaptions', () => {
  const files = ['x.en.vtt', 'x.en-orig.vtt', 'x.fr.vtt']
  it('prefers the original-language automatic track over the translation', () => {
    expect(pickCaptions({ automatic_captions: {} }, files, 'en')).toEqual({
      file: 'x.en-orig.vtt',
      lang: 'en-orig',
      kind: 'auto',
    })
  })
  it('prefers hand-written captions over automatic ones', () => {
    expect(pickCaptions({ subtitles: { en: [] } }, files, 'en')).toMatchObject({
      file: 'x.en.vtt',
      kind: 'manual',
    })
  })
  it('returns null when the language is missing', () => {
    expect(pickCaptions({}, ['x.fr.vtt'], 'en')).toBeNull()
  })
})

describe('links and ranges', () => {
  it.each([
    ['https://youtu.be/nl3bSrUfvXQ', 'nl3bSrUfvXQ'],
    ['https://www.youtube.com/watch?v=nl3bSrUfvXQ&t=90s&list=PL1', 'nl3bSrUfvXQ'],
    ['https://youtube.com/shorts/nl3bSrUfvXQ?feature=share', 'nl3bSrUfvXQ'],
    ['m.youtube.com/live/nl3bSrUfvXQ', 'nl3bSrUfvXQ'],
    ['nl3bSrUfvXQ', 'nl3bSrUfvXQ'],
    ['https://example.com/watch?v=nl3bSrUfvXQ', null],
    ['https://www.youtube.com/', null],
  ])('reads the id from %s', (input, id) => expect(videoId(input)).toBe(id))

  it('parses ranges and refuses bad ones', () => {
    expect(parseRange('2:00-4:30')).toEqual({ start: 120, end: 270 })
    expect(parseRange('90-')).toEqual({ start: 90, end: null })
    expect(parseRange('-1:00:00')).toEqual({ start: 0, end: 3600 })
    expect(() => parseRange('4:00-2:00')).toThrow(/not after/)
    expect(() => parseRange('2:00')).toThrow(/START-END/)
    expect(() => parseRange('a-b')).toThrow(/not a time/)
  })
})

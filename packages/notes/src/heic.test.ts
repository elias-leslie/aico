import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePreview, PREVIEW_MAX_PX, type Runner } from './heic'

const JPEG = (tag: string) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag)])

describe('makePreview', () => {
  let dir: string
  let calls: string[][]
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aico-heic-'))
    calls = []
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  /** Writes `tag` to the last argument, as heif-convert and ImageMagick do. */
  const writes =
    (tag: string, gone: string[] = []): Runner =>
    async (argv) => {
      calls.push(argv)
      if (gone.includes(argv[0] as string))
        throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
      writeFileSync(argv.at(-1) as string, JPEG(tag))
      return 0
    }

  it('scales the converted picture to 2000 px on its long edge and keeps that one', async () => {
    const dst = join(dir, 'p.preview.jpg')
    expect(await makePreview(writes('small'), 'in.heic', dst)).toBe(true)
    expect(calls.map((c) => c[0])).toEqual(['heif-convert', 'magick'])
    expect(calls[1]).toContain(`${PREVIEW_MAX_PX}x${PREVIEW_MAX_PX}>`)
    expect(readFileSync(dst).subarray(4).toString()).toBe('small')
  })

  it('uses convert when there is no magick', async () => {
    const dst = join(dir, 'p.preview.jpg')
    expect(await makePreview(writes('small', ['magick']), 'in.heic', dst)).toBe(true)
    expect(calls.map((c) => c[0])).toEqual(['heif-convert', 'magick', 'convert'])
    expect(readFileSync(dst).subarray(4).toString()).toBe('small')
  })

  it('keeps the full-size preview when ImageMagick is missing', async () => {
    const dst = join(dir, 'p.preview.jpg')
    const runner: Runner = async (argv) => {
      calls.push(argv)
      if (argv[0] !== 'heif-convert')
        throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
      writeFileSync(argv.at(-1) as string, JPEG('full'))
      return 0
    }
    expect(await makePreview(runner, 'in.heic', dst)).toBe(true)
    expect(readFileSync(dst).subarray(4).toString()).toBe('full')
  })

  it('keeps the full-size preview when the scaler fails or writes something else', async () => {
    const dst = join(dir, 'p.preview.jpg')
    const runner: Runner = async (argv) => {
      calls.push(argv)
      if (argv[0] === 'heif-convert') {
        writeFileSync(argv.at(-1) as string, JPEG('full'))
        return 0
      }
      writeFileSync(argv.at(-1) as string, 'not a jpeg')
      return 0
    }
    expect(await makePreview(runner, 'in.heic', dst)).toBe(true)
    expect(readFileSync(dst).subarray(4).toString()).toBe('full')
  })

  it('makes no preview when the converter fails', async () => {
    const dst = join(dir, 'p.preview.jpg')
    expect(await makePreview(async () => 1, 'in.heic', dst)).toBe(false)
  })
})

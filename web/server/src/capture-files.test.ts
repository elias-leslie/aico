import { describe, expect, it } from 'vitest'
import {
  acceptString,
  captureTypes,
  isInlineMime,
  needsPreview,
  sniffCapture,
} from './capture-files'

const bytes = (...parts: (string | number[])[]) =>
  Buffer.concat(
    parts.map((part) =>
      typeof part === 'string' ? Buffer.from(part, 'latin1') : Buffer.from(part),
    ),
  )

const ftyp = (brand: string) => bytes([0, 0, 0, 0x18], 'ftyp', brand, [0, 0, 0, 0], 'mif1heic')

/** A sample that should sniff as each row of the table, by extension. */
const SAMPLES: Record<string, Buffer> = {
  jpg: bytes([0xff, 0xd8, 0xff, 0xe0], 'JFIF'),
  jpeg: bytes([0xff, 0xd8, 0xff, 0xe1], 'Exif'),
  png: bytes([0x89], 'PNG\r\n', [0x1a, 0x0a], 'IHDR'),
  gif: bytes('GIF89a', [1, 0, 1, 0]),
  webp: bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '),
  heic: ftyp('heic'),
  heif: ftyp('mif1'),
  pdf: bytes('%PDF-1.7\n'),
  txt: Buffer.from('plain text, with ünïcode', 'utf8'),
  md: bytes('# Title\n\n- item'),
  csv: bytes('a,b\n1,2\n'),
  json: bytes('{"a":1}'),
  docx: bytes('PK', [3, 4], 'word/'),
  xlsx: bytes('PK', [3, 4], 'xl/'),
  odt: bytes('PK', [3, 4], 'mimetype'),
  ods: bytes('PK', [3, 4], 'mimetype'),
  m4a: ftyp('M4A '),
  mp3: bytes('ID3', [4, 0]),
  ogg: bytes('OggS', [0, 2]),
  webm: bytes([0x1a, 0x45, 0xdf, 0xa3], 'xx'),
  wav: bytes('RIFF', [0, 0, 0, 0], 'WAVEfmt '),
}

describe('the accepted-types table', () => {
  it('sniffs a sample for every row, by extension and with no claim', () => {
    for (const type of captureTypes()) {
      const sample = SAMPLES[type.ext]
      expect(sample, `a sample for .${type.ext}`).toBeDefined()
      const found = sniffCapture(sample as Buffer, `file.${type.ext.toUpperCase()}`, '')
      expect(found, type.ext).toEqual(type)
    }
    expect(Object.keys(SAMPLES).sort()).toEqual(
      captureTypes()
        .map((type) => type.ext)
        .sort(),
    )
  })

  it('uses the claimed type when the name has no extension', () => {
    expect(sniffCapture(SAMPLES.jpg as Buffer, 'image', 'image/jpeg')?.mime).toBe('image/jpeg')
    expect(sniffCapture(SAMPLES.pdf as Buffer, 'scan', 'application/pdf; x=y')?.kind).toBe('pdf')
    expect(sniffCapture(SAMPLES.pdf as Buffer, 'scan', 'application/x-msdownload')).toBeNull()
  })

  it('refuses a renamed program and a PDF that claims to be a JPEG', () => {
    const program = bytes('MZ', [0x90, 0, 3, 0], 'This program')
    expect(sniffCapture(program, 'photo.jpg', 'image/jpeg')).toBeNull()
    expect(sniffCapture(program, 'setup.exe', 'application/octet-stream')).toBeNull()
    expect(sniffCapture(SAMPLES.pdf as Buffer, 'photo.jpg', 'image/jpeg')).toBeNull()
    expect(sniffCapture(SAMPLES.pdf as Buffer, 'photo', 'image/jpeg')).toBeNull()
    expect(sniffCapture(SAMPLES.jpg as Buffer, 'doc.pdf', 'application/pdf')).toBeNull()
    expect(sniffCapture(bytes('<html>'), 'page.html', 'text/html')).toBeNull()
  })

  it('takes the HEIC brands the spec lists, and refuses other ISO files', () => {
    for (const brand of ['heic', 'heix', 'hevc', 'mif1', 'msf1'])
      expect(sniffCapture(ftyp(brand), 'IMG_1.HEIC', 'image/heic'), brand).not.toBeNull()
    expect(sniffCapture(ftyp('qt  '), 'IMG_1.heic', '')).toBeNull()
    expect(sniffCapture(bytes([0, 0, 0, 8], 'free'), 'IMG_1.heic', '')).toBeNull()
    expect(sniffCapture(bytes([0, 0, 0, 8], 'ftyp'), 'IMG_1.heic', '')).toBeNull()
  })

  it('wants text to be UTF-8 with no NUL bytes', () => {
    expect(sniffCapture(bytes([0xff, 0xfe, 0x41, 0x80]), 'a.txt', 'text/plain')).toBeNull()
    expect(sniffCapture(bytes('ok', [0], 'no'), 'a.txt', 'text/plain')).toBeNull()
    expect(sniffCapture(bytes([0xef, 0xbb, 0xbf], 'bom'), 'a.csv', '')).not.toBeNull()
  })

  it('gives the page an accept string from the same table', () => {
    const accept = acceptString()
    expect(accept).toContain('image/heic')
    expect(accept).toContain('.heic')
    expect(accept).toContain('.pdf')
    expect(accept).not.toContain('.exe')
    expect(accept.split(',').length).toBeGreaterThan(captureTypes().length)
  })

  it('renders only four image types inline and previews HEIF', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
      expect(isInlineMime(mime)).toBe(true)
    for (const mime of ['image/heic', 'application/pdf', 'text/plain', 'image/svg+xml'])
      expect(isInlineMime(mime)).toBe(false)
    expect(needsPreview('image/heic')).toBe(true)
    expect(needsPreview('image/jpeg')).toBe(false)
  })
})

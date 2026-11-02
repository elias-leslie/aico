// What a capture may be: the accepted-types table is data (capture-file-types.json:
// extension, mime, kind, magic bytes). The server sniffs uploads with it, and
// GET /api/captures/limits hands the same rows to the page, so the file input's
// `accept` string never drifts from what the server takes.

import table from './capture-file-types.json'

export type CaptureKind = 'image' | 'pdf' | 'doc' | 'text' | 'audio'

interface ByteCheck {
  at: number
  hex?: string
  ascii?: string
}

interface TypeRow {
  ext: string
  mime: string
  kind: CaptureKind
  /** Alternatives; each is a list of checks that must all match. */
  magic?: ByteCheck[][]
  /** An ISO base-media file whose major brand is in `ftypBrands[ftyp]`. */
  ftyp?: string
  /** Valid UTF-8 with no NUL bytes; the extension decides the type. */
  text?: boolean
}

export interface CaptureType {
  ext: string
  mime: string
  kind: CaptureKind
}

export interface CaptureFileTable {
  types: TypeRow[]
  ftypBrands: Record<string, string[]>
}

const DEFAULT_TABLE = table as unknown as CaptureFileTable

/** The types the page may offer: one row per extension. */
export function captureTypes(files: CaptureFileTable = DEFAULT_TABLE): CaptureType[] {
  return files.types.map(({ ext, mime, kind }) => ({ ext, mime, kind }))
}

/** The `accept` string for a file input: every mime type, then every extension. */
export function acceptString(files: CaptureFileTable = DEFAULT_TABLE): string {
  const mimes = [...new Set(files.types.map((type) => type.mime))]
  return [...mimes, ...files.types.map((type) => `.${type.ext}`)].join(',')
}

function checkMatches(bytes: Uint8Array, check: ByteCheck): boolean {
  const expected =
    check.hex !== undefined
      ? Buffer.from(check.hex, 'hex')
      : Buffer.from(check.ascii ?? '', 'latin1')
  if (expected.length === 0 || bytes.length < check.at + expected.length) return false
  return Buffer.from(bytes.buffer, bytes.byteOffset + check.at, expected.length).equals(expected)
}

function validText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

function matches(row: TypeRow, bytes: Uint8Array, files: CaptureFileTable): boolean {
  if (row.text) return validText(bytes)
  if (row.ftyp) {
    const brands = files.ftypBrands[row.ftyp] ?? []
    return (
      checkMatches(bytes, { at: 4, ascii: 'ftyp' }) &&
      bytes.length >= 12 &&
      brands.includes(Buffer.from(bytes.subarray(8, 12)).toString('latin1'))
    )
  }
  return (row.magic ?? []).some((alternative) =>
    alternative.every((check) => checkMatches(bytes, check)),
  )
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * The type the content proves, or null. The file's extension picks the row to
 * check (its claimed type, when the name has no known extension); the bytes
 * then have to match that row, so a renamed program or a PDF named .jpg is
 * refused. Zip-based documents are only checked by zip magic and extension: they are
 * downloaded, never opened or rendered.
 */
export function sniffCapture(
  bytes: Uint8Array,
  name: string,
  claimedMime: string,
  files: CaptureFileTable = DEFAULT_TABLE,
): CaptureType | null {
  const ext = extensionOf(name)
  const claimed = claimedMime.split(';')[0]?.trim().toLowerCase() ?? ''
  const row =
    files.types.find((type) => type.ext === ext) ??
    (ext ? undefined : files.types.find((type) => type.mime === claimed))
  if (!row || !matches(row, bytes, files)) return null
  return { ext: row.ext, mime: row.mime, kind: row.kind }
}

/** Only these render inside the page; everything else downloads. */
const INLINE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

export const isInlineMime = (mime: string): boolean => INLINE_MIMES.has(mime)

/** ISO files whose preview the server makes (HEIC and HEIF). */
export const needsPreview = (mime: string): boolean =>
  mime === 'image/heic' || mime === 'image/heif'

/** The usual extension for a mime type (`image/jpeg` is `jpg`), or null. */
export function extensionForMime(
  mime: string,
  files: CaptureFileTable = DEFAULT_TABLE,
): string | null {
  return files.types.find((type) => type.mime === mime)?.ext ?? null
}

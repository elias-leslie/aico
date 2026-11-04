// Reading a transcript without loading it. A transcript is JSONL that grows
// while its tool runs, and a tool may rewrite it. `readForward` reads whole
// lines from a byte offset, a chunk at a time; `readBackward` reads the lines
// before an offset, newest first. A line past MAX_LINE is dropped (reported as
// an empty line), so one huge record cannot take the daemon's memory.

import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync, statSync } from 'node:fs'

export const CHUNK = 1 << 20
export const MAX_LINE = 16 << 20
const HASH_BYTES = 256

export interface Line {
  /** The line without its newline; '' for a dropped oversized line. */
  text: string
  /** Offset of the line's first byte. */
  start: number
  /** Offset just past its newline. */
  end: number
}

export interface FileFacts {
  size: number
  mtime: number
  inode: number
}

export function fileFacts(path: string): FileFacts | null {
  try {
    const stat = statSync(path)
    return { size: stat.size, mtime: Math.floor(stat.mtimeMs), inode: stat.ino }
  } catch {
    return null
  }
}

function readAt(fd: number, start: number, length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length)
  let filled = 0
  while (filled < length) {
    const n = readSync(fd, buffer, filled, length - filled, start + filled)
    if (n === 0) break
    filled += n
  }
  return filled === length ? buffer : buffer.subarray(0, filled)
}

/** Hash of the file's first bytes, or of the bytes just before `end`: a
 * rewrite that keeps the size still changes one of them. */
export function edgeHash(path: string, which: 'head' | 'tail', end: number): string | null {
  if (end <= 0) return null
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const length = Math.min(HASH_BYTES, end)
    const start = which === 'head' ? 0 : end - length
    return createHash('sha1')
      .update(readAt(fd, start, length))
      .digest('hex')
      .slice(0, 16)
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** Complete lines from `from` on, stopping once `budget` bytes were read, `each`
 * returns false or the file ends. A last line with no newline yet is left for the next run. */
export function readForward(
  path: string,
  from: number,
  budget: number,
  each: (line: Line) => boolean | undefined,
): { end: number; size: number } {
  const fd = openSync(path, 'r')
  try {
    const size = statSync(path).size
    let position = from
    let consumed = from
    let carry: Buffer[] = []
    let carryLength = 0
    let carryStart = from
    let dropping = false
    let read = 0
    while (position < size && read < budget) {
      const chunk = readAt(fd, position, Math.min(CHUNK, size - position))
      if (chunk.length === 0) break
      read += chunk.length
      let lineStart = 0
      while (true) {
        const newline = chunk.indexOf(0x0a, lineStart)
        if (newline < 0) break
        const absoluteEnd = position + newline + 1
        if (dropping) {
          if (each({ text: '', start: carryStart, end: absoluteEnd }) === false) {
            return { end: absoluteEnd, size }
          }
        } else {
          const piece = chunk.subarray(lineStart, newline)
          const whole = carry.length ? Buffer.concat([...carry, piece]) : piece
          if (
            each({ text: whole.toString('utf8'), start: carryStart, end: absoluteEnd }) === false
          ) {
            return { end: absoluteEnd, size }
          }
        }
        carry = []
        carryLength = 0
        dropping = false
        consumed = absoluteEnd
        carryStart = absoluteEnd
        lineStart = newline + 1
      }
      const rest = chunk.subarray(lineStart)
      if (!dropping && rest.length) {
        carry.push(Buffer.from(rest))
        carryLength += rest.length
        if (carryLength > MAX_LINE) {
          carry = []
          carryLength = 0
          dropping = true
        }
      }
      position += chunk.length
    }
    return { end: consumed, size }
  } finally {
    closeSync(fd)
  }
}

/** The offset just past the file's last newline (0 when it has none): a
 * line boundary, the place a backward read starts from. */
export function completeEnd(path: string): number {
  const fd = openSync(path, 'r')
  try {
    const size = statSync(path).size
    let end = size
    while (end > 0) {
      const start = Math.max(0, end - CHUNK)
      const at = readAt(fd, start, end - start).lastIndexOf(0x0a)
      if (at >= 0) return start + at + 1
      end = start
    }
    return 0
  } finally {
    closeSync(fd)
  }
}

/** Complete lines before `before` (a line boundary), last line first, until
 * `each` returns false, `budget` bytes were read or the file's start is
 * reached. Returns the start of the oldest line handed out: where the next
 * older scan resumes (0: nothing older). */
export function readBackward(
  path: string,
  before: number,
  budget: number,
  each: (line: Line) => boolean,
): number {
  if (before <= 0) return 0
  const fd = openSync(path, 'r')
  try {
    let lineEnd = before
    let position = before - 1 // the last line's newline is not content
    let carry: Buffer[] = []
    let carryLength = 0
    let dropping = false
    let read = 0
    const emit = (bytes: Buffer, start: number): boolean => {
      const text = dropping ? '' : bytes.toString('utf8')
      dropping = false
      const keepGoing = each({ text, start, end: lineEnd })
      lineEnd = start
      carry = []
      carryLength = 0
      return keepGoing
    }
    while (position > 0) {
      if (read >= budget) return lineEnd
      const start = Math.max(0, position - CHUNK)
      const chunk = readAt(fd, start, position - start)
      read += chunk.length
      let cut = chunk.length
      while (cut > 0) {
        const at = chunk.lastIndexOf(0x0a, cut - 1)
        if (at < 0) break
        const bytes = carry.length
          ? Buffer.concat([chunk.subarray(at + 1, cut), ...carry])
          : chunk.subarray(at + 1, cut)
        if (!emit(bytes, start + at + 1)) return lineEnd
        cut = at
      }
      if (cut > 0 && !dropping) {
        carry.unshift(Buffer.from(chunk.subarray(0, cut)))
        carryLength += cut
        if (carryLength > MAX_LINE) {
          carry = []
          carryLength = 0
          dropping = true
        }
      }
      position = start
    }
    emit(carry.length ? Buffer.concat(carry) : Buffer.alloc(0), 0)
    return 0
  } finally {
    closeSync(fd)
  }
}

// Host-side reads of an entry session's agent home (src/lifecycle/entries.ts)
// that stay inside it. What runs through an entry (a container) owns the
// files under its home, so a path Tether builds there can be a symlink, or be
// swapped for one between reads. Every read here opens the file or directory
// itself (no symlink as the last component, never blocking on a FIFO), then
// checks where the open descriptor really is (/proc/self/fd) and what it is
// before reading a byte: inside the home and a regular file (or directory),
// else it is refused. Directories are listed through that descriptor, and a
// tailed file is reopened and checked on every read, so a path replaced
// later is caught too. The home itself must be a real directory.

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { ENTRY_SCAN_DEFAULTS, type EntryScanConfig } from './config'
import type { EntryHomeFiles, FileReader, FileTail, ProcFs } from './proc-facts'

export type { EntryHomeFiles } from './proc-facts'

let entryScan: EntryScanConfig = ENTRY_SCAN_DEFAULTS

/** The daemon's scan limits (config.ts resolveEntryScanConfig). */
export function configureEntryScan(next: EntryScanConfig): void {
  entryScan = next
}

const FILE_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY
const DIR_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY

function outside(path: string): Error {
  return Object.assign(new Error(`not inside the entry home: ${path}`), { code: 'EACCES' })
}

/** The home's host path with its parent resolved, when the home itself is a
 * directory and not a symlink; null otherwise (nothing is read then). */
export function entryHomeBoundary(home: string): string | null {
  if (!isAbsolute(home)) return null
  try {
    const path = join(realpathSync(dirname(home)), basename(home))
    return lstatSync(path).isDirectory() ? path : null
  } catch {
    return null
  }
}

/** Open `path` read-only and keep the descriptor only if it is a regular file
 * (or a directory) inside `boundary`. */
export function openInside(boundary: string, path: string, directory = false): number {
  const fd = openSync(path, directory ? DIR_FLAGS : FILE_FLAGS)
  try {
    const where = readlinkSync(`/proc/self/fd/${fd}`)
    const stat = fstatSync(fd)
    const kind = directory ? stat.isDirectory() : stat.isFile()
    if (!kind || !(where === boundary || where.startsWith(`${boundary}/`))) throw outside(path)
    return fd
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

/** The last `maxBytes` of an open file, from its first whole line. */
export function readFdTail(fd: number, maxBytes: number): string {
  const size = fstatSync(fd).size
  if (size <= maxBytes) return readFileSync(fd, 'utf8')
  const buffer = Buffer.alloc(maxBytes)
  const read = readSync(fd, buffer, 0, maxBytes, size - maxBytes)
  const text = buffer.subarray(0, read).toString('utf8')
  return text.slice(text.indexOf('\n') + 1)
}

/** A FileTail over files `open` returns descriptors for. */
export function fileTail(open: (path: string) => number): FileTail {
  return {
    read(path, offset, max) {
      const fd = open(path)
      try {
        const size = fstatSync(fd).size
        let start = offset > size ? 0 : offset
        if (size - start > max) start = size - max
        const buffer = Buffer.alloc(size - start)
        const read = readSync(fd, buffer, 0, buffer.length, start)
        const text = buffer.subarray(0, read).toString('utf8')
        // Hold back a partial last line until it is complete.
        const end = text.lastIndexOf('\n') + 1
        return {
          text: text.slice(0, end),
          offset: start + Buffer.byteLength(text.slice(0, end)),
          size,
        }
      } finally {
        closeSync(fd)
      }
    },
    range(path, start, end) {
      const fd = open(path)
      try {
        const buffer = Buffer.alloc(Math.max(0, end - start))
        return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, start))
      } finally {
        closeSync(fd)
      }
    },
  }
}

function withFd<T>(fd: number, use: (fd: number) => T): T {
  try {
    return use(fd)
  } finally {
    closeSync(fd)
  }
}

/** Readers for an entry home, or null when the home is not a real directory. */
export function entryHomeFiles(
  home: string,
  scan: EntryScanConfig = entryScan,
): EntryHomeFiles | null {
  const boundary = entryHomeBoundary(home)
  if (!boundary) return null
  const file = (path: string) => openInside(boundary, path)
  const list = (path: string) =>
    withFd(openInside(boundary, path, true), (fd) => readdirSync(`/proc/self/fd/${fd}`))
  const head = (path: string, bytes: number) =>
    withFd(file(path), (fd) => {
      const buffer = Buffer.alloc(bytes)
      return buffer.subarray(0, readSync(fd, buffer, 0, bytes, 0)).toString('utf8')
    })
  const mtime = (path: string) => {
    try {
      return withFd(file(path), (fd) => fstatSync(fd).mtimeMs)
    } catch {
      return null
    }
  }
  const fs: ProcFs = {
    readFile: (path) => withFd(file(path), (fd) => readFileSync(fd, 'utf8')),
    readHead: head,
    readdir: list,
    readlink: (path) => {
      throw outside(path)
    },
    mtimeMs: mtime,
  }
  const reader: FileReader = {
    read: (path, maxBytes) => {
      try {
        return withFd(file(path), (fd) =>
          maxBytes === undefined ? readFileSync(fd, 'utf8') : readFdTail(fd, maxBytes),
        )
      } catch {
        return null
      }
    },
    list: (path) => {
      try {
        return list(path)
      } catch {
        return []
      }
    },
    mtime,
  }
  return { home: boundary, fs, tail: fileTail(file), reader, scan }
}

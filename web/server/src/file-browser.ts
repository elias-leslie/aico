// Safe browsing of a tab's working directory (the Python backend's
// file_browser.py, check for check): one directory level or one file, never
// outside the root, never a secret, before or after following symlinks.

import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

/** Refused: the path leaves the root, or names a secret or a hidden directory (403). */
export class AccessDenied extends Error {}
/** Malformed input (400). */
export class InvalidPath extends Error {}
/** Nothing of that kind there (404). */
export class NotFound extends Error {}

const BINARY_EXTENSIONS = new Set([
  '.pyc',
  '.pyo',
  '.so',
  '.dll',
  '.exe',
  '.bin',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.webp',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.mp3',
  '.mp4',
  '.wav',
  '.ogg',
  '.webm',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.xz',
  '.7z',
  '.sqlite',
  '.db',
])

const EXTENSION_TO_LANGUAGE: Readonly<Record<string, string>> = {
  '.py': 'python',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.json': 'json',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'css',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.sql': 'sql',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.cpp': 'cpp',
  '.c': 'cpp',
  '.h': 'cpp',
  '.hpp': 'cpp',
  '.xml': 'xml',
  '.svg': 'xml',
  '.php': 'php',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.toml': 'toml',
  '.dockerfile': 'dockerfile',
}

// Path parts the browser never lists or reads (secrets and keys), matched
// case-insensitively against every part of both the requested path and the
// resolved target, so a symlink inside the root cannot point at one either.
// SSH key names are spelled out so source files such as id_utils.py stay
// readable. Hidden directories (.aws, .config, .claude, .gnupg, ...) are
// refused as a whole, the same way listings leave them out, which covers a
// pane rooted at $HOME.
const DENIED_GLOBS = [
  '.git',
  '.git-credentials',
  '.env*',
  '.ssh',
  '.netrc',
  '.pgpass',
  '.npmrc',
  '.pypirc',
  '.*_history',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  'credentials',
  'credentials.json',
  '*.credentials.json',
  'auth.json',
]

const DENIED = DENIED_GLOBS.map(
  (glob) =>
    new RegExp(
      `^${glob
        .split('')
        .map((char) =>
          char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.+^${}()|[\]\\]/g, '\\$&'),
        )
        .join('')}$`,
      's',
    ),
)

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '.next',
  'dist',
  'build',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'data',
  '.beads',
  'backups',
  'references',
  'logs',
  'test-results',
  '.idea',
  '.vscode',
])

export const MAX_FILE_SIZE = 1_048_576
const BINARY_SNIFF_BYTES = 8192

export function isDenied(name: string): boolean {
  const lowered = name.toLowerCase()
  return DENIED.some((pattern) => pattern.test(lowered))
}

/** Python's PurePosixPath(...).parts for a relative path: no empty or `.` parts. */
function parts(path: string): string[] {
  return path.split('/').filter((part) => part !== '' && part !== '.')
}

/** Python's Path.suffix: the last dot's tail, unless the dot leads or ends the name. */
export function suffix(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot) : ''
}

function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

/** os.path.realpath without strictness: symlinks resolved as far as the path exists. */
export function realpathLoose(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    const parent = dirname(path)
    if (parent === path) return path
    return join(realpathLoose(parent), basename(path))
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function safeRoot(rootPath: string): string {
  if (rootPath.includes('\0')) throw new InvalidPath('Invalid pane root path')
  return realpathLoose(resolve(expandHome(rootPath)))
}

/** Refuse denied names and hidden directories; every part but the last is a directory. */
function refuseDenied(names: string[], lastIsDir = true): void {
  names.forEach((part, index) => {
    const isDir = index < names.length - 1 || lastIsDir
    if (isDenied(part) || (isDir && part.startsWith('.')))
      throw new AccessDenied(`Access denied: ${part}`)
  })
}

function safeRelative(relativePath: string): string[] {
  if (relativePath.includes('\0')) throw new AccessDenied('Access denied: invalid path')
  if (relativePath.startsWith('/'))
    throw new AccessDenied('Access denied: absolute paths are not allowed')
  const names = parts(relativePath)
  if (names.includes('..')) throw new AccessDenied('Access denied: ..')
  refuseDenied(names, false)
  return names
}

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(root === sep ? root : root + sep)
}

/** A path inside the root, without traversal or a denied part (before or after symlinks). */
export function resolveSafePath(rootPath: string, relativePath: string): string {
  const root = safeRoot(rootPath)
  const target = realpathLoose(join(root, ...safeRelative(relativePath)))
  if (!inside(root, target)) throw new AccessDenied('Access denied: path escapes pane root')
  const isDir = isDirectory(target)
  refuseDenied(parts(relative(root, target)), isDir)
  if (isDir) refuseDenied(parts(relativePath).slice(-1))
  return target
}

export interface TreeEntry {
  name: string
  path: string
  is_directory: boolean
  size?: number
  extension?: string | null
  children_count?: number
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

function entryInfo(entry: string, root: string): TreeEntry {
  const data: TreeEntry = {
    name: basename(entry),
    path: relative(root, entry),
    is_directory: isDirectory(entry),
  }
  if (data.is_directory) {
    try {
      data.children_count = readdirSync(entry).filter((name) => {
        const childIsDir = isDirectory(join(entry, name))
        return !(childIsDir && (name.startsWith('.') || SKIP_DIRS.has(name)))
      }).length
    } catch (error) {
      if (errorCode(error) !== 'EACCES' && errorCode(error) !== 'EPERM') throw error
      data.children_count = 0
    }
  } else {
    try {
      data.size = statSync(entry).size
    } catch {
      data.size = 0
    }
    data.extension = suffix(data.name).toLowerCase() || null
  }
  return data
}

/** One directory level within the root. */
export function listDirectory(
  rootPath: string,
  relativePath = '',
): { entries: TreeEntry[]; path: string; total: number } {
  const target = resolveSafePath(rootPath, relativePath)
  if (!isDirectory(target)) throw new NotFound(`Not a directory: ${relativePath}`)
  const root = safeRoot(rootPath)
  const children = readdirSync(target, { withFileTypes: true })
    .map((dirent) => ({
      name: dirent.name,
      path: join(target, dirent.name),
      isDir: isDirectory(join(target, dirent.name)),
      isSymlink: dirent.isSymbolicLink(),
    }))
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      const x = a.name.toLowerCase()
      const y = b.name.toLowerCase()
      return x < y ? -1 : x > y ? 1 : 0
    })
  const entries: TreeEntry[] = []
  for (const child of children) {
    if (child.isDir && (child.name.startsWith('.') || SKIP_DIRS.has(child.name))) continue
    if (isDenied(child.name)) continue
    if (child.isSymlink) {
      try {
        resolveSafePath(rootPath, relative(root, child.path))
      } catch (error) {
        if (error instanceof AccessDenied) continue
        throw error
      }
    }
    entries.push(entryInfo(child.path, root))
  }
  return { entries, path: relativePath || '', total: entries.length }
}

function detectLanguage(name: string, extension: string): string | null {
  const language = EXTENSION_TO_LANGUAGE[extension]
  if (!language && ['dockerfile', 'containerfile'].includes(name.toLowerCase())) return 'dockerfile'
  return language ?? null
}

/** Up to `limit` bytes from the start of the file. */
function readHead(path: string, limit: number): Buffer {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(limit)
    let filled = 0
    while (filled < limit) {
      const read = readSync(fd, buffer, filled, limit - filled, filled)
      if (read === 0) break
      filled += read
    }
    return buffer.subarray(0, filled)
  } finally {
    closeSync(fd)
  }
}

function isBinary(path: string, extension: string): boolean {
  if (BINARY_EXTENSIONS.has(extension)) return true
  try {
    return readHead(path, BINARY_SNIFF_BYTES).includes(0)
  } catch {
    return true
  }
}

export interface FileContent {
  path: string
  name: string
  content: string | null
  size: number
  lines: number
  extension: string | null
  is_binary: boolean
  language: string | null
  truncated: boolean
}

/** One file inside the root: text (decoded as Python's text mode reads it) or marked binary. */
export function readFile(rootPath: string, relativePath: string): FileContent {
  const target = resolveSafePath(rootPath, relativePath)
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(target)
  } catch {
    throw new NotFound(`Not a file: ${relativePath}`)
  }
  if (!stat.isFile()) throw new NotFound(`Not a file: ${relativePath}`)
  const name = basename(target)
  const extension = suffix(name).toLowerCase()
  const base = {
    path: relativePath,
    name,
    size: stat.size,
    extension: extension || null,
  }
  if (isBinary(target, extension))
    return { ...base, content: null, lines: 0, is_binary: true, language: null, truncated: false }

  const truncated = stat.size > MAX_FILE_SIZE
  let raw: Buffer
  try {
    raw = readHead(target, truncated ? MAX_FILE_SIZE : Math.max(stat.size, 1) + MAX_FILE_SIZE)
  } catch (error) {
    throw new InvalidPath(`Cannot read file: ${(error as Error).message}`)
  }
  // Python's text mode: invalid bytes replaced, a cut character at the end dropped, newlines as \n.
  const content = new TextDecoder('utf-8', { ignoreBOM: true })
    .decode(raw, { stream: truncated })
    .replace(/\r\n?/g, '\n')
  const lines = (content.match(/\n/g)?.length ?? 0) + (content && !content.endsWith('\n') ? 1 : 0)
  return {
    ...base,
    content,
    lines,
    is_binary: false,
    language: detectLanguage(name, extension),
    truncated,
  }
}

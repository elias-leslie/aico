// Git and path helpers: the repo root, changed files, blob and tree ids, and the path globs
// .st-check.toml uses (`**` spans directories, `*` and `?` stay within one, a literal
// directory selects everything under it).

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

export class GitError extends Error {}

export function git(cwd: string, args: string[], input?: string | Buffer): string {
  const result = spawnSync('git', args, {
    cwd,
    input,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  if (result.status !== 0)
    throw new GitError(
      `git ${args[0]}: ${(result.stderr || result.error?.message || '').trim().split('\n')[0]}`,
    )
  return result.stdout
}

/** git with the exit code, for questions whose answer is the code. */
export function gitOk(cwd: string, args: string[]): boolean {
  return spawnSync('git', args, { cwd, stdio: 'ignore' }).status === 0
}

export function repoRoot(cwd: string): string {
  return git(cwd, ['rev-parse', '--show-toplevel']).trim()
}

/** The shared .git directory (the same for every worktree of the repo). */
export function commonDir(root: string): string {
  return resolve(root, git(root, ['rev-parse', '--git-common-dir']).trim())
}

const nul = (out: string) => out.split('\0').filter(Boolean)

/** Files that differ from HEAD (staged, unstaged, deleted) plus untracked ones, under the given pathspecs. */
export function changedFiles(root: string, pathspecs: string[] = []): string[] {
  const specs = pathspecs.length ? ['--', ...literal(root, pathspecs)] : []
  const hasHead = gitOk(root, ['rev-parse', '-q', '--verify', 'HEAD'])
  const tracked = hasHead
    ? nul(git(root, ['diff', '--name-only', '-z', 'HEAD', ...specs]))
    : nul(git(root, ['ls-files', '-z', ...specs]))
  const untracked = nul(git(root, ['ls-files', '--others', '--exclude-standard', '-z', ...specs]))
  return [...new Set([...tracked, ...untracked])].sort()
}

/** Pathspecs that match an existing path literally (a Next.js `[id]` route is not a glob). */
function literal(root: string, paths: string[]): string[] {
  return paths.map((path) =>
    /[*?[]/.test(path) && existsSync(join(root, path)) ? `:(literal)${path}` : path,
  )
}

/** Repo-relative POSIX paths for what a caller typed (relative to cwd, or absolute). */
export function repoPaths(root: string, cwd: string, paths: string[]): string[] {
  return paths
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => {
      const rel = relative(root, resolve(cwd, path)).split('\\').join('/')
      if (rel.startsWith('..') || isAbsolute(rel))
        throw new GitError(`path is outside the repository: ${path}`)
      return rel || '.'
    })
}

/** Blob ids of the working-tree files (missing files map to "-"). */
export function blobIds(root: string, files: string[]): Map<string, string> {
  const ids = new Map<string, string>()
  if (!files.length) return ids
  const out = spawnSync('git', ['hash-object', '--no-filters', '--stdin-paths'], {
    cwd: root,
    input: files.join('\n'),
    encoding: 'utf8',
  })
  const hashes = out.status === 0 ? out.stdout.split('\n') : []
  // hash-object stops at the first missing path; hash one by one when that happened.
  if (hashes.filter(Boolean).length === files.length) {
    for (const [index, file] of files.entries()) ids.set(file, hashes[index])
    return ids
  }
  for (const file of files) {
    const one = spawnSync('git', ['hash-object', '--no-filters', '--', file], {
      cwd: root,
      encoding: 'utf8',
    })
    ids.set(file, one.status === 0 ? one.stdout.trim() : '-')
  }
  return ids
}

/** `<mode> <oid>\t<path>` lines of the committed tree under the given paths (sorted, stable). */
function treeEntries(root: string, rev: string, paths: string[]): string {
  return git(root, ['ls-tree', '-r', '--full-tree', rev, '--', ...paths])
}

const globCache = new Map<string, RegExp>()

/** One .st-check.toml glob as a regular expression. */
function globRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern)
  if (cached) return cached
  const trimmed = pattern.replace(/\/+$/, '')
  let out = ''
  for (let i = 0; i < trimmed.length; ) {
    if (trimmed.startsWith('**/', i)) {
      out += '(?:.*/)?'
      i += 3
    } else if (trimmed.startsWith('**', i)) {
      out += '.*'
      i += 2
    } else if (trimmed[i] === '*') {
      out += '[^/]*'
      i++
    } else if (trimmed[i] === '?') {
      out += '[^/]'
      i++
    } else {
      out += trimmed[i].replace(/[.+^${}()|[\]\\]/g, '\\$&')
      i++
    }
  }
  const re = new RegExp(`^${out}${trimmed.endsWith('*') ? '' : '(?:/.*)?'}$`)
  globCache.set(pattern, re)
  return re
}

export function matches(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globRegExp(pattern).test(path))
}

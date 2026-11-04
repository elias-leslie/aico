// The native homes whose Claude and Codex files are read: this user's and the copies of other
// hosts' homes. The list is data (data/usage.json `native_homes`, or AICO_NATIVE_HOMES as a
// path list); an entry may start with ~ and may end in /* for every folder under it.
// A home's name is never reported: what the collector says about a home carries counts only.

import { readdirSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import config from '../data/usage.json' with { type: 'json' }

export function nativeHomes(env: NodeJS.ProcessEnv, home: string): string[] {
  const configured = (env.AICO_NATIVE_HOMES ?? '').split(delimiter).filter(Boolean)
  const entries = configured.length ? configured : config.native_homes
  const out: string[] = []
  for (const entry of entries) {
    const path = entry === '~' ? home : entry.startsWith('~/') ? join(home, entry.slice(2)) : entry
    if (path.endsWith('/*')) {
      try {
        const base = path.slice(0, -2)
        for (const found of readdirSync(base, { withFileTypes: true }))
          if (found.isDirectory() && !found.isSymbolicLink()) out.push(join(base, found.name))
      } catch {
        // no such folder: nothing to read there
      }
    } else out.push(path)
  }
  return [...new Set(out)].sort((a, b) => (a === home ? -1 : b === home ? 1 : a.localeCompare(b)))
}

/** Matches a path or working directory the collector keeps only numbers from (whole words, any case). */
export function privateMatcher(words: readonly string[]): (text: string) => boolean {
  const patterns = words.map(
    (word) =>
      new RegExp(`(?<![a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`, 'i'),
  )
  return (text) => patterns.some((pattern) => pattern.test(text))
}

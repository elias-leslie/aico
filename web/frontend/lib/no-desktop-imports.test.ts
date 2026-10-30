// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The web app builds without the desktop: code both use lives in shared/ at
// the repo root, never under electron/.
const WEB = fileURLToPath(new URL('../..', import.meta.url))
const SKIP = new Set(['node_modules', 'out', 'dist', '.next', 'generated'])

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return []
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.(ts|tsx|css|mjs)$/.test(entry.name) ? [path] : []
  })
}

describe('web build', () => {
  it('imports nothing from electron/', () => {
    const importsDesktop =
      /(from\s+|import\s*\(\s*|@import\s+|vi\.mock\(\s*)['"][^'"]*\belectron\//
    const offenders = sources(WEB).filter((file) =>
      importsDesktop.test(readFileSync(file, 'utf8')),
    )
    expect(offenders).toEqual([])
  })
})

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'

// The daemon bundle (dist/tether.mjs, built from src/cli.ts) and the libraries
// the apps bundle (src/client, src/term) stay apart: the daemon never imports
// the client or the terminal engine, and they take only types from the daemon.

const SRC = import.meta.dirname

describe('package boundaries', () => {
  it('keeps the daemon and apps copies of the link-only ssh options equal', async () => {
    const [hub, term] = await Promise.all([import('./hub/link'), import('./term/remote')])
    expect(hub.SSH_MUX_ONLY).toEqual(term.SSH_MUX_ONLY)
    expect(hub.SSH_BIN).toBe(term.SSH_BIN)
  })

  it('builds the daemon bundle from no src/client or src/term input', async () => {
    const result = await build({
      entryPoints: [join(SRC, 'cli.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      write: false,
      metafile: true,
      logLevel: 'silent',
    })
    const inputs = Object.keys(result.metafile.inputs)
    expect(inputs.some((path) => path.endsWith('src/cli.ts'))).toBe(true)
    expect(inputs.filter((path) => /(^|\/)src\/(client|term)\//.test(path))).toEqual([])
  })

  // The engine may use the client library itself (`../client/index`), but
  // nothing else outside its own directory.
  it.each([
    ['client', []],
    ['term', ['../client/index']],
  ])('imports daemon modules into src/%s by type only', (lib, allowed) => {
    const dir = join(SRC, lib)
    const valueImports = readdirSync(dir)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .flatMap((name) =>
        [
          ...readFileSync(join(dir, name), 'utf8').matchAll(
            /^import (?!type )[^']*from '(\.\.\/[^']*)'/gm,
          ),
        ]
          .filter((match) => !allowed.includes(match[1]))
          .map((match) => `${name}: ${match[1]}`),
      )
    expect(valueImports).toEqual([])
  })
})

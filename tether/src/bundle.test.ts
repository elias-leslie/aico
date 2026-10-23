import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'

// The daemon bundle (dist/tether.mjs, built from src/cli.ts) and the client
// library (src/client, bundled by the apps) stay apart: the daemon never
// imports the client or the terminal engine, and the client takes only types
// from the daemon.

const SRC = import.meta.dirname

describe('package boundaries', () => {
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

  it('imports daemon modules into the client by type only', () => {
    const dir = join(SRC, 'client')
    const valueImports = readdirSync(dir)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .flatMap((name) =>
        [
          ...readFileSync(join(dir, name), 'utf8').matchAll(
            /^import (?!type )[^']*from '(\.\.\/[^']*)'/gm,
          ),
        ].map((match) => `${name}: ${match[1]}`),
      )
    expect(valueImports).toEqual([])
  })
})

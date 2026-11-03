import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'

// The daemon bundle (dist/tether.mjs, built from src/cli.ts) and the libraries
// the apps bundle (src/client, src/term) stay apart: the daemon never imports
// the client or the terminal engine (@aico/tether-client), which take nothing from the daemon.

const SRC = import.meta.dirname

describe('package boundaries', () => {
  it('keeps the daemon and apps copies of the link-only ssh options equal', async () => {
    const [hub, term] = await Promise.all([
      import('@aico/fleet/link'),
      import('@aico/tether-client/term/remote'),
    ])
    expect(hub.SSH_MUX_ONLY).toEqual(term.SSH_MUX_ONLY)
    expect(hub.SSH_BIN).toBe(term.SSH_BIN)
  })

  it('builds the daemon bundle from no tether-client client or term input', async () => {
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
    expect(inputs.filter((path) => /tether-client\/src\/(client|term)\//.test(path))).toEqual([])
  })

  // The client library and the terminal engine live in @aico/tether-client, which
  // cannot depend on the daemon package (tsc -b would not build it). A relative
  // import that climbs out of that package's src/ would be the way around it.
  it('keeps @aico/tether-client sources inside their own package', () => {
    const root = join(SRC, '..', '..', 'tether-client', 'src')
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(join(dir, entry.name))
          : entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
            ? [join(dir, entry.name)]
            : [],
      )
    const escaping = walk(root).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/from '(\.[^']*)'/g)]
        .map((match) => match[1])
        .filter((spec) => !resolve(dirname(file), spec).startsWith(root))
        .map((spec) => `${file.slice(root.length + 1)}: ${spec}`),
    )
    expect(escaping).toEqual([])
  })
})

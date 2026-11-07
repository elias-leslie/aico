// After `next build`: publish the Lantern tokens and typefaces at stable URLs, for HTML mockups
// opened through Aico (`<link rel="stylesheet" href="/ui-kit/tokens.css">` and `/ui-kit/fonts.css`).
// Both are generated from @aico/ui-kit, never edited copies. The fonts are inlined as data: URLs:
// a shared page runs sandboxed in an opaque origin, where a font file is a cross-origin load the
// Access gate refuses, while a stylesheet loads like any other file.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const kit = path.resolve(here, '..', '..', 'ui-kit')
const outDir = path.resolve(here, '..', 'out', 'ui-kit')

await mkdir(outDir, { recursive: true })
await writeFile(
  path.join(outDir, 'tokens.css'),
  await readFile(path.join(kit, 'src', 'tokens.css')),
)

const fonts = await readFile(path.join(kit, 'fonts', 'fonts.css'), 'utf8')
const inlined = []
for (const part of fonts.split(/(url\("\.\/[^"]+\.woff2"\))/)) {
  const match = /^url\("\.\/([^"]+\.woff2)"\)$/.exec(part)
  if (!match) {
    inlined.push(part)
    continue
  }
  const data = await readFile(path.join(kit, 'fonts', match[1]))
  inlined.push(`url("data:font/woff2;base64,${data.toString('base64')}")`)
}
await writeFile(path.join(outDir, 'fonts.css'), inlined.join(''))
console.log(`ui-kit assets written to ${path.relative(process.cwd(), outDir)}`)

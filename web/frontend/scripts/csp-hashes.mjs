// After `next build`: hash every inline <script> in the static export so the
// web server's page CSP allows exactly these (web/server/src/static.ts reads
// out/csp-hashes.json). Next's export inlines its bootstrap and RSC payload.
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'out')
// The end tag allows what HTML does (`</script >`, `</script foo>`).
const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi

async function htmlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return htmlFiles(full)
      return entry.name.endsWith('.html') ? [full] : []
    }),
  )
  return nested.flat()
}

const hashes = new Set()
const pages = await htmlFiles(outDir)
for (const page of pages) {
  const html = await readFile(page, 'utf8')
  for (const [, attributes, body] of html.matchAll(SCRIPT)) {
    if (/\bsrc\s*=/i.test(attributes) || body.length === 0) continue
    hashes.add(`sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}`)
  }
}
if (!pages.some((page) => path.basename(page) === 'index.html'))
  throw new Error(`No index.html in ${outDir}: did next build export?`)

await writeFile(
  path.join(outDir, 'csp-hashes.json'),
  `${JSON.stringify({ scriptHashes: [...hashes].sort() }, null, 2)}\n`,
)
console.log(`csp-hashes: ${hashes.size} inline scripts in ${pages.length} pages`)

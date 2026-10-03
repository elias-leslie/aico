import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// Load the real builder as Node does during packaging, including its own
// dependency resolution and CommonJS-to-ESM import boundary.
const require = createRequire(import.meta.url)
const builder =
  require('app-builder-lib/out/util/electronGet.js') as typeof import('app-builder-lib/out/util/electronGet.js')
const binaries =
  require('app-builder-lib/out/binDownload.js') as typeof import('app-builder-lib/out/binDownload.js')

const payload = Buffer.from('aico local builder artifact\n')
const checksum = createHash('sha256').update(payload).digest('hex')
const filename = 'electron-v42.11.8-linux-x64.zip'

async function withArtifact(
  check: (fixture: { directory: string; url: string; requests: string[] }) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'aico-builder-download-'))
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? '')
    response.writeHead(200, { 'content-length': payload.length })
    response.end(payload)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture address')
    await check({ directory, url: `http://127.0.0.1:${address.port}/${filename}`, requests })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}

describe('packaging artifact download contract', () => {
  it('downloads and reuses a checksum-verified artifact through the builder API', async () => {
    await withArtifact(async ({ directory, url, requests }) => {
      const options = {
        version: '42.11.8',
        platformName: 'linux',
        arch: 'x64',
        artifactName: 'electron',
        cacheDir: join(directory, 'cache'),
        electronDownload: {
          checksums: { [filename]: checksum },
          mirrorOptions: { resolveAssetURL: async () => url },
        },
      }
      const downloaded = await builder.downloadElectronArtifactZip(options)
      expect(await readFile(downloaded)).toEqual(payload)
      expect(await builder.downloadElectronArtifactZip(options)).toBe(downloaded)
      expect(requests).toEqual([`/${filename}`])
    })
  })

  it('supports the builder native dynamic-import download path', async () => {
    await withArtifact(async ({ directory, url }) => {
      vi.stubEnv('ELECTRON_BUILDER_CACHE', join(directory, 'cache'))
      try {
        const output = join(directory, 'downloaded.zip')
        await binaries.download(url, output, checksum)
        expect(await readFile(output)).toEqual(payload)
      } finally {
        vi.unstubAllEnvs()
      }
    })
  })

  it('rejects a downloaded artifact with an incorrect checksum', async () => {
    await withArtifact(async ({ directory, url }) => {
      await expect(
        builder.downloadElectronArtifactZip({
          version: '42.11.8',
          platformName: 'linux',
          arch: 'x64',
          artifactName: 'electron',
          cacheDir: join(directory, 'cache'),
          electronDownload: {
            checksums: { [filename]: '0'.repeat(64) },
            mirrorOptions: { resolveAssetURL: async () => url },
          },
        }),
      ).rejects.toThrow(/checksum/i)
    })
  })
})

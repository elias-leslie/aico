// Metadata-only phone management through aico-web. Pairing keys stay in the owning server.
import { join } from 'node:path'
import { text } from 'node:stream/consumers'
import { confirmPhonesMerge, mergePhonesFile, type Phone } from './app-phones'
import { mergeCursorFile, type PollCursor } from './canary-poll'
import { loadConfig } from './config'

export interface PhonesIo {
  out(text: string): void
  err(text: string): void
  baseUrl: string
  fetch: typeof fetch
  /** Overrides for the sync verbs (tests): stdin text, the phones file, the canary folder. */
  readInput?: () => Promise<string>
  devicesFile?: string
  canaryFolder?: string
}

const USAGE = 'Usage: aico phones list [--json] | remove PHONE_ID\n'

/** The answering side of `aico context-sync`: the sender's phones on stdin, the result on stdout. */
async function mergeFromPeer(io: PhonesIo): Promise<number> {
  const sent = JSON.parse(await (io.readInput ?? (() => text(process.stdin)))()) as Phone[]
  if (!Array.isArray(sent)) {
    io.err('phones merge reads a JSON list on stdin\n')
    return 2
  }
  const now = Math.floor(Date.now() / 1000)
  io.out(`${JSON.stringify(mergePhonesFile(devicesFile(io), sent, now))}\n`)
  return 0
}

const devicesFile = (io: PhonesIo) => io.devicesFile ?? loadConfig().notify.devicesFile

/** The canary cursor rides the same exchange: the sender's on stdin, the merged one on stdout. */
async function mergeCanaryFromPeer(io: PhonesIo): Promise<number> {
  const sent = JSON.parse(await (io.readInput ?? (() => text(process.stdin)))()) as PollCursor
  if (!sent || typeof sent !== 'object' || Array.isArray(sent)) {
    io.err('phones canary-merge reads a JSON object on stdin\n')
    return 2
  }
  io.out(`${JSON.stringify(mergeCanaryCursor(io, sent))}\n`)
  return 0
}

const mergeCanaryCursor = (io: PhonesIo, sent: PollCursor) =>
  mergeCursorFile(io.canaryFolder ?? join(loadConfig().dataDir, 'canary'), sent)

export async function runPhonesCli(argv: string[], io: PhonesIo): Promise<number> {
  const [verb, id, ...extra] = argv
  if (verb === 'merge') return mergeFromPeer(io)
  if (verb === 'merge-done') {
    confirmPhonesMerge(devicesFile(io))
    return 0
  }
  if (verb === 'canary-merge') return mergeCanaryFromPeer(io)
  if (verb === '--help' || verb === '-h') {
    io.out(USAGE)
    return 0
  }
  if (
    (verb !== 'list' && verb !== 'remove') ||
    extra.length ||
    (verb === 'list' && id && id !== '--json') ||
    (verb === 'remove' && (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)))
  ) {
    io.err(USAGE)
    return 2
  }
  try {
    const response = await io.fetch(
      `${io.baseUrl}/api/phone-app${verb === 'remove' ? `/${encodeURIComponent(id as string)}` : ''}`,
      { method: verb === 'remove' ? 'DELETE' : 'GET' },
    )
    const raw: unknown = await response.json()
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('Phone details could not be read.')
    const data = raw as Record<string, unknown>
    if (!response.ok)
      throw new Error(
        typeof data.error === 'string' ? data.error : 'Phone details could not be read.',
      )
    if (verb === 'remove') io.out(data.removed ? 'Phone removed.\n' : 'No phone with that id.\n')
    else if (data.phones === null) throw new Error('Paired phones could not be read.')
    else {
      if (!Array.isArray(data.phones)) throw new Error('Phone details could not be read.')
      const phones = data.phones.map((value: unknown) => {
        if (!value || typeof value !== 'object') throw new Error('Phone details could not be read.')
        const phone = value as Record<string, unknown>
        if (typeof phone.id !== 'string' || typeof phone.name !== 'string')
          throw new Error('Phone details could not be read.')
        return {
          id: phone.id,
          name: phone.name,
          last_ack: typeof phone.last_ack === 'number' ? phone.last_ack : null,
          last_message_ack: phone.last_message_ack ?? null,
        }
      })
      if (id === '--json') io.out(`${JSON.stringify({ phones })}\n`)
      else if (!phones.length) io.out('No phones paired yet.\n')
      else {
        const width = Math.max(2, ...phones.map((phone) => phone.id.length))
        io.out(`${'ID'.padEnd(width)}  NAME\n`)
        for (const phone of phones) io.out(`${phone.id.padEnd(width)}  ${phone.name}\n`)
      }
    }
    return 0
  } catch (error) {
    io.err(`${(error as Error).message}\n`)
    return 1
  }
}

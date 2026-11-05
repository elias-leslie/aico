// Metadata-only phone management through aico-web. Pairing keys stay in the owning server.
export interface PhonesIo {
  out(text: string): void
  err(text: string): void
  baseUrl: string
  fetch: typeof fetch
}

const USAGE = 'Usage: aico phones list [--json] | remove PHONE_ID\n'

export async function runPhonesCli(argv: string[], io: PhonesIo): Promise<number> {
  const [verb, id, ...extra] = argv
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
      else for (const phone of phones) io.out(`${phone.id} ${phone.name}\n`)
    }
    return 0
  } catch (error) {
    io.err(`${(error as Error).message}\n`)
    return 1
  }
}

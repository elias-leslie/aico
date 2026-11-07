// `aico machines`: the Machines page as lines: each Proxmox guest (GET /api/machines/guests) and
// each session host (GET /api/hosts) once, by name. The page's own power buttons stay on the page.

interface Guest {
  machine: string
  vmid: number
  state: string
  autostart: boolean | null
  powerable: boolean
  projects: { id: string; name: string }[]
  note?: string
}

interface Host {
  name: string
  state: string
  sessions: number
}

export interface MachinesIo {
  out(text: string): void
  err(text: string): void
  baseUrl: string
  fetch: typeof fetch
}

const USAGE = `Usage: aico machines [--json]
  Every machine Aico knows once: its Proxmox guest (VMID, power, start at boot), whether
  sessions can run on it and how many do, and the projects that run there.
  Power and start at boot are changed on the Machines page; this computer: aico monitor.
`

async function read(io: MachinesIo, path: string): Promise<unknown> {
  const response = await io.fetch(`${io.baseUrl}${path}`)
  if (!response.ok) throw new Error(`${path}: ${response.status}`)
  return response.json()
}

const items = <T>(value: unknown): T[] =>
  value && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items)
    ? ((value as { items: T[] }).items as T[])
    : []

const cell = (value: string, width: number) => value.padEnd(width)

export async function runMachinesCli(argv: string[], io: MachinesIo): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.out(USAGE)
    return 0
  }
  const unknown = argv.find((arg) => arg !== '--json')
  if (unknown) {
    io.err(`aico machines: unknown option ${unknown}; aico machines --help shows how\n`)
    return 2
  }
  // Each side may fail alone: say which one is missing instead of showing it as empty.
  const [guestsRead, hostsRead] = await Promise.allSettled([
    read(io, '/api/machines/guests'),
    read(io, '/api/hosts'),
  ])
  if (guestsRead.status === 'rejected' && hostsRead.status === 'rejected') {
    io.err(`Machines could not be read: ${(guestsRead.reason as Error).message}\n`)
    return 1
  }
  const guests = guestsRead.status === 'fulfilled' ? items<Guest>(guestsRead.value) : []
  const hosts = hostsRead.status === 'fulfilled' ? items<Host>(hostsRead.value) : []
  const hostByName = new Map(hosts.map((host) => [host.name, host]))
  const names = [...new Set([...guests.map((g) => g.machine), ...hosts.map((h) => h.name)])]
  const rows = names.map((name) => {
    const guest = guests.find((g) => g.machine === name)
    const host = hostByName.get(name)
    return { name, guest: guest ?? null, host: host ?? null }
  })
  if (argv.includes('--json')) {
    io.out(`${JSON.stringify({ machines: rows })}\n`)
  } else {
    const table = rows.map(({ name, guest, host }) => [
      name,
      guest?.vmid === undefined ? '-' : String(guest.vmid),
      guest?.state ?? '-',
      guest?.autostart == null ? '-' : guest.autostart ? 'yes' : 'no',
      host ? `${host.state} (${host.sessions})` : 'no',
      guest?.projects.map((p) => p.id).join(', ') || '-',
    ])
    const head = ['MACHINE', 'VMID', 'POWER', 'AT BOOT', 'SESSION HOST (SESSIONS)', 'PROJECTS']
    const widths = head.map((title, i) =>
      Math.max(title.length, ...table.map((row) => (row[i] as string).length)),
    )
    for (const row of [head, ...table])
      io.out(
        `${row
          .map((value, i) => cell(value, widths[i] as number))
          .join('  ')
          .trimEnd()}\n`,
      )
    if (!rows.length) io.out('No machines listed.\n')
  }
  if (guestsRead.status === 'rejected')
    io.err('Proxmox guests could not be read, so only session hosts are shown.\n')
  if (hostsRead.status === 'rejected')
    io.err('Session hosts could not be read, so only Proxmox guests are shown.\n')
  const failure =
    guestsRead.status === 'fulfilled'
      ? (guestsRead.value as { failure?: string | null }).failure
      : null
  if (failure) io.err(`Proxmox was not read just now (${failure}); power may be out of date.\n`)
  return 0
}

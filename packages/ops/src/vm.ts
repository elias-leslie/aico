// `aico vm list|status|start|stop|snapshot`: Proxmox guests over the existing root SSH to the PVE host
// (`qm`/`pct`/`pvesh`). The verbs and output match `st vm`. Power and snapshots are limited to the
// PVE pools st's API token was allowed (data/ops.json vm.*Pools); deleting a guest or a snapshot
// is not here: that stays owner-run.

import { readFileSync } from 'node:fs'
import ops from '../data/ops.json' with { type: 'json' }
import { Refusal } from './deploy'
import { type Runner, tail } from './sh'

export interface Guest {
  vmid: number
  name: string
  type: 'qemu' | 'lxc'
  status: string
  pool: string | null
  node: string
  maxmem: number
  maxdisk: number
}

const quote = (arg: string) =>
  /^[A-Za-z0-9_./:=@-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`

export class Pve {
  constructor(
    private readonly run: Runner,
    private readonly ssh = ops.vm.ssh,
  ) {}

  exec(argv: string[]): string {
    const result = this.run('ssh', [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      this.ssh,
      argv.map(quote).join(' '),
    ])
    if (result.code !== 0)
      throw new Refusal(`${argv.slice(0, 2).join(' ')} on ${this.ssh} failed: ${tail(result, 3)}`)
    return result.out
  }

  guests(): Guest[] {
    const rows = JSON.parse(
      this.exec(['pvesh', 'get', '/cluster/resources', '--type', 'vm', '--output-format', 'json']),
    )
    return (rows as Record<string, unknown>[])
      .map((row) => ({
        vmid: Number(row.vmid),
        name: String(row.name ?? ''),
        type: row.type === 'lxc' ? ('lxc' as const) : ('qemu' as const),
        status: String(row.status ?? ''),
        pool: typeof row.pool === 'string' ? row.pool : null,
        node: String(row.node ?? ''),
        maxmem: Number(row.maxmem) || 0,
        maxdisk: Number(row.maxdisk) || 0,
      }))
      .sort((a, b) => a.vmid - b.vmid)
  }

  guest(vmid: string): Guest {
    if (!/^[1-9][0-9]{2,8}$/.test(vmid))
      throw new Refusal(`VM IDs are numbers from 100 (got ${vmid})`, 2)
    const found = this.guests().find((guest) => guest.vmid === Number(vmid))
    if (!found) throw new Refusal(`No guest ${vmid} on the Proxmox host`)
    return found
  }
}

const mb = (bytes: number) => `${Math.floor(bytes / 1024 / 1024)}MB`
const gb = (bytes: number) => `${Math.floor(bytes / 1024 / 1024 / 1024)}GB`
const pad = (value: string | number, width: number) => String(value).padEnd(width)

export function listLines(guests: Guest[]): string[] {
  return [
    `${pad('VMID', 6)} ${pad('NAME', 25)} ${pad('STATUS', 10)} ${pad('RAM', 8)} ${pad('DISK', 8)}`,
    `${pad('----', 6)} ${pad('----', 25)} ${pad('------', 10)} ${pad('---', 8)} ${pad('----', 8)}`,
    ...guests.map(
      (g) =>
        `${pad(g.vmid, 6)} ${pad(g.name, 25)} ${pad(g.status, 10)} ${pad(mb(g.maxmem), 8)} ${pad(gb(g.maxdisk), 8)}`,
    ),
  ]
}

const allowed = (guest: Guest, pools: string[], what: string) => {
  if (!guest.pool || !pools.includes(guest.pool))
    throw new Refusal(
      `VM ${guest.vmid} (${guest.name}) is in pool ${guest.pool ?? 'none'}; ${what} is allowed only for pools ${pools.join(', ')}`,
    )
}

/** Nightshift's asset id when the guest is parked or lab tier (its board shows who runs it), else null. */
export function labAsset(vmid: string, registry: string): string | null {
  try {
    const findings = JSON.parse(readFileSync(registry, 'utf8')).findings ?? []
    const rows =
      findings.find((f: { code?: string }) => f.code === 'assets.registry')?.details?.assets ?? []
    const row = rows.find(
      (r: Record<string, unknown>) =>
        String(r.vmid) === vmid &&
        r.kind !== 'template' &&
        (r.presence === 'parked' || r.tier === 'lab'),
    )
    return row ? String(row.id ?? row.vmid) : null
  } catch {
    return null
  }
}

export function snapshotName(now = new Date()): string {
  return `snap-${now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}`
}

export function vm(
  argv: string[],
  run: Runner,
  out: (line: string) => void,
  err: (line: string) => void,
): number {
  const [verb, vmid, ...rest] = argv
  const pve = new Pve(run)
  const tool = (guest: Guest) => (guest.type === 'lxc' ? 'pct' : 'qm')
  switch (verb) {
    case 'list':
      for (const line of listLines(pve.guests())) out(line)
      return 0
    case 'status': {
      const guest = pve.guest(vmid ?? '')
      const data = JSON.parse(
        pve.exec([
          'pvesh',
          'get',
          `/nodes/${guest.node}/${guest.type}/${guest.vmid}/status/current`,
          '--output-format',
          'json',
        ]),
      )
      out(
        `VM ${data.vmid ?? guest.vmid} (${data.name ?? guest.name}): ${data.status ?? '?'} | CPU: ${Math.floor(Number(data.cpu || 0) * 100)}% | ` +
          `RAM: ${mb(Number(data.mem) || 0)}/${mb(Number(data.maxmem) || 0)} | Uptime: ${data.uptime ?? 0}s`,
      )
      return 0
    }
    case 'start':
    case 'stop': {
      const guest = pve.guest(vmid ?? '')
      allowed(guest, ops.vm.powerPools, verb)
      pve.exec([tool(guest), verb, String(guest.vmid)])
      out(`VM ${guest.vmid} ${verb === 'start' ? 'started' : 'stopped'}`)
      const asset = verb === 'start' ? labAsset(String(guest.vmid), ops.vm.labRegistry) : null
      if (asset) {
        const reason = rest.includes('--reason')
          ? (rest[rest.indexOf('--reason') + 1] ?? '')
          : `aico vm start ${guest.vmid}`
        const hours = rest.includes('--hours')
          ? Number(rest[rest.indexOf('--hours') + 1])
          : ops.vm.labHours
        const declared = run('nightshift', [
          'lab-use',
          'start',
          asset,
          '--hours',
          String(hours),
          '--reason',
          reason,
        ])
        if (declared.code === 0) out(`Nightshift: ${declared.out.trim() || `declared ${asset}`}`)
        else
          err(
            `Warning: Nightshift lab-use declaration for ${asset} failed (${tail(declared, 1)}); started anyway`,
          )
      }
      return 0
    }
    case 'snapshot': {
      const guest = pve.guest(vmid ?? '')
      allowed(guest, ops.vm.snapshotPools, 'a snapshot')
      const name = rest[0] ?? snapshotName()
      if (!/^[A-Za-z][A-Za-z0-9_-]{1,39}$/.test(name) || name === 'current')
        throw new Refusal(
          'Snapshot names are 2 to 40 letters, digits, - or _, starting with a letter',
          2,
        )
      out(`Creating snapshot '${name}' on VM ${guest.vmid}...`)
      pve.exec([
        tool(guest),
        'snapshot',
        String(guest.vmid),
        name,
        '--description',
        `Auto-snapshot ${new Date().toISOString()}`,
      ])
      out(`Done: ${name}`)
      return 0
    }
    default:
      err(
        'Usage: aico vm list | status ID | start ID [--hours H --reason R] | stop ID | snapshot ID [NAME]',
      )
      return 2
  }
}

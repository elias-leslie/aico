// What a machine is called, everywhere: the one Aico runs on is the Workstation, the Proxmox
// host is the Proxmox host, the second Aico (machine `aico`) is the Standby, others go by their own name. Status says which machine it runs on;
// until it has, a machine goes by its own name.

/** The machine that is this workstation (Status's `machine`), once Status has said. */
let workstation: string | null = null

export const WORKSTATION_LABEL = 'Workstation'

/** Names that differ from the machine's own (Status reports it as davion-gem). */
export const MACHINE_LABEL: Record<string, string> = {
  'davion-gem': 'Proxmox host',
  aico: 'Standby',
}

export function rememberWorkstation(key: string | null | undefined) {
  if (key) workstation = key
}

export function machineLabel(key: string): string {
  if (workstation !== null && key === workstation) return WORKSTATION_LABEL
  return MACHINE_LABEL[key] ?? key
}

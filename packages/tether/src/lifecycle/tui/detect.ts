import type { TuiSpec } from './spec'

export interface ProcessRow {
  pid: number
  ppid: number
  comm: string
}

export function parseProcessTable(output: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of output.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line)
    if (!m) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), comm: m[3] })
  }
  return rows
}

export function processTreeNames(rows: ProcessRow[], rootPid: number): string[] {
  const byParent = new Map<number, ProcessRow[]>()
  const byPid = new Map<number, ProcessRow>()
  for (const row of rows) {
    byPid.set(row.pid, row)
    const children = byParent.get(row.ppid) ?? []
    children.push(row)
    byParent.set(row.ppid, children)
  }

  const names: string[] = []
  const seen = new Set<number>()
  const stack = [rootPid]
  while (stack.length) {
    const pid = stack.pop() as number
    if (seen.has(pid)) continue
    seen.add(pid)
    const row = byPid.get(pid)
    if (row?.comm) names.push(row.comm)
    for (const child of byParent.get(pid) ?? []) stack.push(child.pid)
  }
  return names
}

export function detectTuiFromProcessNames(
  tuis: TuiSpec[],
  processNames: Iterable<string>,
): TuiSpec | undefined {
  const names = new Set(processNames)
  return tuis
    .filter((tui) => tui.processName && names.has(tui.processName))
    .sort((a, b) => a.order - b.order)[0]
}

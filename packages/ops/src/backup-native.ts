import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  type BackupConfig,
  type BackupPoint,
  type BackupState,
  copyKey,
  homePath,
} from './backup-plan'
import { checked, type Runtime } from './backup-runtime'

function rawRows(output: string): Record<string, string>[] {
  return output
    .split('\n')
    .filter((l) => l.startsWith('format='))
    .map((line) =>
      Object.fromEntries(
        line
          .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
          ?.filter((v) => v.includes('='))
          .map((token) => {
            const at = token.indexOf('=')
            return [token.slice(0, at), token.slice(at + 1).replace(/^["']|["']$/g, '')]
          }) ?? [],
      ),
    )
}
export function preserveNative(existing: string[], deleting: string[]): boolean {
  const groups = new Map<string, { total: number; removed: number }>()
  for (const name of existing) {
    const key = name.split('.')[0] as string
    const group = groups.get(key) ?? { total: 0, removed: 0 }
    group.total++
    if (deleting.includes(name)) group.removed++
    groups.set(key, group)
  }
  return (
    deleting.length > Math.max(6, existing.length * 0.34) ||
    [...groups.values()].some((g) => g.removed > Math.max(2, g.total * 0.34))
  )
}
export async function nativeBackup(
  rt: Runtime,
  state: BackupState,
  scheduled: boolean,
): Promise<void> {
  const { cfg } = rt
  // btrbk owns retention, still reading the exact root-owned configuration already in service.
  for (let p = cfg.btrbkConfig; ; p = dirname(p)) {
    const st = lstatSync(p)
    if (st.isSymbolicLink() || st.uid !== 0 || st.mode & 0o022)
      throw new Error('The btrbk configuration must be root owned and not writable by other users.')
    if (dirname(p) === p) break
  }
  const text = readFileSync(cfg.btrbkConfig, 'utf8')
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  if (
    lines.some((l) => /^include\s/.test(l)) ||
    cfg.retention.btrbk.some((rule) => !lines.includes(rule))
  )
    throw new Error('The configured snapshot retention differs from the migrated policy.')
  const base = ['sudo', '-n', 'btrbk', '-c', cfg.btrbkConfig]
  const rows = rawRows(
    await checked(rt.run, [...base, '--dry-run', '--format', 'raw', 'list', 'config']),
  )
  if (
    cfg.nativeSources.some((source) => !rows.some((row) => row.source_url === source)) ||
    rows.some((row) => row.target_path !== cfg.nativeTarget || row.source_host || row.target_host)
  )
    throw new Error('The native backup coverage differs from its configured sources or target.')
  const mount = JSON.parse(
    await checked(rt.run, [
      'findmnt',
      '--json',
      '-T',
      cfg.nativeTarget,
      '-o',
      'TARGET,FSTYPE,UUID',
    ]),
  ) as { filesystems: { fstype: string; uuid: string }[] }
  const dest = mount.filesystems.find((m) => m.fstype === 'btrfs')
  if (!dest?.uuid) throw new Error('The T7 Btrfs backup drive is not mounted.')
  for (const source of cfg.nativeSources) {
    const mounted = JSON.parse(
      await checked(rt.run, ['findmnt', '--json', '-T', source, '-o', 'FSTYPE,UUID']),
    ) as { filesystems: { fstype: string; uuid: string }[] }
    if (
      !mounted.filesystems.some((m) => m.fstype === 'btrfs' && m.uuid !== dest.uuid) ||
      statSync(source).ino !== 256
    )
      throw new Error(`The backup target is not independent of ${source}.`)
  }
  // Nested durable subvolumes are never silently omitted by a parent snapshot.
  for (const source of cfg.nativeSources) {
    const mounting = JSON.parse(
      await checked(rt.run, ['findmnt', '--json', '-T', source, '-o', 'OPTIONS']),
    ) as { filesystems: { options: string }[] }
    const id = mounting.filesystems
      .map((m) => m.options.match(/(?:^|,)subvolid=(\d+)(?:,|$)/)?.[1])
      .find(Boolean)
    if (!id) throw new Error('The source subvolume identity could not be read.')
    const listing = await checked(rt.run, [
      'sudo',
      '-n',
      'btrfs',
      'subvolume',
      'list',
      '-t',
      '--',
      source,
    ])
    const lines = listing.trim().split('\n').slice(2)
    for (const line of lines) {
      const match = line.match(/^(\d+)\t(\d+)\t(\d+)\t+(\S.*)$/)
      if (!match) throw new Error('The nested subvolume listing is incomplete.')
      if (match[3] !== id) continue
      const nested = join(source, match[4] as string)
      const excluded =
        rows.some(
          (row) =>
            nested === row.source_url ||
            nested === row.snapshot_path ||
            nested.startsWith((row.snapshot_path ?? '') + '/'),
        ) ||
        nested.startsWith('/srv/workspaces/.snapshots/') ||
        nested === '/srv/workspaces/.snapshots'
      if (!excluded) throw new Error(`Nested subvolume needs explicit backup coverage: ${nested}`)
    }
  }
  const started = rt.now().toISOString()
  const runId =
    started.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') + '-' + randomBytes(4).toString('hex')
  const operation = nativeOperation(cfg, runId)
  mkdirSync(operation, { recursive: true, mode: 0o700 })
  const helper = ['sudo', '-n', cfg.nativeHelper]
  const window = ['sudo', '-n', cfg.windowHelper]
  await checked(rt.run, [...window, 'open', 'native', String(process.pid)])
  try {
    const packageDigest = await beginBootCapture(rt, runId)
    const preview = await checked(rt.run, [...base, '--dry-run', '--format', 'raw', 'run'])
    const existing = (await checked(rt.run, [...helper, 'list', 'target']))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((p) => basename(p))
    const deleting = rawRows(preview)
      .filter(
        (r) => r.type?.startsWith('delete') && dirname(r.target_url ?? '') === cfg.nativeTarget,
      )
      .map((r) => basename(r.target_url as string))
    const preserve = !scheduled || preserveNative(existing, deleting)

    const result = await rt.run([
      ...base,
      ...(preserve ? ['--preserve-backups'] : []),
      '--format',
      'raw',
      'run',
    ])
    writeFileSync(join(operation, 'journal.log'), result.out + '\n' + result.err, { mode: 0o600 })
    if (result.code) throw new Error(`The T7 capture failed (btrbk exit ${result.code}).`)
    if (
      createHash('sha256').update(readFileSync(cfg.packageStatusPath)).digest('hex') !==
      packageDigest
    )
      throw new Error(
        'Packages changed during capture; matching boot recovery could not be verified.',
      )
    const transactions = rawRows(result.out)
    const points: BackupPoint[] = []
    for (const row of rows) {
      const snapshot = transactions.find(
        (t) => t.type === 'snapshot' && t.status === 'success' && t.source_url === row.source_url,
      )?.target_url
      const target = transactions.find(
        (t) => t.type === 'send-receive' && t.status === 'success' && t.source_url === snapshot,
      )?.target_url
      if (!snapshot || !target || dirname(target) !== cfg.nativeTarget)
        throw new Error(`No verified received point for ${row.source_url}.`)
      const src = await checked(rt.run, ['sudo', '-n', 'btrfs', 'subvolume', 'show', snapshot])
      const dst = await checked(rt.run, ['sudo', '-n', 'btrfs', 'subvolume', 'show', target])
      const uuid = src.match(/^\s*UUID:\s*(\S+)/m)?.[1]
      if (!uuid || dst.match(/^\s*Received UUID:\s*(\S+)/m)?.[1] !== uuid)
        throw new Error('The received backup identity does not match its source.')
      if (
        (
          await checked(rt.run, ['sudo', '-n', 'btrfs', 'property', 'get', '-ts', target, 'ro'])
        ).trim() !== 'ro=true'
      )
        throw new Error('The received backup is not read only.')
      points.push({
        source: row.source_url as string,
        snapshot,
        target,
        dataAt: started,
        source_uuid: uuid,
        received_uuid: uuid,
      })
    }
    const disks = new Set<string>()
    const mounts: unknown[] = []
    for (const path of cfg.bootPaths) {
      if (!existsSync(path)) continue
      const fs = JSON.parse(
        await checked(rt.run, [
          'findmnt',
          '--json',
          '-T',
          path,
          '-o',
          'TARGET,FSTYPE,UUID,OPTIONS,FSROOT,SOURCE',
        ]),
      ) as { filesystems: { source: string }[] }
      mounts.push(...fs.filesystems)
      for (const m of fs.filesystems) {
        const block = m.source.split('[')[0] as string
        if (!block.startsWith('/dev/')) continue
        const ancestry = await checked(rt.run, [
          'lsblk',
          '--inverse',
          '--raw',
          '--noheadings',
          '--paths',
          '--output',
          'NAME,TYPE',
          block,
        ])
        for (const line of ancestry.trim().split('\n')) {
          const [dev, kind] = line.trim().split(/\s+/)
          if (dev && kind === 'disk') disks.add(dev)
        }
      }
    }
    const layouts = []
    for (const disk of disks)
      layouts.push({
        device: disk,
        partition_layout: await checked(rt.run, ['sudo', '-n', 'sfdisk', '--dump', disk]),
      })
    writeFileSync(join(operation, 'layout.json'), JSON.stringify({ mounts, disks: layouts }), {
      mode: 0o600,
    })
    const payload = {
      adapter: 'summitflow-btrbk-v1',
      run_id: runId,
      status: 'completed',
      started_at: started,
      finished_at: rt.now().toISOString(),
      target: cfg.nativeTarget,
      boot_path: join(
        dirname(cfg.nativeTarget),
        'summitflow-host-recovery',
        'captures',
        runId,
        'boot',
      ),
      points,
      capture_complete: true,
      artifacts_complete: true,
      package_digest: packageDigest,
      target_filesystem_uuid: dest.uuid,
      target_deletions_refused: preserve,
    }
    writeFileSync(join(operation, 'capture.json'), JSON.stringify(payload), { mode: 0o600 })
    for (const name of ['journal.log', 'layout.json', 'capture.json']) {
      const file = join(operation, name)
      const digest = createHash('sha256').update(readFileSync(file)).digest('hex')
      await checked(rt.run, [...helper, 'publish', runId, name, file, digest])
    }
    await checked(rt.run, ['sudo', '-n', 'btrfs', 'subvolume', 'sync', cfg.nativeTarget])
    if (scheduled) await cleanupExpiredMetadata(rt, runId)
    state.points = points
    for (const p of points)
      state.copies[copyKey(p.source, 'native')] = {
        source: p.source,
        target: 'native',
        dataAt: p.dataAt,
        snapshot: p.target,
        path: p.target,
        attemptedAt: started,
      }
  } finally {
    await checked(rt.run, [...window, 'close', 'native', String(process.pid)])
  }
}

export async function beginBootCapture(rt: Runtime, runId: string): Promise<string> {
  const digest = createHash('sha256').update(readFileSync(rt.cfg.packageStatusPath)).digest('hex')
  await checked(rt.run, ['sudo', '-n', rt.cfg.nativeHelper, 'copy-boot', runId])
  return digest
}

export function expiredCapture(
  value: unknown,
  cfg: BackupConfig,
  live: Set<string>,
  current: string,
): boolean {
  if (!value || typeof value !== 'object') return false
  const saved = value as Record<string, unknown>,
    id = saved.run_id
  if (
    typeof id !== 'string' ||
    !/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(id) ||
    id === current ||
    saved.adapter !== 'summitflow-btrbk-v1' ||
    !['completed', 'partial'].includes(String(saved.status)) ||
    saved.target !== cfg.nativeTarget ||
    saved.boot_path !==
      join(dirname(cfg.nativeTarget), 'summitflow-host-recovery', 'captures', id, 'boot') ||
    !Array.isArray(saved.points) ||
    !saved.points.length
  )
    return false
  return saved.points.every((point: unknown) => {
    if (!point || typeof point !== 'object') return false
    const target = (point as { target?: unknown }).target
    return typeof target === 'string' && dirname(target) === cfg.nativeTarget && !live.has(target)
  })
}
async function cleanupExpiredMetadata(rt: Runtime, current: string): Promise<void> {
  const helper = ['sudo', '-n', rt.cfg.nativeHelper]
  const live = new Set(
    (await checked(rt.run, [...helper, 'list', 'target'])).trim().split('\n').filter(Boolean),
  )
  const parent = join(dirname(rt.cfg.nativeTarget), 'summitflow-host-recovery', 'captures')
  const directories = (await checked(rt.run, [...helper, 'list', 'captures']))
    .trim()
    .split('\n')
    .filter(Boolean)
  for (const directory of directories) {
    const id = basename(directory)
    if (dirname(directory) !== parent || id === current || !/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(id))
      continue
    let saved: unknown
    try {
      saved = JSON.parse(await checked(rt.run, [...helper, 'read', id]))
    } catch {
      continue
    }
    if (expiredCapture(saved, rt.cfg, live, current))
      await checked(rt.run, [...helper, 'remove', id])
  }
}

export function nativeOperation(cfg: BackupConfig, runId: string): string {
  // The installed root helper accepts caller-owned files only in this existing staging tree.
  return join(homePath(cfg.nativeOperationsDir), runId)
}

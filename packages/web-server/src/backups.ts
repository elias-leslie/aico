// The HTTP boundary calls the installed ops bundle, so pages never execute dirty checkout code.
import { spawn } from 'node:child_process'
import { objectBody, type Router, requiredString } from './http'
import { HttpError } from './tether'

export type BackupCommand = (args: string[]) => Promise<unknown>
const backupCommand: BackupCommand = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn('aico', ['backups', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '',
      err = ''
    child.stdout.on('data', (data) => {
      out = (out + String(data)).slice(-(16 << 20))
    })
    child.stderr.on('data', (data) => {
      err = (err + String(data)).slice(-2000)
    })
    child.on('error', () => reject(new HttpError(503, 'Backups could not start on this machine.')))
    child.on('close', (code) => {
      if (code !== 0)
        return reject(
          new HttpError(
            code === 75 ? 409 : 502,
            err.trim() || 'The backup operation failed. Its last good copy is preserved.',
          ),
        )
      try {
        resolve(JSON.parse(out.trim()))
      } catch {
        reject(new HttpError(502, 'Backups returned an unreadable result.'))
      }
    })
  })
const targetOf = (value: string | null) => {
  if (value !== 'drive' && value !== 'append' && value !== 'native')
    throw new HttpError(422, 'Choose Drive or CT 160.')
  return value
}
/** A listing this young is answered at once, with a refresh started behind it
 * once it is older than FRESH_MS. The listing asks the Proxmox host over ssh,
 * which alone takes most of a second; the page polls every 15 s. */
export const FRESH_MS = 10_000
/** Past this age a failed refresh is an error, not a quiet fall back to old data. */
export const STALE_MS = 5 * 60_000

export function registerBackupRoutes(
  router: Router,
  run: BackupCommand = backupCommand,
  now: () => number = Date.now,
): void {
  let cached: { value: unknown; at: number } | null = null
  let refreshing: Promise<unknown> | null = null
  const refresh = () => {
    refreshing ??= run(['list', '--json'])
      .then((value) => {
        cached = { value, at: now() }
        return value
      })
      .finally(() => {
        refreshing = null
      })
    return refreshing
  }
  router.on('GET', '/api/backups', async () => {
    if (!cached) return refresh()
    if (now() - cached.at > FRESH_MS) {
      const next = refresh()
      if (now() - cached.at > STALE_MS) return next
      next.catch(() => {})
    }
    return cached.value
  })
  router.on('POST', '/api/backups/run', async (ctx) => {
    const body = objectBody(await ctx.body()),
      target = requiredString(body, 'target')
    if (!['native', 'drive', 'append'].includes(target))
      throw new HttpError(422, 'Choose T7, Drive or CT 160.')
    const started = await run(['request', target])
    cached = null
    return started
  })
  router.on('GET', '/api/backups/snapshots', (ctx) => {
    const source = ctx.query.get('source')
    if (!source) throw new HttpError(422, 'Choose a backup source.')
    return run(['snapshots', source, '--target', targetOf(ctx.query.get('target'))])
  })
  router.on('GET', '/api/backups/browse', (ctx) => {
    const source = ctx.query.get('source'),
      snapshot = ctx.query.get('snapshot'),
      path = ctx.query.get('path')
    if (!source || !snapshot || !path) throw new HttpError(422, 'Choose a snapshot and folder.')
    return run(['browse', source, snapshot, path, '--target', targetOf(ctx.query.get('target'))])
  })
  router.on('POST', '/api/backups/restore', async (ctx) => {
    const body = objectBody(await ctx.body())
    const source = requiredString(body, 'source'),
      snapshot = requiredString(body, 'snapshot'),
      path = requiredString(body, 'path'),
      to = requiredString(body, 'to')
    return run([
      'restore',
      source,
      snapshot,
      path,
      '--to',
      to,
      '--target',
      targetOf(requiredString(body, 'target')),
    ])
  })
}

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
export function registerBackupRoutes(router: Router, run: BackupCommand = backupCommand): void {
  router.on('GET', '/api/backups', () => run(['list', '--json']))
  router.on('POST', '/api/backups/run', async (ctx) => {
    const body = objectBody(await ctx.body()),
      target = requiredString(body, 'target')
    if (!['native', 'drive', 'append'].includes(target))
      throw new HttpError(422, 'Choose T7, Drive or CT 160.')
    return run(['request', target])
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

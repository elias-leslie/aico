import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { type BackupConfig, homePath } from './backup-plan'
import { checked, type Execute, execute } from './backup-runtime'

/** Use the same owner-held credential file as the previous capture, without logging its values. */
export async function captureRedis(
  cfg: BackupConfig,
  env = process.env,
  run: Execute = execute,
): Promise<string> {
  const spec = cfg.redisCapture
  const password =
    env[spec.passwordVariable] ||
    parseEnv(readFileSync(homePath(spec.passwordFile), 'utf8'))[spec.passwordVariable]
  if (!password) throw new Error('The configured Redis backup credential is unavailable.')
  mkdirSync(cfg.scratchRoot, { recursive: true, mode: 0o700 })
  const folder = mkdtempSync(join(cfg.scratchRoot, 'redis-'))
  const file = join(folder, 'dump.rdb')
  try {
    await checked(run, [...spec.command, '--rdb', file], {
      env: { PATH: env.PATH, LANG: 'C.UTF-8', REDISCLI_AUTH: password },
    })
    return file
  } catch (error) {
    rmSync(folder, { recursive: true, force: true })
    throw error
  }
}

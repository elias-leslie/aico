// The phone app's update: the signed APK and its release record, in <data>/app/. The app asks
// GET /api/app/update when it opens (hourly at most) and daily; when version_code is newer it
// downloads /api/app/apk and checks size and sha256 against the record before installing.
// `aico app publish-apk` writes both together; the record never names bytes that are not there.

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

const APK_NAME = 'aico.apk'

export interface Release {
  version_code: number
  version_name: string
  sha256: string
  size: number
}

export const releaseDir = (dataDir: string) => join(dataDir, 'app')
export const apkPath = (dataDir: string) => join(releaseDir(dataDir), APK_NAME)
const recordPath = (dataDir: string) => join(releaseDir(dataDir), 'release.json')

/**
 * Serves a built APK: version from Gradle's output-metadata.json beside it, digest and size from
 * the bytes. The APK goes first, the record after it.
 */
export function publishApk(dataDir: string, source: string): Release & { published_at: number } {
  const data = readFileSync(source)
  if (data[0] !== 0x50 || data[1] !== 0x4b) throw new Error('not an APK')
  const meta = JSON.parse(readFileSync(join(dirname(source), 'output-metadata.json'), 'utf8'))
  const element = (meta.elements ?? []).find(
    (e: { outputFile?: string }) => e.outputFile === basename(source),
  )
  if (!element) throw new Error(`output-metadata.json does not list ${basename(source)}`)
  const record = {
    version_code: Number(element.versionCode),
    version_name: String(element.versionName ?? ''),
    sha256: createHash('sha256').update(data).digest('hex'),
    size: data.length,
    published_at: Math.floor(Date.now() / 1000),
  }
  mkdirSync(releaseDir(dataDir), { recursive: true, mode: 0o700 })
  const apk = apkPath(dataDir)
  copyFileSync(source, `${apk}.tmp`)
  renameSync(`${apk}.tmp`, apk)
  writeFileSync(`${recordPath(dataDir)}.tmp`, JSON.stringify(record))
  renameSync(`${recordPath(dataDir)}.tmp`, recordPath(dataDir))
  return record
}

/** The published release; null when none is, or the record and the file disagree (a half-done publish). */
export function currentRelease(dataDir: string): Release | null {
  try {
    const record = JSON.parse(readFileSync(recordPath(dataDir), 'utf8'))
    if (!existsSync(apkPath(dataDir)) || statSync(apkPath(dataDir)).size !== record.size)
      return null
    const { version_code, version_name, sha256, size } = record
    if (!Number.isInteger(version_code) || typeof sha256 !== 'string') return null
    return { version_code, version_name: String(version_name), sha256, size }
  } catch {
    return null
  }
}

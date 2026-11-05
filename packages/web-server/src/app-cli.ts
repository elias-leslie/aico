// `aico app ...`: serving the phone app's update, and the outage drill (app-api.ts).
//
//   aico app publish-apk <apk>          serve a built APK and its release record (version from the
//                                       output-metadata.json beside it)
//   aico app drill start [--minutes N]  health answers 503 for N minutes (default 5, at most 120),
//                                       so the phone's real alarm path fires
//   aico app drill stop
//   aico app status                     the published release and whether a drill is on

import { drillUntil, setDrill } from './app-api'
import { currentRelease, publishApk } from './app-release'

const APP_USAGE = `Usage: aico app <command>

  publish-apk APK          Serve a built APK so the phone's updater offers it.
  drill start [--minutes N] Make the app's health check fail for N minutes (default 5, at most 120).
  drill stop               End the drill.
  status                   The published version, and whether a drill is on.
`

export interface AppCliIo {
  out(text: string): void
  err(text: string): void
  dataDir: string
  now(): number
}

export function runAppCli(argv: string[], io: AppCliIo): number {
  const [command, ...rest] = argv
  if (command === 'publish-apk' && rest.length === 1) {
    try {
      const release = publishApk(io.dataDir, rest[0] as string)
      io.out(
        `Serving version ${release.version_name} (code ${release.version_code}), ${release.size} bytes.\n`,
      )
      return 0
    } catch (error) {
      io.err(`Not published: ${(error as Error).message}\n`)
      return 1
    }
  }
  if (command === 'drill' && rest[0] === 'start') {
    const at = rest.indexOf('--minutes')
    const minutes = at < 0 ? 5 : Number(rest[at + 1])
    if (!Number.isFinite(minutes) || minutes <= 0) {
      io.err('--minutes takes a number of minutes\n')
      return 2
    }
    const until = setDrill(io.dataDir, minutes, io.now())
    io.out(`Drill on until ${new Date(until).toLocaleTimeString()}.\n`)
    return 0
  }
  if (command === 'drill' && rest[0] === 'stop') {
    setDrill(io.dataDir, null, io.now())
    io.out('Drill off.\n')
    return 0
  }
  if (command === 'status') {
    const release = currentRelease(io.dataDir)
    io.out(
      release
        ? `Serving version ${release.version_name} (code ${release.version_code}).\n`
        : 'No app is published.\n',
    )
    const until = drillUntil(io.dataDir, io.now())
    io.out(until ? `Drill on until ${new Date(until).toLocaleTimeString()}.\n` : 'No drill.\n')
    return 0
  }
  io.err(APP_USAGE)
  return 2
}

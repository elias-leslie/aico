// The `aico video` entry point (bundled to dist/aico-video.mjs).
import { runVideoCli } from './cli'
import { exec } from './ytdlp'

process.exitCode = await runVideoCli(process.argv.slice(2), {
  env: process.env,
  out: (text) => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`),
  err: (text) => process.stderr.write(text),
  exec,
  now: () => new Date(),
})

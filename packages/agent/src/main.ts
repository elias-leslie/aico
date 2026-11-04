// The `aico agent` entry point (bundled to dist/aico-agent.mjs).

import { main } from './cli'

process.exitCode = await main(process.argv.slice(2))

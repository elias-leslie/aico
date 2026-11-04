// The `aico agent` entry point (bundled to dist/aico-agent.mjs).

import { main } from './cli'

// Tether finds the agent in its pane by this process name (comm).
process.title = 'aico-agent'

process.exitCode = await main(process.argv.slice(2))

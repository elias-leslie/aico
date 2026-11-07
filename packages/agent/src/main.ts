// The `aico agent` and `aico prompt-model` entry point (bundled to dist/aico-agent.mjs).

import { askMain } from './ask'
import { main } from './cli'

// Tether finds the agent in its pane by this process name (comm).
process.title = 'aico-agent'

const argv = process.argv.slice(2)
process.exitCode = argv[0] === 'prompt-model' ? await askMain(argv.slice(1)) : await main(argv)

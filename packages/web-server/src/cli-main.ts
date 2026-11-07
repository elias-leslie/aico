// The CLI commands of the web server bundle (`aico memory | prompt | models | context | usage |
// logins | app | status | phones`, `tsession`, `tclaude`, `tcodex`, `tnotes`) as their own bundle,
// dist/aico-web-cli.mjs: they never start the server, so they skip loading the agent harness
// and everything else only serving needs (about 0.4 s of startup).

import { CLI_COMMANDS, runCli } from './cli'

const [command, ...args] = process.argv.slice(2)
if (command !== undefined && CLI_COMMANDS.includes(command)) {
  runCli(command, args).then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(error)
      process.exitCode = 1
    },
  )
} else {
  if (command !== undefined)
    console.error(`aico-web: unknown command '${command}' (commands: ${CLI_COMMANDS.join(', ')})`)
  else console.error(`aico-web: a command is needed (commands: ${CLI_COMMANDS.join(', ')})`)
  process.exitCode = 2
}

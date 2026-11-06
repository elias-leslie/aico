// `aico-web tnotes …`: import a Google Keep Takeout into
// Notes, and check the Keep import is complete.
//
//   tnotes import-keep <dir> [--dry-run] [--include-trashed]
//   tnotes verify-keep <dir> [--include-trashed]

import { join, resolve } from 'node:path'
import { dataDirPath, hostNameFrom } from './config'
import { NotesStore } from './notes-db'
import { importAll, keepReport, planKeep, readKeepFolder, verifyKeep } from './notes-import'

export interface NotesCliIo {
  out(text: string): void
  err(text: string): void
  env: NodeJS.ProcessEnv
  /** The repo checkout this CLI runs from. */
  repoRoot: string
}

/** What the commands need beyond their arguments; tests pass their own. */
export interface NotesCliDeps {
  notes: NotesStore
  blobsDir: string
}

const USAGE = `usage: tnotes <command>

  import-keep <dir> [--dry-run] [--include-trashed]
      Import a Google Keep Takeout (the folder you extracted, or its Takeout/Keep). Prints the report.
  verify-keep <dir> [--include-trashed]
      Check every Keep note, attachment and blob is in Notes; lists anything unmatched. Exit 1 if any.`

class UsageError extends Error {}

function parse(argv: string[], flags: string[], valued: string[] = []) {
  const set = new Set<string>()
  const values = new Map<string, string>()
  const positional: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (flags.includes(arg)) set.add(arg)
    else if (valued.includes(arg)) {
      const value = argv[i + 1]
      if (value === undefined) throw new UsageError(`tnotes: ${arg} needs a value`)
      values.set(arg, value)
      i += 1
    } else if (arg.startsWith('-')) throw new UsageError(`tnotes: unknown option ${arg}`)
    else positional.push(arg)
  }
  return { set, values, positional }
}

export async function runNotesCommand(
  io: NotesCliIo,
  deps: NotesCliDeps,
  argv: string[],
): Promise<number> {
  try {
    const [command, ...rest] = argv
    if (command === 'import-keep' || command === 'verify-keep') {
      const args = parse(
        rest,
        command === 'import-keep' ? ['--dry-run', '--include-trashed'] : ['--include-trashed'],
      )
      if (args.positional.length !== 1) throw new UsageError(USAGE)
      const folder = readKeepFolder(resolve(args.positional[0]))
      const includeTrashed = args.set.has('--include-trashed')
      if (command === 'verify-keep') {
        const result = verifyKeep(deps.notes.notes, deps.blobsDir, folder, includeTrashed)
        io.out(`${result.report}\n`)
        return result.problems.length === 0 ? 0 : 1
      }
      const dryRun = args.set.has('--dry-run')
      const plan = planKeep(folder, includeTrashed)
      const { counts, outcomes } = await importAll(
        deps.notes.notes,
        deps.blobsDir,
        plan.entries.map((entry) => entry.note),
        dryRun,
      )
      io.out(`${keepReport(plan, { dryRun, counts, outcomes })}\n`)
      return 0
    }
    if (command === undefined || command === '-h' || command === '--help') {
      io.out(`${USAGE}\n`)
      return command === undefined ? 2 : 0
    }
    throw new UsageError(`tnotes: unknown command '${command}'\n${USAGE}`)
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n`)
      return 2
    }
    io.err(`tnotes: ${(error as Error).message}\n`)
    return 1
  }
}

/** The real notes.db and blob folder of this machine's Aico. */
export async function runNotesCli(argv: string[], repoRoot: string): Promise<number> {
  const env = process.env
  const dataDir = dataDirPath(env)
  const notes = new NotesStore(join(dataDir, 'notes.db'), { hostName: hostNameFrom(env) })
  try {
    return await runNotesCommand(
      {
        out: (text) => process.stdout.write(text),
        err: (text) => process.stderr.write(text),
        env,
        repoRoot,
      },
      { notes, blobsDir: join(dataDir, 'blobs') },
      argv,
    )
  } finally {
    notes.close()
  }
}

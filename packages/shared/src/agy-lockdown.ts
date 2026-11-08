// The flags every headless `agy` call runs with. agy's print mode leaves file tools on, so text it
// reads (a log, a web page, a document) could otherwise make it read or overwrite the owner's files.
// A deny rule beats an allow rule in agy and it follows symlinks before checking, so a reader's file
// has to really be in its folder.

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import policy from '../data/agy-lockdown.json' with { type: 'json' }

/** The flags for a call that only answers from its prompt. `cwd` must be a folder of its own. */
export function agyAnswerFlags(cwd: string, withSchema: boolean): string[] {
  const flags = [
    '--settings',
    JSON.stringify({ permissions: { deny: [...policy.deny, 'read_file(*)'] } }),
    '--disable-slash-commands',
  ]
  if (withSchema) return flags
  const { name, description, body } = policy.answer_agent
  const dir = join(cwd, '.agents', 'agents')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}\nmainAgent: true\nsubagent: false\ntools: []\n---\n${body}\n`,
  )
  return ['--agent', name, ...flags]
}

/** Every path that isn't `dir`, one of its parents or inside it. */
export function outside(dir: string): string[] {
  const paths: string[] = []
  let parent = '/'
  for (const part of resolve(dir).split('/').filter(Boolean)) {
    for (const name of readdirSync(parent)) if (name !== part) paths.push(join(parent, name))
    parent = join(parent, part)
  }
  return paths
}

/** The flags for a call that may read `cwd` and nothing else. The rules go in a file: a busy /tmp makes them too long for an argument. */
export function agyReaderFlags(cwd: string): string[] {
  const settings = join(cwd, '.agy-settings.json')
  writeFileSync(
    settings,
    JSON.stringify({
      permissions: {
        allow: [`read_file(${resolve(cwd)})`],
        deny: [...policy.deny, ...outside(cwd).map((path) => `read_file(${path})`)],
      },
    }),
  )
  return ['--settings', settings, '--disable-slash-commands']
}

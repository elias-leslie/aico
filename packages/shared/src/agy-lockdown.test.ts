import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agyAnswerFlags, agyReaderFlags, outside } from './agy-lockdown'

const made: string[] = []
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-lockdown-'))
  made.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const settings = (flags: string[]) => flags[flags.indexOf('--settings') + 1] as string

describe('agy lockdown', () => {
  it('outside lists siblings at every level, never the folder or its parents', () => {
    const root = folder()
    mkdirSync(join(root, 'a/b'), { recursive: true })
    writeFileSync(join(root, 'secret'), 'x')
    writeFileSync(join(root, 'a/secret2'), 'x')
    symlinkSync('/etc', join(root, 'link'))
    const paths = outside(join(root, 'a/b'))
    expect(paths).toEqual(
      expect.arrayContaining([join(root, 'secret'), join(root, 'a/secret2'), join(root, 'link')]),
    )
    expect(paths).not.toContain(root)
    expect(paths).not.toContain(join(root, 'a'))
    expect(paths).not.toContain(join(root, 'a/b'))
    expect(paths).toContain('/etc')
  })

  it('a schema call names no agent, which would cost it structured output, and still denies every tool', () => {
    const flags = agyAnswerFlags(folder(), true)
    expect(flags).not.toContain('--agent')
    expect(JSON.parse(settings(flags)).permissions.deny).toEqual(
      expect.arrayContaining([
        'read_file(*)',
        'write_file(*)',
        'command(*)',
        'mcp(*)',
        'read_url(*)',
      ]),
    )
  })

  it('a call without a schema also names an agent with no tools', () => {
    const cwd = folder()
    const flags = agyAnswerFlags(cwd, false)
    const name = flags[flags.indexOf('--agent') + 1] as string
    expect(readFileSync(join(cwd, '.agents/agents', `${name}.md`), 'utf8')).toContain('tools: []')
  })

  it('a reader may read its own folder and no other, and writes nothing', () => {
    const cwd = folder()
    const { allow, deny } = JSON.parse(
      readFileSync(settings(agyReaderFlags(cwd)), 'utf8'),
    ).permissions
    expect(allow).toEqual([`read_file(${cwd})`])
    expect(deny).toEqual(expect.arrayContaining(['write_file(*)', 'command(*)', 'read_file(/etc)']))
    expect(deny).not.toContain(`read_file(${cwd})`)
  })
})

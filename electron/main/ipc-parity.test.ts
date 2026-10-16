import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Every IPC channel the preload bridge uses must have a main-process handler of
// the matching kind, and every main handler must be reachable from the bridge.
// A one-sided channel is either a dead handler or a renderer call that hangs
// (invoke) or vanishes (send).

const here = import.meta.dirname
const preload = readFileSync(resolve(here, '../preload/index.ts'), 'utf8')
const main = readdirSync(here, { recursive: true, encoding: 'utf8' })
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .map((name) => readFileSync(resolve(here, name), 'utf8'))
  .join('\n')

function channels(source: string, pattern: RegExp): string[] {
  return [...new Set([...source.matchAll(pattern)].map((m) => m[1] as string))].sort()
}

describe('preload and main IPC parity', () => {
  it('pairs every ipcRenderer.send with an ipcMain.on', () => {
    expect(channels(preload, /ipcRenderer\.send\(\s*'([^']+)'/g)).toEqual(
      channels(main, /ipcMain\.on\(\s*'([^']+)'/g),
    )
  })

  it('pairs every ipcRenderer.invoke with an ipcMain.handle', () => {
    expect(channels(preload, /ipcRenderer\.invoke\(\s*'([^']+)'/g)).toEqual(
      channels(main, /ipcMain\.handle\(\s*'([^']+)'/g),
    )
  })

  it('subscribes the preload only to channels main actually sends', () => {
    expect(channels(preload, /ipcRenderer\.on\(\s*'([^']+)'/g)).toEqual(
      channels(main, /webContents\.send\(\s*'([^']+)'/g),
    )
  })

  it('names every channel with a quoted literal, so none escapes the checks above', () => {
    const call =
      /\b(?:ipcRenderer\.(?:send|invoke|on|once)|ipcMain\.(?:on|once|handle|handleOnce)|webContents\.send)\(\s*(\S)/g
    const nonLiteral = (source: string) =>
      [...source.matchAll(call)].filter((m) => m[1] !== "'").map((m) => m[0])
    expect(nonLiteral(preload)).toEqual([])
    expect(nonLiteral(main)).toEqual([])
  })

  it('registers every main channel exactly once', () => {
    // The checks above dedupe, so they cannot see a channel registered twice.
    // A second ipcMain.handle throws at startup; a second ipcMain.on fires the
    // handler twice (every keystroke typed twice on pty:input).
    const registered = [
      ...main.matchAll(/ipcMain\.(?:on|once|handle|handleOnce)\(\s*'([^']+)'/g),
    ].map((m) => m[1] as string)
    const twice = registered.filter((name, i) => registered.indexOf(name) !== i)
    expect(twice).toEqual([])
    expect(registered.length).toBeGreaterThan(30)
  })

  it('finds channels at all, so a refactor cannot make the checks vacuous', () => {
    expect(channels(preload, /ipcRenderer\.send\(\s*'([^']+)'/g).length).toBeGreaterThan(10)
    expect(channels(preload, /ipcRenderer\.invoke\(\s*'([^']+)'/g).length).toBeGreaterThan(5)
    expect(channels(preload, /ipcRenderer\.on\(\s*'([^']+)'/g).length).toBeGreaterThan(5)
  })
})

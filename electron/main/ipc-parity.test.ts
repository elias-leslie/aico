import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Every IPC channel the preload bridge uses must have a main-process handler of
// the matching kind, and every main handler must be reachable from the bridge.
// A one-sided channel is either a dead handler or a renderer call that hangs
// (invoke) or vanishes (send).

const here = import.meta.dirname
const preload = readFileSync(resolve(here, '../preload/index.ts'), 'utf8')
const mainFiles = new Map(
  readdirSync(here, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => [name, readFileSync(resolve(here, name), 'utf8')] as const),
)
const main = [...mainFiles.values()].join('\n')
const root = mainFiles.get('index.ts') ?? ''

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

// Every channel lives in some module's register function, so a handler written
// but never registered passes every check above. The composition root must call
// each register function with ipcMain, and every IpcMain parameter must be
// named ipcMain so the channel scans above see what it registers.
describe('composition root IPC wiring', () => {
  const literal = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const registersChannels = /\bipcMain\.(?:on|once|handle|handleOnce)\(/
  const registerFunction = /(?:function\s+(\w+)|(\w+)\s*:)\s*\(\s*\w+\s*:\s*(?:Pick<\s*)?IpcMain\b/g
  const modules = [...mainFiles]
    .filter(([name, source]) => name !== 'index.ts' && registersChannels.test(source))
    .map(([name, source]) => ({
      name,
      source,
      registers: [...source.matchAll(registerFunction)].map((m) => (m[1] ?? m[2]) as string),
    }))

  /** The root's binding for a module: `const x = createY(` with createY imported from it. */
  function bindingFor(moduleName: string): string | undefined {
    const spec = literal(`./${moduleName.replace(/\.ts$/, '')}`)
    const imported = root.match(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*'${spec}'`))
    const names = (imported?.[1] ?? '')
      .split(',')
      .map((n) => n.trim().replace(/^type\s+/, ''))
      .filter(Boolean)
    for (const factory of names) {
      const bound = root.match(
        new RegExp(`const\\s+(\\w+)\\s*=\\s*(?:new\\s+)?${literal(factory)}\\(`),
      )
      if (bound) return bound[1]
    }
    return undefined
  }

  it('finds the register functions, so the check cannot pass vacuously', () => {
    expect(modules.length).toBeGreaterThan(5)
    for (const m of modules) expect(m.registers, m.name).not.toEqual([])
  })

  it('names every IpcMain parameter ipcMain', () => {
    const params = [...main.matchAll(/(\w+)\s*:\s*(?:Pick<\s*)?IpcMain\b/g)].map((m) => m[1])
    expect(params.length).toBeGreaterThan(5)
    expect(params.filter((name) => name !== 'ipcMain')).toEqual([])
  })

  it('calls every register function from the root with ipcMain', () => {
    const missing: string[] = []
    for (const m of modules) {
      for (const fn of m.registers) {
        const exported = new RegExp(`export\\s+function\\s+${literal(fn)}\\b`).test(m.source)
        const binding = exported ? undefined : bindingFor(m.name)
        const call = exported ? fn : binding ? `${binding}.${fn}` : undefined
        if (!call || !new RegExp(`\\b${literal(call)}\\(\\s*ipcMain\\b`).test(root))
          missing.push(`${m.name}: ${call ?? fn}`)
      }
    }
    expect(missing).toEqual([])
  })
})

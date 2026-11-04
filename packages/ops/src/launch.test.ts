import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { run } from './sh'

let top = ''
afterEach(() => {
  if (top) rmSync(top, { recursive: true, force: true })
})

it('the launcher exports committed ops on first use and pins the installed bundle for detached jobs', () => {
  top = mkdtempSync(join(tmpdir(), 'aico-ops-launch-'))
  const root = join(top, 'repo')
  const installed = join(top, 'installed')
  const script = join(root, 'packages/web-server/scripts/aico')
  const put = (path: string, text: string) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }
  const actualRoot = new URL('../../..', import.meta.url).pathname
  for (const file of ['aico', 'lib/aico-web.sh'])
    put(
      join(root, 'packages/web-server/scripts', file),
      readFileSync(join(actualRoot, 'packages/web-server/scripts', file), 'utf8'),
    )
  put(
    join(root, 'packages/ops/data/ops.json'),
    JSON.stringify({ deploy: { installedOps: installed } }),
  )
  const source = join(root, 'packages/ops/src/main.mjs')
  put(
    source,
    'console.log(JSON.stringify({version:"committed",self:process.argv[1],args:process.argv.slice(2)}))\n',
  )
  const bin = join(top, 'bin')
  put(
    join(bin, 'npm'),
    '#!/bin/sh\n[ "$1" != ci ] || exit 0\nmkdir -p packages/ops/dist\ncp packages/ops/src/main.mjs packages/ops/dist/aico-ops.mjs\n',
  )
  put(join(bin, 'st'), '#!/bin/sh\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n')
  for (const file of ['npm', 'st']) chmodSync(join(bin, file), 0o755)
  symlinkSync(process.execPath, join(bin, 'node'))
  const git = (...args: string[]) => run('git', ['-C', root, ...args])
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  expect(
    git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture')
      .code,
  ).toBe(0)
  const sha = git('rev-parse', 'HEAD').out.trim()
  writeFileSync(source, 'throw new Error("dirty source ran")\n')
  const launch = () =>
    run('bash', [script, 'deploy', '--detach'], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        AICO_NODE: join(bin, 'node'),
        AICO_OPS_INSTALLED: installed,
      },
    })
  const first = launch()
  expect(first.code, first.err).toBe(0)
  const exported = join(`${installed}.bootstrap`, sha)
  expect(JSON.parse(first.out)).toEqual({
    version: 'committed',
    self: join(exported, 'packages/ops/dist/aico-ops.mjs'),
    args: ['deploy', '--detach'],
  })
  expect(launch().out).toBe(first.out)
  symlinkSync(exported, installed)
  expect(launch().out).toBe(first.out)
})

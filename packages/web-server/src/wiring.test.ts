import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const here = import.meta.dirname
const sources = (readdirSync(here, { recursive: true }) as string[]).filter(
  (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
)
const read = (file: string) => readFileSync(join(here, file), 'utf8')

// The server's routes are on only once main.ts or api.ts calls them: memory and the morning digest
// each shipped with passing tests and no route, because a route's tests build their own router.
it('every set of routes is wired into the server', () => {
  const declared = sources.flatMap((file) =>
    [...read(file).matchAll(/^export (?:async )?function (register\w+)/gm)].map((m) => m[1]),
  )
  const wiring = read('main.ts') + read('api.ts')
  expect(declared.length).toBeGreaterThan(20)
  expect(declared.filter((name) => !wiring.includes(`${name}(`))).toEqual([])
})

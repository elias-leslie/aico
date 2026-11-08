import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { aicoDataDir } from './data-dir'

it('takes AICO_DATA_DIR, else aico under the XDG state folder, else under ~/.local/state', () => {
  expect(aicoDataDir({ AICO_DATA_DIR: ' /srv/aico ', XDG_STATE_HOME: '/x' })).toBe('/srv/aico')
  expect(aicoDataDir({ XDG_STATE_HOME: '/x/state', HOME: '/h' })).toBe('/x/state/aico')
  expect(aicoDataDir({ HOME: '/h' })).toBe('/h/.local/state/aico')
  expect(aicoDataDir({ AICO_DATA_DIR: '  ', XDG_STATE_HOME: '' })).toBe(
    join(homedir(), '.local', 'state', 'aico'),
  )
})

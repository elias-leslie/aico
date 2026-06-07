import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listProjects,
  PERSONAL_WORKSPACE_ID,
  PERSONAL_WORKSPACE_NAME,
  personalWorkspaceRoot,
  projectRoot,
  readActiveProjectRoot,
  widgetCwd,
} from './project'

describe('active-project pointer', () => {
  let dir: string
  let ptr: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aico-proj-'))
    ptr = join(dir, 'active-project.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads the project root from the pointer', () => {
    writeFileSync(ptr, JSON.stringify({ project_id: 'aico', project_root: dir }))
    expect(readActiveProjectRoot(ptr)).toBe(dir)
  })

  it('returns null when the pointer is missing', () => {
    expect(readActiveProjectRoot(join(dir, 'nope.json'))).toBeNull()
  })

  it('returns null when the pointer carries no root', () => {
    writeFileSync(ptr, JSON.stringify({ project_id: 'aico', project_root: null }))
    expect(readActiveProjectRoot(ptr)).toBeNull()
  })

  it('returns null for malformed json', () => {
    writeFileSync(ptr, '{not json')
    expect(readActiveProjectRoot(ptr)).toBeNull()
  })

  it('widgetCwd uses the active root when it is an existing directory', () => {
    writeFileSync(ptr, JSON.stringify({ project_id: 'aico', project_root: dir }))
    expect(widgetCwd('/home/me', ptr)).toBe(dir)
  })

  it('widgetCwd falls back to home when the root no longer exists', () => {
    writeFileSync(ptr, JSON.stringify({ project_id: 'aico', project_root: '/gone/missing' }))
    expect(widgetCwd('/home/me', ptr)).toBe('/home/me')
  })

  it('widgetCwd falls back to home when the pointer is unset', () => {
    expect(widgetCwd('/home/me', join(dir, 'nope.json'))).toBe('/home/me')
  })
})

describe('project catalog', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aico-cat-'))
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })

  it('prepends Personal Workspace to `st projects list` results', () => {
    const exec = () =>
      JSON.stringify([
        { id: 'aico', name: 'Aico', root_path: '/opt/aico', current: true },
        { id: 'a-term', name: 'A-Term', root_path: '/opt/a-term', current: false },
      ])
    expect(listProjects(exec)).toEqual([
      {
        id: PERSONAL_WORKSPACE_ID,
        name: PERSONAL_WORKSPACE_NAME,
        root: personalWorkspaceRoot(),
        current: false,
      },
      { id: 'aico', name: 'Aico', root: '/opt/aico', current: true },
      { id: 'a-term', name: 'A-Term', root: '/opt/a-term', current: false },
    ])
  })

  it('listProjects still returns Personal Workspace when st is unavailable', () => {
    expect(
      listProjects(() => {
        throw new Error('command not found: st')
      }),
    ).toEqual([
      {
        id: PERSONAL_WORKSPACE_ID,
        name: PERSONAL_WORKSPACE_NAME,
        root: personalWorkspaceRoot(),
        current: false,
      },
    ])
  })

  it('listProjects still returns Personal Workspace for malformed output', () => {
    expect(listProjects(() => 'not json')).toEqual([
      {
        id: PERSONAL_WORKSPACE_ID,
        name: PERSONAL_WORKSPACE_NAME,
        root: personalWorkspaceRoot(),
        current: false,
      },
    ])
  })

  it('projectRoot creates and returns the Personal Workspace root', () => {
    vi.stubEnv('HOME', dir)
    const root = projectRoot(PERSONAL_WORKSPACE_ID, () => {
      throw new Error('st should not be called for Personal Workspace')
    })
    expect(root).toBe(join(dir, '.local', 'share', 'aico', 'personal-workspace'))
    expect(root && existsSync(root)).toBe(true)
  })

  it('projectRoot returns the root when it is an existing directory', () => {
    expect(projectRoot('aico', () => `${dir}\n`)).toBe(dir)
  })

  it('projectRoot returns null when the root no longer exists', () => {
    expect(projectRoot('aico', () => '/gone/missing')).toBeNull()
  })

  it('projectRoot returns null when st fails (unknown slug)', () => {
    expect(
      projectRoot('nope', () => {
        throw new Error('unknown project')
      }),
    ).toBeNull()
  })
})

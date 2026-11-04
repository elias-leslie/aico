import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type Runner, run } from './sh'
import {
  find,
  loadPoints,
  type Point,
  restore,
  type SnapDeps,
  scopeAt,
  storeFor,
  take,
} from './snapshots'

let top = ''
afterEach(() => {
  if (top) rmSync(top, { recursive: true, force: true })
})

// Btrfs stubbed by plain copies: a snapshot is `cp -a`, a subvolume delete is `rm -rf`.
function setup(production = false) {
  top = mkdtempSync(join(tmpdir(), 'aico-snaps-'))
  const workspacesRoot = production ? join(top, 'vol') : '/srv/workspaces'
  const root = join(top, 'vol', 'proj')
  mkdirSync(root, { recursive: true })
  const g = (...args: string[]) =>
    run('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args])
  g('init', '-q', '-b', 'main')
  writeFileSync(join(root, 'f.txt'), 'one\n')
  g('add', '-A')
  g('commit', '-qm', 'one')
  const stub: Runner = (cmd, args, options) => {
    if (cmd === 'btrfs' && args[1] === 'snapshot') {
      const [source, dest] = args.slice(-2) as [string, string]
      return run('cp', ['-a', source, dest])
    }
    if (cmd === 'btrfs' && args[1] === 'delete') return run('rm', ['-rf', args[2] as string])
    return run(cmd, args, options)
  }
  const out: string[] = []
  const deps: SnapDeps = {
    run: stub,
    out: (line) => out.push(line),
    catalogue: join(top, 'catalogue'),
    workspacesRoot,
    now: () => new Date('2026-11-04T12:00:00Z'),
    relock: () => null,
    boundary: () => root,
  }
  return { root, deps, scope: scopeAt(root, stub, 'scratch') }
}

describe('aico snapshots', () => {
  it('takes a point into the st catalogue and restores it on its own subvolume', () => {
    const { root, deps, scope } = setup()
    const point = take(deps, scope, 'before x')
    expect(point).toMatchObject({
      name: 'before x',
      source: 'manual',
      scope_type: 'project',
      capture_root: root,
      branch: 'main',
    })
    expect(point.id).toMatch(/^20261104T120000Z-before-x-[0-9a-f]{8}$/)
    expect(point.snapshot_path).toBe(
      join(top, 'vol', '.snapshots', 'scratch', 'projects', 'scratch', point.id),
    )
    const manifest = JSON.parse(
      readFileSync(join(deps.catalogue, 'scratch', 'project-scratch', 'manifest.json'), 'utf8'),
    )
    expect(Object.keys(manifest[0])).toEqual(
      expect.arrayContaining(['head_oid', 'git_dir', 'project_relative_path', 'recovery_copies']),
    )

    writeFileSync(join(root, 'f.txt'), 'two\n')
    writeFileSync(join(root, 'new.txt'), 'x\n')
    const { saved } = restore(deps, scope, '-1')
    expect(readFileSync(join(root, 'f.txt'), 'utf8')).toBe('one\n')
    expect(existsSync(join(root, 'new.txt'))).toBe(false)
    expect(existsSync(`${root}.__rollback_old__`)).toBe(false)
    expect(loadPoints(deps, scope).find((p) => p.id === point.id)?.last_restored_at).toBe(
      '2026-11-04T12:00:00.000Z',
    )
    // The tree it replaced was saved first, so the restore can be undone.
    expect(saved.name).toBe('pre-restore')
    restore(deps, scope, saved.id)
    expect(readFileSync(join(root, 'f.txt'), 'utf8')).toBe('two\n')
    expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('x\n')
  })

  it("resolves -N against the list st rollback's preview shows: every entry, newest first as text", () => {
    const { deps, scope } = setup()
    const entry = (id: string, created_at: string, scope_path = scope.root) =>
      ({ id, name: null, created_at, scope_path }) as unknown as Point
    const dir = join(deps.catalogue, 'scratch', 'project-scratch')
    mkdirSync(dir, { recursive: true })
    // st writes microseconds and +00:00, Aico writes milliseconds and Z; Python orders them as plain text.
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify([
        entry('st-1', '2026-11-04T12:00:00.000000+00:00'),
        entry('aico-1', '2026-11-04T12:00:00.000Z'),
        entry('elsewhere', '2026-11-04T13:00:00.000Z', '/other/root'),
        entry('st-0', '2026-11-04T11:59:59.999999+00:00'),
      ]),
    )
    const python = run('python3', [
      '-c',
      'import json,sys; e=json.load(open(sys.argv[1])); e.sort(key=lambda x: x["created_at"], reverse=True); print(" ".join(x["id"] for x in e))',
      join(dir, 'manifest.json'),
    ]).out.trim()
    expect(
      loadPoints(deps, scope)
        .map((p) => p.id)
        .join(' '),
    ).toBe(python)
    expect(find(loadPoints(deps, scope), '-1').id).toBe('elsewhere')
    expect(() => restore(deps, scope, '-1')).toThrow(/belongs to \/other\/root/)
  })

  it('refuses restore inside the production workspace or of a shared-boundary point', () => {
    const prod = setup(true)
    take(prod.deps, prod.scope, null)
    expect(() => restore(prod.deps, prod.scope, '-1')).toThrow(
      /production project restore is refused/,
    )
    rmSync(top, { recursive: true, force: true })

    const shared = setup()
    take(shared.deps, shared.scope, null)
    shared.deps.boundary = () => join(top, 'vol')
    expect(() => restore(shared.deps, shared.scope, '-1')).toThrow(/its own subvolume/)
  })

  it('finds a point by index, id, name or id prefix; stores workspace points in the workspace store', () => {
    const points = [
      { id: 'b-2', name: 'later' },
      { id: 'a-1', name: 'first' },
    ] as Point[]
    expect(find(points, '-2').id).toBe('a-1')
    expect(find(points, 'later').id).toBe('b-2')
    expect(find(points, 'a-').id).toBe('a-1')
    expect(() => find(points, '-3')).toThrow(/out of range/)
    const deps = { workspacesRoot: '/srv/workspaces' } as SnapDeps
    expect(
      storeFor(deps, '/srv/workspaces', { project: 'aico', root: '/srv/workspaces/projects/aico' }),
    ).toBe('/srv/workspaces/.snapshots/aico/projects/aico')
  })
})

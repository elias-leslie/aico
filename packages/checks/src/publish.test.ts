import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StatusRow } from '@aico/status'
import { openTasksDb, Registry } from '@aico/tasks'
import { afterEach, expect, it, vi } from 'vitest'
import { accept } from './accept'
import { runCheck } from './check'
import { commit } from './commit'
import type { Coordination } from './hook'
import { localCheck, recordLocalCheck } from './local-check'
import { type Config, loadConfig } from './plan'
import { publicationPolicyCli, publicationRow, publishRepos } from './publish'
import { receiptStore } from './run'
import type { CheckSummary } from './status'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('policy controls update the registry that scheduled and manual publishing read', async () => {
  const root = repo()
  const file = join(root, '.git', 'tasks.db')
  const db = openTasksDb(file)
  const registry = new Registry(db)
  registry.register({ id: 'example', root })
  recordLocalCheck(root, git(root, 'rev-parse', 'HEAD'), result(true))
  const env = { AICO_TASKS_DB: file }
  const deliver = vi.fn(async () => ({ publication_complete: true, reason: 'source_published' }))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  await publicationPolicyCli(['--source', 'example', '--hold', '--reason', 'owner hold'], env)
  expect((await publishRepos(registry.list(), { deliver }))[0].reason).toBe('owner_hold')
  await publicationPolicyCli(['--source', 'example', '--release', '--mode', 'manual'], env)
  expect((await publishRepos(registry.list(), { deliver }))[0].reason).toBe('manual_mode')
  expect(deliver).not.toHaveBeenCalled()
  expect((await publishRepos(registry.list(), { deliver, manual: true }))[0].state).toBe('ok')
  await publicationPolicyCli(['--source', 'example', '--mode', 'nightly'], env)
  expect((await publishRepos(registry.list(), { deliver }))[0].state).toBe('ok')
  db.close()
})
const git = (root: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const coordination: Coordination = { foreign: () => ({}), guard: () => null, committed: () => '' }
const result = (passed: boolean): CheckSummary => ({
  lane: 'quick',
  passed,
  ms: 10,
  results: [{ id: 'types', state: passed ? 'pass' : 'fail', required: true, ms: 10 }],
})
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'aico-publish-'))
  roots.push(root)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.invalid')
  git(root, 'config', 'user.name', 'Test')
  writeFileSync(
    join(root, '.st-check.toml'),
    `[native]\nlegacy_tools = []\n[native.tools]\nnode = ${JSON.stringify(process.execPath)}\n[[native.stages]]\nid = "types"\nkind = "check"\ncoverage = "full"\nquick = true\nargv = ["node", "-e", "process.exit(0)"]\n`,
  )
  writeFileSync(join(root, '.gitignore'), '.dev-tools/\n')
  writeFileSync(join(root, 'note'), 'initial')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'initial')
  return root
}
const project = (root: string, id = 'example') => ({ id, root_path: root, agent_configs: {} })
const config = (root: string) => loadConfig(root) as Config

it('publishes passed main, refuses failed or unchecked commits, and clears the same Status row', async () => {
  const root = repo()
  const sha = git(root, 'rev-parse', 'HEAD')
  const deliver = vi.fn(async () => ({
    publication_complete: true,
    pushed: true,
    reason: 'source_published',
  }))
  const rows: StatusRow[] = []
  const options = {
    deliver,
    post: async (row: StatusRow) => {
      rows.push(row)
    },
  }
  expect((await publishRepos([project(root)], options))[0].reason).toBe('unchecked_commit')
  expect(deliver).not.toHaveBeenCalled()
  expect(rows.at(-1)).toMatchObject({ id: 'publish:example', state: 'failed' })
  recordLocalCheck(root, sha, result(false))
  expect((await publishRepos([project(root)], options))[0].reason).toBe('local_check_failed')
  expect(rows.at(-1)?.meaning).toContain('types')
  expect(deliver).not.toHaveBeenCalled()
  recordLocalCheck(root, sha, result(true))
  expect((await publishRepos([project(root)], options))[0]).toMatchObject({
    state: 'ok',
    pushed: true,
    sha,
  })
  expect(deliver).toHaveBeenCalledWith(root, sha, [])
  expect(rows.at(-1)).toMatchObject({ id: 'publish:example', state: 'ok' })
})

it('a pass on the previous commit or a tampered tree never checks a new main', async () => {
  const root = repo()
  recordLocalCheck(root, git(root, 'rev-parse', 'HEAD'), result(true))
  writeFileSync(join(root, 'note'), 'new')
  git(root, 'commit', '-qam', 'new')
  const sha = git(root, 'rev-parse', 'HEAD')
  expect((await publishRepos([project(root)], { dryRun: true }))[0].reason).toBe('unchecked_commit')
  const receipt = recordLocalCheck(root, sha, result(true))
  receiptStore(root).put(`publish-${sha}`, { ...receipt, tree: '0'.repeat(40) })
  expect(localCheck(root, sha)).toBeNull()
})

it('uses main rather than the checked-out branch and rejects a requested older source', async () => {
  const root = repo()
  const sha = git(root, 'rev-parse', 'main')
  recordLocalCheck(root, sha, result(true))
  git(root, 'switch', '-qc', 'work')
  writeFileSync(join(root, 'note'), 'work')
  git(root, 'commit', '-qam', 'work')
  expect((await publishRepos([project(root)], { dryRun: true }))[0].sha).toBe(sha)
  expect((await publishRepos([project(root)], { dryRun: true, sha: 'work' }))[0].reason).toBe(
    'source_is_not_main',
  )
})

it('does not open excluded, manually published or owner-held repos', async () => {
  const deliver = vi.fn()
  const rows = await publishRepos(
    [
      { ...project('/never-open', 'neri') },
      { ...project('/never-open', 'manual'), agent_configs: { publication_mode: 'manual' } },
      {
        ...project('/never-open', 'held'),
        agent_configs: { publication_hold: { reason: 'owner hold' } },
      },
    ],
    { deliver },
  )
  expect(rows.map((r) => r.reason)).toEqual(['excluded_project', 'manual_mode', 'owner_hold'])
  expect(deliver).not.toHaveBeenCalled()
})

it('a transport refusal stays failed and a dry run neither pushes nor posts', async () => {
  const root = repo()
  recordLocalCheck(root, git(root, 'rev-parse', 'HEAD'), result(true))
  const deliver = vi.fn(async () => ({
    publication_complete: false,
    reason: 'outgoing_verification_failed',
  }))
  const post = vi.fn()
  expect((await publishRepos([project(root)], { deliver, post }))[0].state).toBe('failed')
  deliver.mockClear()
  post.mockClear()
  await publishRepos([project(root)], { deliver, post, dryRun: true })
  expect(deliver).not.toHaveBeenCalled()
  expect(post).not.toHaveBeenCalled()
  expect(
    publicationRow({
      project: 'p',
      sha: null,
      failed: [],
      state: 'failed',
      publication_complete: false,
      reason: 'local_check_failed',
    }).actions,
  ).toEqual([{ kind: 'run', ref: 'aico publish --source p' }])
})

it('commit and clean-tree acceptance record their exact commit, including a reused acceptance', async () => {
  const root = repo()
  writeFileSync(join(root, 'note'), 'changed')
  const committed = await commit(config(root), {
    paths: ['note'],
    message: 'changed',
    coordination,
  })
  expect(localCheck(root, committed.sha)).toMatchObject({ passed: true, sha: committed.sha })
  await accept(config(root), { coordination })
  expect(localCheck(root, committed.sha)?.lane).toBe('acceptance')
  await accept(config(root), { coordination })
  expect(localCheck(root, committed.sha)?.passed).toBe(true)
})

it('skipping checks creates no publication pass and the nightly schedule calls Aico', async () => {
  const root = repo()
  writeFileSync(join(root, 'note'), 'unchecked')
  const committed = await commit(config(root), {
    paths: ['note'],
    message: 'unchecked',
    coordination,
    noCheck: true,
  })
  expect(localCheck(root, committed.sha)).toBeNull()
  await runCheck(config(root), { lane: 'quick', coordination })
  expect(localCheck(root, committed.sha)).toBeNull()
  const jobs = JSON.parse(
    readFileSync(new URL('../../jobs/data/jobs.json', import.meta.url), 'utf8'),
  ).jobs
  expect(jobs.find((j: { kind: string }) => j.kind === 'github-publish')).toMatchObject({
    at: '03:05',
    run: { command: ['../../web-server/scripts/aico', 'publish', '--all'] },
  })
})

it('never calls a selected commit checked when an uncommitted dependency made its gate pass', async () => {
  const root = repo()
  writeFileSync(join(root, 'helper'), 'deny')
  writeFileSync(
    join(root, '.st-check.toml'),
    `[native]\nlegacy_tools = []\n[native.tools]\nnode = ${JSON.stringify(process.execPath)}\n[[native.stages]]\nid = "helper"\nkind = "check"\ncoverage = "full"\nquick = true\nargv = ["node", "-e", "process.exit(require('fs').readFileSync('helper', 'utf8') === 'allow' ? 0 : 1)"]\n`,
  )
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'failing committed dependency')
  writeFileSync(join(root, 'helper'), 'allow')
  writeFileSync(join(root, 'note'), 'selected')
  const committed = await commit(config(root), {
    paths: ['note'],
    message: 'selected',
    coordination,
  })
  expect(git(root, 'show', `${committed.sha}:helper`)).toBe('deny')
  expect(localCheck(root, committed.sha)?.passed).not.toBe(true)
})

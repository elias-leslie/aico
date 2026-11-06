import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
const result = (passed: boolean, lane: CheckSummary['lane'] = 'full'): CheckSummary => ({
  lane,
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

it('a quick or file-scoped pass never proves main, and never replaces a whole-tree pass', async () => {
  const root = repo()
  const sha = git(root, 'rev-parse', 'HEAD')
  recordLocalCheck(root, sha, result(true, 'quick'))
  expect((await publishRepos([project(root)], { dryRun: true }))[0].reason).toBe('unchecked_commit')
  recordLocalCheck(root, sha, { ...result(true), scope: ['note'] })
  expect(localCheck(root, sha)?.lane).toBe('quick')
  expect((await publishRepos([project(root)], { dryRun: true }))[0].reason).toBe('unchecked_commit')
  recordLocalCheck(root, sha, result(true, 'acceptance'))
  recordLocalCheck(root, sha, result(true, 'quick'))
  expect(localCheck(root, sha)?.lane).toBe('acceptance')
  expect((await publishRepos([project(root)], { dryRun: true }))[0].reason).toBe('checked_main')
})

it('an unchecked tip never carries checked ancestors out, nor a checked ancestor its tip', async () => {
  const root = repo()
  recordLocalCheck(root, git(root, 'rev-parse', 'HEAD'), result(true))
  writeFileSync(join(root, 'note'), 'unchecked')
  git(root, 'commit', '-qam', 'unchecked')
  const deliver = vi.fn()
  expect((await publishRepos([project(root)], { deliver }))[0].reason).toBe('unchecked_commit')
  expect(deliver).not.toHaveBeenCalled()
})

it('a hold through REV publishes REV once main contains it, never the commits after it', async () => {
  const root = repo()
  const through = git(root, 'rev-parse', 'HEAD')
  recordLocalCheck(root, through, result(true))
  writeFileSync(join(root, 'note'), 'later')
  git(root, 'commit', '-qam', 'later')
  const deliver = vi.fn(async () => ({ publication_complete: true, reason: 'source_published' }))
  const held = {
    ...project(root),
    agent_configs: { publication_hold: { through, reason: 'owner hold' } },
  }
  expect((await publishRepos([held], { deliver }))[0]).toMatchObject({ state: 'ok', sha: through })
  expect(deliver).toHaveBeenCalledWith(root, through, [])
  deliver.mockClear()
  git(root, 'switch', '-qc', 'side', `${through}`)
  writeFileSync(join(root, 'note'), 'side')
  git(root, 'commit', '-qam', 'side')
  const side = git(root, 'rev-parse', 'HEAD')
  git(root, 'switch', '-q', 'main')
  const offMain = { ...held, agent_configs: { publication_hold: { through: side, reason: 'x' } } }
  expect((await publishRepos([offMain], { deliver }))[0].reason).toBe('owner_hold')
  expect(deliver).not.toHaveBeenCalled()
})

it('one failed Status post leaves the rest of the pass running', async () => {
  const first = repo()
  const second = repo()
  for (const root of [first, second])
    recordLocalCheck(root, git(root, 'rev-parse', 'HEAD'), result(true))
  const deliver = vi.fn(async () => ({ publication_complete: true, reason: 'source_published' }))
  const post = vi.fn(async () => {
    throw new Error('Publication Status answered 502')
  })
  const rows = await publishRepos([project(first, 'one'), project(second, 'two')], {
    deliver,
    post,
  })
  expect(rows.map((r) => [r.state, r.status_unposted])).toEqual([
    ['ok', true],
    ['ok', true],
  ])
  expect(deliver).toHaveBeenCalledTimes(2)
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
  await runCheck(config(root), { lane: 'quick', coordination, env: {} })
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

const commitFile = (root: string, file: string, text: string) => {
  mkdirSync(dirname(join(root, file)), { recursive: true })
  writeFileSync(join(root, file), text)
  git(root, 'add', '.')
  git(root, 'commit', '-qm', `edit ${file}`)
  return git(root, 'rev-parse', 'HEAD')
}
const accept1 = (root: string) =>
  recordLocalCheck(root, git(root, 'rev-parse', 'HEAD'), result(true, 'acceptance'))
const decide = async (root: string) => (await publishRepos([project(root)], { dryRun: true }))[0]

it('acceptance carries over commits that change docs only, and says where it came from', async () => {
  const root = repo()
  accept1(root)
  const accepted = git(root, 'rev-parse', 'HEAD')
  commitFile(root, 'ROADMAP.md', 'next')
  commitFile(root, 'docs/plans/a/notes.txt', 'plan')
  commitFile(root, 'sub/README.md', 'readme')
  recordLocalCheck(root, git(root, 'rev-parse', 'HEAD'), result(true, 'quick'))
  const row = await decide(root)
  expect(row).toMatchObject({ reason: 'checked_main', state: 'ok' })
  expect(publicationRow(row).meaning).toContain(
    `accepted at ${accepted.slice(0, 10)}; later commits change docs only`,
  )
})

it('a code file anywhere in the chain leaves the commit unaccepted', async () => {
  const root = repo()
  accept1(root)
  commitFile(root, 'src/app.ts', 'export {}')
  commitFile(root, 'ROADMAP.md', 'next')
  expect((await decide(root)).reason).toBe('unchecked_commit')
  const root2 = repo()
  accept1(root2)
  commitFile(root2, 'docs/x.md', 'x')
  commitFile(root2, 'note', 'changed code')
  expect((await decide(root2)).reason).toBe('unchecked_commit')
})

it('a code change undone before HEAD is the accepted tree again', async () => {
  const root = repo()
  accept1(root)
  commitFile(root, 'note', 'other')
  commitFile(root, 'note', 'initial')
  expect((await decide(root)).reason).toBe('checked_main')
})

it('no accepted ancestor, or only a quick or failed one, leaves docs-only commits unaccepted', async () => {
  const root = repo()
  recordLocalCheck(root, git(root, 'rev-parse', 'HEAD'), result(true, 'quick'))
  commitFile(root, 'ROADMAP.md', 'next')
  expect((await decide(root)).reason).toBe('unchecked_commit')
  const failed = repo()
  recordLocalCheck(failed, git(failed, 'rev-parse', 'HEAD'), result(false, 'acceptance'))
  commitFile(failed, 'ROADMAP.md', 'next')
  expect((await decide(failed)).reason).toBe('unchecked_commit')
  const own = repo()
  accept1(own)
  commitFile(own, 'ROADMAP.md', 'next')
  recordLocalCheck(own, git(own, 'rev-parse', 'HEAD'), result(false, 'full'))
  expect((await decide(own)).reason).toBe('local_check_failed')
})

it('merges: a docs-only merge carries, a merge that brings code does not', async () => {
  const root = repo()
  accept1(root)
  git(root, 'checkout', '-qb', 'side')
  commitFile(root, 'docs/side.md', 'side')
  git(root, 'checkout', '-q', 'main')
  commitFile(root, 'ROADMAP.md', 'main')
  git(root, 'merge', '-q', '--no-ff', '-m', 'merge docs', 'side')
  expect((await decide(root)).reason).toBe('checked_main')
  git(root, 'checkout', '-qb', 'code')
  commitFile(root, 'src/new.ts', 'export {}')
  git(root, 'checkout', '-q', 'main')
  commitFile(root, 'ROADMAP.md', 'main 2')
  git(root, 'merge', '-q', '--no-ff', '-m', 'merge code', 'code')
  expect((await decide(root)).reason).toBe('unchecked_commit')
})

const deliverOk = () =>
  vi.fn(async () => ({ publication_complete: true, pushed: true, reason: 'source_published' }))

it('runs the missing acceptance for an unchecked main, then publishes it', async () => {
  const root = repo()
  const sha = git(root, 'rev-parse', 'HEAD')
  recordLocalCheck(root, sha, result(true, 'quick'))
  const deliver = deliverOk()
  const acceptance = vi.fn(async () => {
    recordLocalCheck(root, sha, result(true, 'acceptance'))
    return { passed: true, log: '/logs/example.log' }
  })
  const rows: StatusRow[] = []
  const post = async (row: StatusRow) => {
    rows.push(row)
  }
  const dry = await publishRepos([project(root)], { dryRun: true, acceptance })
  expect(dry[0].reason).toBe('unchecked_commit')
  expect(acceptance).not.toHaveBeenCalled()
  const [published] = await publishRepos([project(root)], { deliver, acceptance, post })
  expect(acceptance).toHaveBeenCalledWith(root, sha, 'example')
  expect(deliver).toHaveBeenCalledWith(root, sha, [])
  expect(published).toMatchObject({ state: 'ok', pushed: true })
  expect(rows.at(-1)?.state).toBe('ok')
  // Already accepted: no second run.
  await publishRepos([project(root)], { deliver, acceptance })
  expect(acceptance).toHaveBeenCalledTimes(1)
})

it('a failed acceptance is a failed row naming the stage and the log; nothing is published', async () => {
  const root = repo()
  const sha = git(root, 'rev-parse', 'HEAD')
  const deliver = deliverOk()
  const acceptance = async () => {
    recordLocalCheck(root, sha, result(false, 'acceptance'))
    return { passed: false, log: '/logs/example.log' }
  }
  const rows: StatusRow[] = []
  const [failed] = await publishRepos([project(root)], {
    deliver,
    acceptance,
    post: async (row) => {
      rows.push(row)
    },
  })
  expect(failed).toMatchObject({ state: 'failed', reason: 'acceptance_failed', failed: ['types'] })
  expect(rows.at(-1)).toMatchObject({ state: 'failed' })
  expect(rows.at(-1)?.meaning).toContain('types')
  expect(rows.at(-1)?.meaning).toContain('/logs/example.log')
  expect(deliver).not.toHaveBeenCalled()
})

it('an unprepared environment shows as that, and a run that records nothing is incomplete', async () => {
  const root = repo()
  const rows: StatusRow[] = []
  const post = async (row: StatusRow) => {
    rows.push(row)
  }
  const [unprepared] = await publishRepos([project(root)], {
    post,
    acceptance: async () => ({
      passed: false,
      log: '/logs/example.log',
      notPrepared: 'environment not prepared: .venv missing in /x',
    }),
  })
  expect(unprepared.reason).toBe('environment_not_prepared')
  expect(rows.at(-1)?.meaning).toContain('environment not prepared: .venv missing')
  const [incomplete] = await publishRepos([project(root)], {
    post,
    acceptance: async () => ({ passed: false, log: '/logs/example.log' }),
  })
  expect(incomplete.reason).toBe('acceptance_incomplete')
  expect(rows.at(-1)?.meaning).toContain('/logs/example.log')
})

it('starts no more acceptances than the cap, and defers the rest to the next pass', async () => {
  const roots = [repo(), repo(), repo()]
  const acceptance = vi.fn(async (root: string, sha: string) => {
    recordLocalCheck(root, sha, result(true, 'acceptance'))
    return { passed: true, log: '/logs/x.log' }
  })
  const rows = await publishRepos(
    roots.map((root, i) => project(root, `p${i}`)),
    { deliver: deliverOk(), acceptance, acceptanceCap: 2 },
  )
  expect(acceptance).toHaveBeenCalledTimes(2)
  expect(rows.map((r) => r.state)).toEqual(['ok', 'ok', 'skip'])
  expect(rows[2].reason).toBe('acceptance_deferred')
})

it('never runs acceptance for manual-mode, held, excluded or retired sources', async () => {
  const acceptance = vi.fn(async () => ({ passed: true, log: '/logs/x.log' }))
  const manual = {
    ...project(repo(), 'manual'),
    agent_configs: { publication_mode: 'manual' },
  }
  const held = {
    ...project(repo(), 'held'),
    agent_configs: { publication_hold: { through: null, reason: 'x', set_at: 'now' } },
  }
  const retired = { ...project(repo(), 'retired'), retired_at: 1 }
  const rows = await publishRepos([manual, held, retired, project(repo(), 'neri')], {
    acceptance,
  })
  expect(rows.map((r) => r.reason)).toEqual([
    'manual_mode',
    'owner_hold',
    'unchecked_commit',
    'excluded_project',
  ])
  expect(acceptance).not.toHaveBeenCalled()
})

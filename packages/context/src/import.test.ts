import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { runContextCli } from './cli'
import { openContext } from './db'
import {
  type AgentHubSource,
  importAgentHub,
  POLICY_FILE,
  storedProjectText,
  WORK_ROLES_FILE,
} from './import'
import { loadPolicy } from './launch'
import { getMemories, searchMemories } from './memory'
import { getPrompt, rolePrompts } from './prompts'

const NOW = '2026-11-03T12:00:00.000Z'
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

const memory = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  group_id: 'global',
  scope: 'global',
  scope_id: null,
  summary: `summary ${id}`,
  content: `content of ${id}`,
  tags: ['a'],
  tier: 3,
  pinned: false,
  render_mode: null,
  trigger_task_types: null,
  applicability: { audience_tags: [], work_roles: ['coordinator'] },
  loaded_count: 4,
  helpful_count: 1,
  harmful_count: 0,
  version: 2,
  created_at: '2026-10-01T10:00:00.123456+00:00',
  updated_at: '2026-10-02T10:00:00.654321+00:00',
  ...fields,
})

const prompt = (id: number, slug: string, content: string) => ({
  id,
  slug,
  name: slug.toUpperCase(),
  description: null,
  content,
  prompt_type: 'standard',
  is_global: false,
  boot_eligible: false,
  context_policy: { surfaces: ['boot'] },
  updated_at: '2026-10-05T10:00:00+00:00',
})

/** Synthetic project rows, as row_to_json writes them. */
const PROJECT_LINES = [
  '{"id":1,"project_id":"alpha","root_path":"/srv/alpha","updated_at":"2026-10-01T10:00:00.123456+00:00","created_at":"2026-09-01T10:00:00+00:00","daily_cost_budget_usd":null,"monthly_cost_budget_usd":12.5,"budget_alert_threshold":0.8}',
  '{"id":2,"project_id":"beta","root_path":null,"updated_at":"2026-10-01T10:00:00+00:00","created_at":"2026-09-01T10:00:00+00:00","daily_cost_budget_usd":3,"monthly_cost_budget_usd":null,"budget_alert_threshold":null}',
]

const POLICY = {
  version: 5,
  launch: {
    about: 'test policy',
    usage_providers: ['opencode-go'],
    providers: { claude: { label: 'Claude', tools: ['claude-code'], name_tokens: ['claude'] } },
    deny: [{ jobs: ['recon'], provider: 'claude', reason: 'no', source: 'test' }],
    tools: { 'claude-code': { label: 'Claude Code', usage_provider: 'claude' } },
    jobs: {
      implementation: {
        label: 'Build',
        work_roles: ['implementation'],
        context: '1m',
        tools: { 'claude-code': { model: 'claude-sonnet-5-5', effort: 'high', why: 'default' } },
      },
      recon: { label: 'Recon', context: '200k', tools: {} },
    },
  },
}

class FakeHub implements AgentHubSource {
  memories = [
    memory('11111111-aaaa'),
    memory('22222222-bbbb', {
      group_id: 'project-aico',
      scope: 'project',
      scope_id: 'aico',
      tier: 1,
    }),
  ]
  archived: string[] = []
  prompts = [
    prompt(1, 'coder-system', 'You write code.\nCarefully.'),
    prompt(2, 'policy', 'Be brief.'),
  ]
  disabled: number[] = []
  projectLines = PROJECT_LINES
  projectHash = sha256(PROJECT_LINES.join('\n'))
  rows(sql: string): string[] {
    const lines = (values: unknown[]) => values.map((value) => JSON.stringify(value))
    if (sql.includes('encode(sha256')) return lines([this.projectHash])
    if (sql.includes('project_permissions')) return this.projectLines
    if (sql.includes('context_budgets'))
      return lines([
        {
          harness: 'claude_code',
          role: 'coder',
          warn_tokens: 150000,
          jump_pct: 20,
          note: null,
          updated_at: NOW,
        },
      ])
    if (sql.includes('FROM agents'))
      return lines([
        {
          slug: 'coder',
          name: 'Coder',
          description: 'Writes code',
          updated_at: NOW,
          prompt_ids: [1, 99],
        },
      ])
    if (sql.includes('NOT enabled')) return lines(this.disabled)
    if (sql.includes('FROM prompts')) return lines(this.prompts)
    if (sql.includes('memory_settings')) return lines([{ enabled: true, total_budget: 4000 }])
    if (sql.includes("status <> 'active'")) return lines(this.archived)
    if (sql.includes('FROM memories')) return lines(this.memories)
    throw new Error(`unexpected query: ${sql}`)
  }
  file(path: string): string {
    if (path === POLICY_FILE) return JSON.stringify(POLICY)
    if (path === WORK_ROLES_FILE)
      return JSON.stringify({ implementation: 'Builds', recon: 'Looks' })
    throw new Error(path)
  }
}

const options = { agentRoles: ['coder', 'explorer'], now: NOW }
const count = (db: ReturnType<typeof openContext>, table: string) =>
  (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n

describe('importAgentHub', () => {
  it('copies the rows and gives the same counts when run again', () => {
    const db = openContext(':memory:')
    const hub = new FakeHub()
    const first = importAgentHub(db, hub, options)
    const second = importAgentHub(db, hub, options)
    expect(second).toEqual(first)
    expect(first).toMatchObject({
      memories: 2,
      memorySettings: 1,
      prompts: 2,
      jobs: 2,
      namedRoles: 1,
      rolePrompts: 1,
      budgets: 1,
      projectRows: 2,
      missingRoles: ['explorer'],
    })
    for (const [table, n] of [
      ['memories', 2],
      ['memory_revisions', 2],
      ['prompts', 2],
      ['prompt_revisions', 2],
      ['roles', 3],
      ['role_prompts', 1],
      ['launch_deny', 1],
    ] as const)
      expect(count(db, table)).toBe(n)
    const [project] = getMemories(db, ['22222222']).found
    expect(project).toMatchObject({
      scope: 'project',
      scopeId: 'aico',
      tier: 'mandate',
      version: 2,
    })
    expect(project?.applicability).toEqual({ work_roles: ['coordinator'] })
    expect(searchMemories(db, 'summary')).toHaveLength(1)
    expect(rolePrompts(db, 'coder').map((item) => item.slug)).toEqual(['coder-system'])
    expect(loadPolicy(db)?.jobs.map((job) => job.name)).toEqual(['implementation', 'recon'])
    db.close()
  })

  it('takes new text as a new version and drops rows Agent Hub archived or disabled', () => {
    const db = openContext(':memory:')
    const hub = new FakeHub()
    importAgentHub(db, hub, options)
    hub.prompts = [prompt(1, 'coder-system', 'You write tested code.')]
    hub.disabled = [2]
    hub.memories = [memory('11111111-aaaa', { version: 3, content: 'new text' })]
    hub.archived = ['22222222-bbbb']
    const result = importAgentHub(db, hub, options)
    expect(result.removed).toEqual({ memories: 1, prompts: 1 })
    expect(getPrompt(db, 'coder-system')?.version).toBe(2)
    expect(count(db, 'prompt_revisions')).toBe(3)
    expect(getMemories(db, ['11111111']).found[0]?.content).toBe('new text')
    expect(count(db, 'memory_revisions')).toBe(3)
    db.close()
  })

  it('stores the project rows exactly: the hashes on both sides match', () => {
    const db = openContext(':memory:')
    const result = importAgentHub(db, new FakeHub(), options)
    expect(result.projectHash.match).toBe(true)
    expect(storedProjectText(db)).toBe(PROJECT_LINES.join('\n'))
    db.close()
  })

  it('reports a mismatch when the source hash differs', () => {
    const db = openContext(':memory:')
    const hub = new FakeHub()
    hub.projectHash = sha256('something else')
    const result = importAgentHub(db, hub, options)
    expect(result.projectHash.match).toBe(false)
    expect(result.projectHash.received).toBe(result.projectHash.stored)
    db.close()
  })
})

describe('aico context import-agent-hub', () => {
  function io(hub: AgentHubSource) {
    const out: string[] = []
    const err: string[] = []
    const posted: unknown[] = []
    return {
      out,
      err,
      posted,
      io: {
        out: (text: string) => out.push(text),
        err: (text: string) => err.push(text),
        dbPath: ':memory:',
        machine: 'davion-sidarli',
        statusUrl: 'http://127.0.0.1:3002/api/status/rows',
        fetch: (async (_url: string, init: RequestInit) => {
          posted.push(JSON.parse(String(init.body)))
          return new Response('{}', { status: 200 })
        }) as typeof fetch,
        now: () => new Date(NOW),
        agentHub: { checkout: '/nowhere', source: () => hub, route: () => null },
      },
    }
  }

  it('prints counts and hashes only, and reports the run as a Status row', async () => {
    const run = io(new FakeHub())
    expect(await runContextCli('context', ['import-agent-hub'], run.io)).toBe(0)
    const text = run.out.join('')
    expect(text).toContain('project_rows=2')
    expect(text).toContain('sha256 match')
    expect(text).not.toContain('alpha')
    expect(run.posted).toEqual([
      expect.objectContaining({
        id: 'davion-sidarli/context-import',
        kind: 'job',
        machine: 'davion-sidarli',
        state: 'ok',
        last_run: NOW,
        actions: [{ kind: 'run', ref: 'aico context import-agent-hub' }],
      }),
    ])
  })

  it('fails and reports it when the hashes differ', async () => {
    const hub = new FakeHub()
    hub.projectHash = 'x'
    const run = io(hub)
    expect(await runContextCli('context', ['import-agent-hub'], run.io)).toBe(1)
    expect(run.posted).toEqual([expect.objectContaining({ state: 'failed' })])
  })

  it('answers usage errors with the usage text', async () => {
    const run = io(new FakeHub())
    expect(await runContextCli('models', ['route'], run.io)).toBe(2)
    expect(run.err.join('')).toContain('needs --role')
  })
})

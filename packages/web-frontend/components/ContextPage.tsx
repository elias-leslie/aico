'use client'

import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { apiFetch } from '@/lib/api-fetch'
import type {
  ContextDelivery,
  ContextPrompt,
  ContextRole,
  ContextView,
} from '@/lib/context'
import { useSessionContext } from '@/lib/hooks/use-session-context'
import styles from './ContextPage.module.css'

const count = (n: number) => n.toLocaleString('en-US')
const group = (d: ContextDelivery) =>
  JSON.stringify([d.tool, d.role, d.project])
const who = (d: ContextDelivery) =>
  `${d.tool} · ${d.role ?? 'No role'} · ${d.project ?? 'No project'}`
const typeText = {
  prompt: 'Prompt',
  memory: 'Memory',
  skill: 'Skill',
  rule: 'Rule',
  file: 'File',
  computed: 'Generated',
} as const
const useText = {
  used: 'Use recorded',
  unused: 'No recorded use',
  unknown: 'Usage unknown',
}

function Costs({ view }: { view: ContextView }) {
  const [selected, setSelected] = useState('')
  const [project, setProject] = useState('')
  const [onlyUnused, setOnlyUnused] = useState(false)
  const latest = [
    ...new Map(
      [...view.deliveries].reverse().map((d) => [group(d), d]),
    ).values(),
  ].filter((d) => !project || d.project === project)
  const current = latest.find((d) => group(d) === selected) ?? latest[0]
  const projects = [
    ...new Set(view.deliveries.flatMap((d) => (d.project ? [d.project] : []))),
  ].sort()
  // The session's context now, else what the last check read.
  const liveContext = useSessionContext(current?.session ?? null, current?.tool)
  const contextInUse = liveContext ?? current?.contextTokens ?? null
  const counted = current?.items.filter((i) => !i.cut) ?? []
  // Nothing known about use yet: say so once, not on every row.
  const useUnknown =
    counted.length > 0 && counted.every((i) => i.use === 'unknown')
  const mostObserved = Math.max(0, ...counted.map((i) => i.observedSessions))
  return (
    <section aria-label="Context cost">
      <p className={styles.help}>
        Token counts for loaded context are estimates from text size. The
        conversation and provider billing add more. Context in use comes from
        the provider’s own count at the session’s latest reply.
      </p>
      {!view.deliveries.length ? (
        <p>
          No recent deliveries. Costs and usage are unknown until an agent
          receives context.
        </p>
      ) : (
        <>
          <div className={styles.filters}>
            <label>
              Project
              <select
                value={project}
                onChange={(e) => setProject(e.target.value)}
              >
                <option value="">All projects</option>
                {projects.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </label>
            <label className={styles.grow}>
              Agent / role
              <select
                value={current ? group(current) : ''}
                onChange={(e) => setSelected(e.target.value)}
              >
                {latest.map((d) => (
                  <option key={group(d)} value={group(d)}>
                    {who(d)} · ~{count(d.tokens)} tokens
                  </option>
                ))}
              </select>
            </label>
          </div>
          {current && (
            <>
              <div className={styles.summary}>
                <strong>~{count(current.tokens)} tokens loaded</strong>
                <span>
                  {current.budget === null
                    ? 'No token budget set'
                    : `Loaded-context budget ${count(current.budget)} tokens${current.tokens > current.budget ? ' · Over budget' : ''}`}
                </span>
                <span>
                  {contextInUse === null ? (
                    <span title="No provider count has been read for this session yet.">
                      Context in use unknown
                    </span>
                  ) : (
                    `${count(contextInUse)} tokens in use at last reply`
                  )}
                </span>
                <time dateTime={current.at}>
                  {new Date(current.at).toLocaleString()}
                </time>
              </div>
              {current.missing.length > 0 && (
                <p role="status">
                  Partial delivery. {current.missing.length} item
                  {current.missing.length === 1 ? '' : 's'} did not load:{' '}
                  {current.missing.map((m) => m.reason).join('; ')}
                </p>
              )}
              <p className={styles.help}>
                Use in the last {view.recentDays} days, for this agent, role and
                project. “No recorded use” needs {view.minObservedSessions}{' '}
                fully observed sessions without a citation or load marker. It
                does not measure influence on the model.
              </p>
              {!current.observed && (
                <p className={styles.help}>
                  This session’s transcript could not be fully read (it is
                  missing, cut short or still running), so its use stays
                  unknown.
                </p>
              )}
              {useUnknown && (
                <p className={styles.help} role="status">
                  Use is not known yet: {mostObserved} of{' '}
                  {view.minObservedSessions} fully observed sessions so far.
                </p>
              )}
              <label className={styles.toggle}>
                <input
                  type="checkbox"
                  checked={onlyUnused}
                  onChange={(e) => setOnlyUnused(e.target.checked)}
                />
                Show items with no recorded use
              </label>
              <ul className={styles.items} aria-label="Loaded items">
                {current.items
                  .filter((i) => !onlyUnused || i.use === 'unused')
                  .map((i) => (
                    <li key={i.id}>
                      <div className={styles.itemName}>
                        <span>{i.title}</span>
                        <small>
                          {typeText[i.type as keyof typeof typeText] ?? i.type}
                        </small>
                      </div>
                      <span className={styles.size}>
                        ~{count(i.tokens)}
                        <small>tokens{i.cut ? ' · Cut' : ''}</small>
                      </span>
                      {(i.cut || !useUnknown) && (
                        <span
                          className={`${styles.badge} ${i.use === 'unused' ? styles.warning : ''}`}
                          title={
                            i.use === 'unknown' && !i.cut
                              ? `Seen in ${i.observedSessions} of ${view.minObservedSessions} fully observed sessions needed to say.`
                              : undefined
                          }
                        >
                          {i.cut ? 'Not loaded' : useText[i.use]}
                        </span>
                      )}
                    </li>
                  ))}
              </ul>
              {onlyUnused && !current.items.some((i) => i.use === 'unused') && (
                <p>No items qualify for this view.</p>
              )}
            </>
          )}
        </>
      )}
    </section>
  )
}

function PromptEditor({
  prompt,
  saved,
}: {
  prompt: ContextPrompt
  saved: () => void
}) {
  const [name, setName] = useState(prompt.name)
  const [content, setContent] = useState(prompt.content)
  const [policy, setPolicy] = useState(
    JSON.stringify(
      prompt.contextPolicy ?? { scope: '', activation: 'always' },
      null,
      2,
    ),
  )
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>(
    'idle',
  )
  const [error, setError] = useState('')
  return (
    <form
      className={styles.editor}
      onSubmit={async (e) => {
        e.preventDefault()
        setState('saving')
        try {
          const contextPolicy: unknown = JSON.parse(policy)
          await apiFetch(
            `/api/context/prompts/${encodeURIComponent(prompt.slug)}`,
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name,
                content,
                contextPolicy,
                version: prompt.version,
                updatedAt: prompt.updatedAt,
              }),
            },
          )
          setState('saved')
          saved()
        } catch (error) {
          setError(
            error instanceof Error
              ? error.message
              : 'Could not save. Your changes are still here.',
          )
          setState('failed')
        }
      }}
    >
      <p className={styles.help}>
        {prompt.slug} · Version {prompt.version}. Changes apply to the next
        delivery.
      </p>
      <label>
        Name
        <input
          required
          maxLength={200}
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setState('idle')
          }}
        />
      </label>
      <label>
        Prompt text
        <textarea
          required
          rows={14}
          value={content}
          onChange={(e) => {
            setContent(e.target.value)
            setState('idle')
          }}
        />
      </label>
      <details>
        <summary>Where this prompt loads</summary>
        <p className={styles.help}>
          Policy fields: scope (global, project or agent), targets (project or
          role names), activation (always, on_demand or triggered), and
          applicability. An empty scope loads only through role links.
        </p>
        <label>
          Context policy (JSON)
          <textarea
            rows={8}
            value={policy}
            onChange={(e) => {
              setPolicy(e.target.value)
              setState('idle')
            }}
          />
        </label>
      </details>
      {state === 'failed' && <p role="alert">{error}</p>}
      {state === 'saved' && (
        <p role="status">Saved. New sessions will use this text.</p>
      )}
      <button
        className="lantern-btn primary"
        type="submit"
        disabled={state === 'saving'}
      >
        {state === 'saving' ? 'Saving…' : 'Save prompt'}
      </button>
    </form>
  )
}

function RoleEditor({
  role,
  prompts,
  saved,
}: {
  role: ContextRole
  prompts: ContextPrompt[]
  saved: () => void
}) {
  const [label, setLabel] = useState(role.label)
  const [description, setDescription] = useState(role.description)
  const [context, setContext] = useState(role.context ?? 'default')
  const [links, setLinks] = useState(role.prompts)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  return (
    <form
      className={styles.editor}
      onSubmit={async (e) => {
        e.preventDefault()
        setSaving(true)
        setMessage('')
        try {
          await apiFetch(
            `/api/context/roles/${encodeURIComponent(role.name)}`,
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                label,
                description,
                context:
                  context === 'default' && role.context === null
                    ? null
                    : context,
                prompts: links,
                updatedAt: role.updatedAt,
              }),
            },
          )
          setMessage('Saved. Changes apply to new sessions.')
          setFailed(false)
          saved()
        } catch (error) {
          setMessage(
            error instanceof Error
              ? error.message
              : 'Could not save. Your changes are still here.',
          )
          setFailed(true)
        } finally {
          setSaving(false)
        }
      }}
    >
      <p className={styles.help}>
        {role.name}. Models and launch rules are managed through agents.
      </p>
      <label>
        Name
        <input
          value={label}
          required
          maxLength={200}
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>
      <label>
        Description
        <textarea
          rows={3}
          value={description}
          maxLength={4000}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <label>
        Loaded context
        <select value={context} onChange={(e) => setContext(e.target.value)}>
          <option value="default">Default context</option>
          <option value="blank-slate">Blank slate</option>
        </select>
      </label>
      <fieldset>
        <legend>Linked prompts</legend>
        <div className={styles.promptLinks}>
          {prompts.map((p) => (
            <label className={styles.toggle} key={p.id}>
              <input
                type="checkbox"
                checked={links.includes(p.id)}
                onChange={(e) =>
                  setLinks(
                    e.target.checked
                      ? [...links, p.id]
                      : links.filter((id) => id !== p.id),
                  )
                }
              />
              {p.name}
            </label>
          ))}
        </div>
      </fieldset>
      {message && <p role={failed ? 'alert' : 'status'}>{message}</p>}
      <button className="lantern-btn primary" type="submit" disabled={saving}>
        {saving ? 'Saving…' : 'Save role'}
      </button>
    </form>
  )
}

const TABS = ['prompts', 'roles', 'memory', 'cost'] as const
type Tab = (typeof TABS)[number]
const TAB_LABEL: Record<Tab, string> = {
  prompts: 'Prompts',
  roles: 'Roles',
  memory: 'Memory',
  cost: 'Cost',
}

/** Context: what agents start with (prompts, roles, memory) and what it costs. */
export function ContextPage({ memory }: { memory?: ReactNode }) {
  const query = useQuery({
    queryKey: ['context'],
    queryFn: () => apiFetch<ContextView>('/api/context'),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  })
  const [tab, setTab] = useState<Tab>('prompts')
  const [prompt, setPrompt] = useState('')
  const [role, setRole] = useState('')
  const view = query.data
  const currentPrompt =
    view?.prompts.find((p) => p.slug === prompt) ?? view?.prompts[0]
  const currentRole = view?.roles.find((r) => r.name === role) ?? view?.roles[0]
  return (
    <main className={styles.page}>
      <header>
        <h1>Context</h1>
        <button
          className="lantern-icon-btn"
          type="button"
          aria-label="Refresh context"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw size={18} />
        </button>
      </header>
      <nav aria-label="Context">
        {TABS.map((t) => (
          <button
            className={`lantern-btn ${tab === t ? 'primary' : 'ghost'}`}
            aria-pressed={tab === t}
            type="button"
            key={t}
            onClick={() => setTab(t)}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </nav>
      {tab === 'memory' && memory}
      {tab !== 'memory' && query.isPending && (
        <p role="status">Loading prompts, roles and cost…</p>
      )}
      {tab !== 'memory' && query.isError && (
        <p role="alert">
          {view
            ? 'Refresh failed. Showing the last loaded view.'
            : 'Could not load prompts, roles and cost.'}{' '}
          Use Refresh to try again.
        </p>
      )}
      {view && tab !== 'memory' && (
        <>
          <p className={styles.asof}>
            Read {new Date(view.at).toLocaleString()}
          </p>
          {tab === 'cost' && <Costs view={view} />}
          {tab === 'prompts' && (
            <section aria-label="Prompts">
              {!view.prompts.length ? (
                <p>No prompts yet.</p>
              ) : (
                <label>
                  Prompt
                  <select
                    value={currentPrompt?.slug ?? ''}
                    onChange={(e) => setPrompt(e.target.value)}
                  >
                    {view.prompts.map((p) => (
                      <option value={p.slug} key={p.slug}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {currentPrompt && (
                <PromptEditor
                  key={`${currentPrompt.slug}:${currentPrompt.updatedAt}`}
                  prompt={currentPrompt}
                  saved={() => void query.refetch()}
                />
              )}
            </section>
          )}
          {tab === 'roles' && (
            <section aria-label="Roles">
              {!view.roles.length ? (
                <p>No roles yet.</p>
              ) : (
                <label>
                  Role
                  <select
                    value={currentRole?.name ?? ''}
                    onChange={(e) => setRole(e.target.value)}
                  >
                    {view.roles.map((r) => (
                      <option value={r.name} key={r.name}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {currentRole && (
                <RoleEditor
                  key={`${currentRole.name}:${currentRole.updatedAt}`}
                  role={currentRole}
                  prompts={view.prompts}
                  saved={() => void query.refetch()}
                />
              )}
            </section>
          )}
        </>
      )}
    </main>
  )
}

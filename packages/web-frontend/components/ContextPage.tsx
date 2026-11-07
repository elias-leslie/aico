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
import { shortWhen } from '@/lib/short-when'
import {
  Find,
  Form,
  Group,
  Notice,
  Quiet,
  Row,
  SectionHead,
} from './settings/kit'
import kit from './settings/kit.module.css'

const count = (n: number) => n.toLocaleString('en-US')
const group = (d: ContextDelivery) =>
  JSON.stringify([d.tool, d.role, d.project])
const who = (d: ContextDelivery) =>
  `${d.tool} · ${d.role ?? 'No role'} · ${d.project ?? 'No project'}`
/** A start with no items and no bytes: nothing was recorded as loaded, which is not a size of zero. */
const nothingLoaded = (d: ContextDelivery) =>
  d.items.length === 0 && d.tokens === 0
const sizeText = (d: ContextDelivery) =>
  nothingLoaded(d) ? 'nothing loaded' : `~${count(d.tokens)} tokens`
const startText = (d: ContextDelivery) =>
  nothingLoaded(d)
    ? 'Nothing loaded at start'
    : `~${count(d.tokens)} tokens at start`
const typeText = {
  prompt: 'Prompt',
  memory: 'Memory',
  skill: 'Skill',
  rule: 'Rule',
  file: 'File',
  computed: 'Generated',
} as const
const USE_CHIP = { used: 'ok', unused: 'late', unknown: 'off' } as const
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
  const shown =
    current?.items.filter((i) => !onlyUnused || i.use === 'unused') ?? []
  return (
    <section aria-label="Context cost">
      <Quiet>
        What an agent starts with and how much room it takes. Sizes are
        estimates from the text; the conversation itself and your provider’s
        billing add more.
      </Quiet>
      {!view.deliveries.length ? (
        <Quiet>
          No agent has started recently, so there is nothing to size yet. Sizes
          and use show up once an agent starts with context.
        </Quiet>
      ) : (
        <>
          <Form onSubmit={(e) => e.preventDefault()}>
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
            <label>
              Agent and role
              <select
                value={current ? group(current) : ''}
                onChange={(e) => setSelected(e.target.value)}
              >
                {latest.map((d) => (
                  <option key={group(d)} value={group(d)}>
                    {who(d)} · {sizeText(d)}
                  </option>
                ))}
              </select>
            </label>
          </Form>
          {current && (
            <>
              <div className={kit.summary}>
                <strong>{startText(current)}</strong>
                <span>
                  {current.budget === null
                    ? 'No size limit set'
                    : `Size limit ${count(current.budget)} tokens${current.tokens > current.budget ? ` · Over by ${count(current.tokens - current.budget)}` : ''}`}
                </span>
                <span>
                  {contextInUse === null ? (
                    <span title="No count has been read from the provider for this session yet.">
                      Conversation size not read yet
                    </span>
                  ) : (
                    `${count(contextInUse)} tokens in the conversation at its last reply`
                  )}
                </span>
                <time dateTime={current.at}>
                  Started {shortWhen(current.at)}
                </time>
              </div>
              {nothingLoaded(current) && (
                <Quiet role="status">
                  Nothing was recorded as loaded at start, so there is no size
                  to show.
                </Quiet>
              )}
              {current.missing.length > 0 && (
                <Quiet role="status">
                  Part of it didn’t load: {current.missing.length} item
                  {current.missing.length === 1 ? ' is' : 's are'} missing (
                  {current.missing.map((m) => m.reason).join('; ')})
                </Quiet>
              )}
              <Quiet>
                Whether the agent used each item in the last {view.recentDays}{' '}
                days. “No recorded use” needs {view.minObservedSessions} full
                sessions where it never cited or opened the item. It doesn’t
                measure how much the item shaped the answer.
              </Quiet>
              {!current.observed && (
                <Quiet>
                  Couldn’t read this session’s full transcript (it is missing,
                  cut short or still running), so use stays unknown.
                </Quiet>
              )}
              {useUnknown && (
                <Quiet role="status">
                  Use isn’t known yet: {mostObserved} of{' '}
                  {view.minObservedSessions} full sessions read so far.
                </Quiet>
              )}
              <Form onSubmit={(e) => e.preventDefault()}>
                <label className={`${kit.check} ${kit.wide}`}>
                  <input
                    type="checkbox"
                    checked={onlyUnused}
                    onChange={(e) => setOnlyUnused(e.target.checked)}
                  />
                  Only items with no recorded use
                </label>
              </Form>
              {shown.length > 0 && (
                <Group
                  title="Loaded items"
                  label="Loaded items"
                  count={shown.length}
                >
                  {shown.map((i) => {
                    const chip = i.cut ? 'off' : USE_CHIP[i.use]
                    const showChip = i.cut || !useUnknown
                    return (
                      <Row
                        key={i.id}
                        name={i.title}
                        meta={`${typeText[i.type as keyof typeof typeText] ?? i.type} · ~${count(i.tokens)} tokens${i.cut ? ' · cut' : ''}`}
                        chip={showChip ? chip : undefined}
                        chipText={i.cut ? 'Not loaded' : useText[i.use]}
                        chipTitle={
                          i.use === 'unknown' && !i.cut
                            ? `Read in ${i.observedSessions} of the ${view.minObservedSessions} full sessions needed to say.`
                            : undefined
                        }
                      />
                    )
                  })}
                </Group>
              )}
              {onlyUnused && !current.items.some((i) => i.use === 'unused') && (
                <Quiet>No items qualify for this view.</Quiet>
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
    <Form
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
      <small>
        Version {prompt.version}. Changes apply to the next session that starts.
      </small>
      <label className={kit.wide}>
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
      <label className={kit.wide}>
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
        <summary>When this prompt loads</summary>
        <small>
          Rules: scope (global, project or agent), targets (project or role
          names), activation (always, on_demand or triggered) and applicability.
          With no scope it loads only through roles that link it.
        </small>
        <label className={kit.field}>
          Loading rules (JSON)
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
        <p role="status">Saved. New sessions will start with this text.</p>
      )}
      <button
        className="lantern-btn primary small"
        type="submit"
        disabled={state === 'saving'}
      >
        {state === 'saving' ? 'Saving…' : 'Save prompt'}
      </button>
    </Form>
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
    <Form
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
      <small>
        {role.name}. Which model runs it and when it launches aren’t set here.
      </small>
      <label className={kit.wide}>
        Name
        <input
          value={label}
          required
          maxLength={200}
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>
      <label className={kit.wide}>
        Description
        <textarea
          rows={3}
          value={description}
          maxLength={4000}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <label>
        Starts with
        <select value={context} onChange={(e) => setContext(e.target.value)}>
          <option value="default">The usual context</option>
          <option value="blank-slate">Blank slate</option>
        </select>
      </label>
      <fieldset>
        <legend>Linked prompts</legend>
        <div className={kit.scroll}>
          {prompts.map((p) => (
            <label className={kit.check} key={p.id}>
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
      <button
        className="lantern-btn primary small"
        type="submit"
        disabled={saving}
      >
        {saving ? 'Saving…' : 'Save role'}
      </button>
    </Form>
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
/** Past this many prompts or roles the list gets a find box. */
const FIND_FROM = 8

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
  const [find, setFind] = useState('')
  const view = query.data
  const matches = (name: string) =>
    name.toLowerCase().includes(find.trim().toLowerCase())
  const prompts = view?.prompts.filter((p) => matches(p.name)) ?? []
  const roles = view?.roles.filter((r) => matches(r.label)) ?? []
  const loading = tab !== 'memory' && query.isPending
  return (
    <section aria-label="Context">
      <SectionHead
        title="Context"
        sub={
          loading
            ? 'Loading prompts, roles and cost…'
            : 'What agents start with, and what it costs.'
        }
      >
        <button
          className="lantern-icon-btn compact"
          type="button"
          aria-label="Refresh context"
          title="Refresh context"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw size={16} />
        </button>
      </SectionHead>
      <nav className={kit.tabs} aria-label="Context">
        {TABS.map((t) => (
          <button
            className={`lantern-btn small ${tab === t ? 'primary' : 'ghost'}`}
            aria-pressed={tab === t}
            type="button"
            key={t}
            onClick={() => {
              setTab(t)
              setFind('')
            }}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </nav>
      {tab === 'memory' && memory}
      {tab !== 'memory' && query.isError && (
        <Notice failed>
          {view
            ? 'Can’t refresh. Showing the last read.'
            : 'Can’t load prompts, roles and cost.'}{' '}
          Use Refresh to try again.
        </Notice>
      )}
      {view && tab !== 'memory' && (
        <>
          <Quiet>Read {shortWhen(view.at)}</Quiet>
          {tab === 'cost' && <Costs view={view} />}
          {tab === 'prompts' && (
            <section aria-label="Prompts">
              {!view.prompts.length ? (
                <Quiet>No prompts yet.</Quiet>
              ) : (
                <>
                  {view.prompts.length > FIND_FROM && (
                    <Find
                      value={find}
                      onChange={setFind}
                      label="Find a prompt"
                      placeholder="Prompt name"
                    />
                  )}
                  {prompts.length === 0 ? (
                    <Quiet>No prompts match your search.</Quiet>
                  ) : (
                    <Group title="Prompts" count={prompts.length}>
                      {prompts.map((p) => (
                        <Row
                          key={`${p.slug}:${p.updatedAt}`}
                          name={p.name}
                          meta={`Version ${p.version}`}
                        >
                          <PromptEditor
                            prompt={p}
                            saved={() => void query.refetch()}
                          />
                        </Row>
                      ))}
                    </Group>
                  )}
                </>
              )}
            </section>
          )}
          {tab === 'roles' && (
            <section aria-label="Roles">
              {!view.roles.length ? (
                <Quiet>No roles yet.</Quiet>
              ) : (
                <>
                  {view.roles.length > FIND_FROM && (
                    <Find
                      value={find}
                      onChange={setFind}
                      label="Find a role"
                      placeholder="Role name"
                    />
                  )}
                  {roles.length === 0 ? (
                    <Quiet>No roles match your search.</Quiet>
                  ) : (
                    <Group title="Roles" count={roles.length}>
                      {roles.map((r) => (
                        <Row
                          key={`${r.name}:${r.updatedAt}`}
                          name={r.label}
                          meta={r.name}
                        >
                          <RoleEditor
                            role={r}
                            prompts={view.prompts}
                            saved={() => void query.refetch()}
                          />
                        </Row>
                      ))}
                    </Group>
                  )}
                </>
              )}
            </section>
          )}
        </>
      )}
    </section>
  )
}

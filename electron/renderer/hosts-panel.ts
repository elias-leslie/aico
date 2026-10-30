// The Hosts panel (lantern menu and palette → Hosts): each remote host's state,
// its running sessions and power, and per agent tool whether it is signed in
// there. Sign in opens a short session on that host running the tool's own
// login; the panel checks again when that session ends.

import type { HostLogins, HostResult, HostRow } from '../types'
import './hosts-panel.css'

export const HOSTS_OPEN_EVENT = 'aico:hosts-open'

type Tone = 'good' | 'wait' | 'quiet' | 'warn'
type Tool = HostLogins['tools'][number]

const STEPS: Record<string, string> = {
  powering_on: 'powering on',
  connecting: 'connecting',
  checking_services: 'checking services',
}

/** The host's state first, in a few words, with how it reads. */
export function hostSummary(row: HostRow): { label: string; tone: Tone; detail: string | null } {
  if (row.wake?.state === 'starting')
    return { label: `Starting… ${STEPS[row.wake.step] ?? ''}`.trim(), tone: 'wait', detail: null }
  const failed =
    row.wake?.state === 'failed' ? `Didn’t start: ${row.wake.error ?? 'no reason given'}` : null
  switch (row.state) {
    case 'connected':
      return { label: 'Connected', tone: 'good', detail: null }
    case 'connecting':
      return { label: 'Connecting', tone: 'wait', detail: failed ?? row.error }
    case 'powered_off':
      return { label: 'Powered off', tone: 'quiet', detail: failed }
    case 'identity_changed':
      return {
        label: 'Not the same machine',
        tone: 'warn',
        detail: row.error ?? 'Another machine now answers for this host.',
      }
    default:
      return { label: 'Offline', tone: 'quiet', detail: failed ?? row.error }
  }
}

export function sessionsLine(row: HostRow): string {
  const n = row.sessions
  const count = n === 0 ? 'No sessions' : `${n} session${n === 1 ? '' : 's'}`
  return row.state === 'connected' ? count : `${count} (last seen)`
}

const TOOL_STATES: Record<string, { label: string; tone: Tone }> = {
  signed_in: { label: 'Signed in', tone: 'good' },
  needs_sign_in: { label: 'Needs sign-in', tone: 'warn' },
  expired: { label: 'Expired', tone: 'warn' },
}

/** One tool's state; anything unrecognised reads Unknown, never signed out. */
export function toolSummary(tool: Tool): { label: string; tone: Tone } {
  return TOOL_STATES[tool.state] ?? { label: 'Unknown', tone: 'quiet' }
}

/** Where a tool's login lives: served by Agent Hub, or on the host's disk. */
export function sourceLabel(source: string): string {
  if (source === 'agent-hub') return 'Agent Hub'
  if (source.startsWith('host:')) return 'This host'
  return source
}

/** The tooltip: every credential behind the tool's state, with its detail. */
export function toolDetail(tool: Tool): string {
  return tool.credentials
    .map((c) => {
      const where = c.source.startsWith('host:') ? c.source.slice(5) : sourceLabel(c.source)
      const state = toolSummary({ ...tool, state: c.state }).label
      return `${c.name}: ${state} · ${where}${c.detail ? ` (${c.detail})` : ''}`
    })
    .join('\n')
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button(label: string, onClick: () => void, kind: 'plain' | 'danger' = 'plain') {
  const b = el('button', `aico-hosts-btn${kind === 'danger' ? ' danger' : ''}`, label)
  b.type = 'button'
  b.addEventListener('click', onClick)
  return b
}

function chip(label: string, tone: Tone): HTMLElement {
  const c = el('span', `aico-hosts-chip ${tone}`, label)
  return c
}

type LoginsState =
  | { kind: 'loading' }
  | { kind: 'ready'; value: HostLogins }
  | { kind: 'failed'; message: string }

/** An inline question under a host: the panel never acts on a risky click alone. */
interface Ask {
  host: string
  text: string
  confirm: string
  run: () => Promise<void>
}

function wire(): void {
  const shell = document.querySelector<HTMLElement>('.shell')
  if (!shell) return
  const root = el('div', 'aico-hosts')
  root.hidden = true
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'true')
  root.setAttribute('aria-label', 'Hosts')
  const box = el('div', 'aico-hosts-box')
  const head = el('div', 'aico-hosts-head')
  head.append(el('h2', 'aico-hosts-title', 'Hosts'))
  const close = button('×', () => hide())
  close.setAttribute('aria-label', 'Close hosts')
  close.classList.add('close')
  head.append(close)
  const body = el('div', 'aico-hosts-body')
  const status = el('p', 'aico-hosts-status')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  box.append(head, body, status)
  root.append(box)
  shell.append(root)

  let hosts: HostResult<HostRow[]> | null = null
  const logins = new Map<string, LoginsState>()
  const busy = new Set<string>()
  let ask: Ask | null = null
  let names = new Map<string, string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastFocus: Element | null = null

  const say = (text: string) => {
    status.textContent = text
  }

  async function loadNames(): Promise<void> {
    try {
      const tuis = await window.aico.actions.listTuis()
      names = new Map(tuis.map((t) => [t.slug, t.displayName]))
    } catch {
      // Slugs stand in for names.
    }
  }

  async function loadLogins(host: string): Promise<void> {
    logins.set(host, { kind: 'loading' })
    render()
    const answer = await window.aico.hosts.logins(host)
    logins.set(
      host,
      answer.ok
        ? { kind: 'ready', value: answer.value }
        : { kind: 'failed', message: answer.message },
    )
    render()
  }

  async function loadHosts(): Promise<void> {
    const before = new Map(hosts?.ok ? hosts.value.map((h) => [h.name, h.state] as const) : [])
    hosts = await window.aico.hosts.list()
    render()
    if (hosts.ok)
      for (const row of hosts.value) {
        // A host that just came up gets its sign-in read.
        if (
          row.state === 'connected' &&
          (before.get(row.name) !== 'connected' || !logins.has(row.name))
        )
          void loadLogins(row.name)
        if (row.state !== 'connected') logins.delete(row.name)
      }
    schedule()
  }

  function schedule(): void {
    if (timer) clearTimeout(timer)
    if (root.hidden) return
    const starting = hosts?.ok && hosts.value.some((h) => h.wake?.state === 'starting')
    timer = setTimeout(() => void loadHosts(), starting ? 2_000 : 10_000)
  }

  async function act(host: string, work: () => Promise<HostResult<unknown>>, done: string) {
    busy.add(host)
    render()
    const answer = await work()
    busy.delete(host)
    say(answer.ok ? done : answer.message)
    await loadHosts()
    return answer
  }

  function powerOff(row: HostRow, force: boolean): void {
    void act(
      row.name,
      () => window.aico.hosts.power(row.name, 'off', force),
      `Powering off ${row.name}`,
    ).then((answer) => {
      // Sessions started meanwhile: Tether refused; ask again with its count.
      if (!answer.ok && answer.status === 409 && !force) {
        ask = {
          host: row.name,
          text: `${answer.message}. Power off anyway? They stop.`,
          confirm: 'Power off anyway',
          run: async () => powerOff(row, true),
        }
        render()
      }
    })
  }

  function signInOut(host: string, tool: Tool, action: 'sign_in' | 'sign_out'): void {
    const name = names.get(tool.tool) ?? tool.tool
    busy.add(host)
    render()
    void window.aico.hosts.sign(host, tool.tool, action).then((answer) => {
      busy.delete(host)
      if (!answer.ok) say(answer.message)
      else if (answer.value.opened)
        say(
          action === 'sign_in'
            ? `Sign in to ${name} in the new session; this list updates when it ends`
            : `Sign out of ${name} in the new session`,
        )
      else say(answer.value.note ?? `Signed out of ${name} on ${host}`)
      if (answer.ok && !answer.value.opened) void loadLogins(host)
      else render()
    })
  }

  function toolRow(row: HostRow, tool: Tool, state: HostLogins): HTMLElement {
    const line = el('div', 'aico-hosts-tool')
    const name = names.get(tool.tool) ?? tool.tool
    const label = el('span', 'aico-hosts-tool-name', name)
    const summary = toolSummary(tool)
    const where = el('span', 'aico-hosts-source', sourceLabel(tool.source))
    const info = el('span', 'aico-hosts-tool-state')
    info.append(chip(summary.label, summary.tone), where)
    info.title = toolDetail(tool)
    line.append(label, info)
    const actions = state.actions[tool.tool]
    const controls = el('span', 'aico-hosts-tool-actions')
    const disabled = busy.has(row.name)
    if (actions?.signIn && tool.state !== 'signed_in') {
      const b = button('Sign in', () => signInOut(row.name, tool, 'sign_in'))
      b.disabled = disabled
      b.setAttribute('aria-label', `Sign in to ${name} on ${row.name}`)
      controls.append(b)
    }
    if (actions?.signOut && (tool.state === 'signed_in' || tool.state === 'expired')) {
      const b = button('Sign out', () => {
        ask = {
          host: row.name,
          text: `Sign out of ${name} on ${row.name}? Agents there can’t use it until you sign in again.`,
          confirm: 'Sign out',
          run: async () => signInOut(row.name, tool, 'sign_out'),
        }
        render()
      })
      b.disabled = disabled
      b.setAttribute('aria-label', `Sign out of ${name} on ${row.name}`)
      controls.append(b)
    }
    line.append(controls)
    return line
  }

  function loginsBlock(row: HostRow): HTMLElement {
    const block = el('div', 'aico-hosts-logins')
    if (row.state !== 'connected') {
      block.append(el('p', 'aico-hosts-note', `Sign-in shows once ${row.name} is connected.`))
      return block
    }
    const state = logins.get(row.name) ?? { kind: 'loading' }
    if (state.kind === 'loading') {
      block.append(el('p', 'aico-hosts-note', 'Checking sign-in…'))
      return block
    }
    if (state.kind === 'failed') {
      const p = el('p', 'aico-hosts-note', `Couldn’t check sign-in: ${state.message}`)
      block.append(
        p,
        button('Check again', () => void loadLogins(row.name)),
      )
      return block
    }
    if (state.value.agent_hub !== 'reachable')
      block.append(
        el(
          'p',
          'aico-hosts-note',
          `Agent Hub can’t be reached from ${row.name}, so its tools show Unknown.`,
        ),
      )
    if (state.value.tools.length === 0)
      block.append(el('p', 'aico-hosts-note', `No agent tools are set up for ${row.name}.`))
    for (const tool of state.value.tools) block.append(toolRow(row, tool, state.value))
    return block
  }

  function hostCard(row: HostRow): HTMLElement {
    const card = el('section', 'aico-hosts-card')
    card.setAttribute('aria-label', row.name)
    const top = el('div', 'aico-hosts-row')
    const summary = hostSummary(row)
    const title = el('span', 'aico-hosts-name', row.name)
    top.append(title, chip(summary.label, summary.tone))
    const controls = el('span', 'aico-hosts-actions')
    const disabled = busy.has(row.name) || row.wake?.state === 'starting'
    if (row.state === 'identity_changed') {
      const b = button('Trust', () => {
        ask = {
          host: row.name,
          text: `Trust the machine now answering as ${row.name}? Only if you replaced or rebuilt it.`,
          confirm: 'Trust',
          run: async () => {
            await act(row.name, () => window.aico.hosts.trust(row.name), `Trusted ${row.name}`)
          },
        }
        render()
      })
      b.disabled = disabled
      controls.append(b)
    } else if (row.state === 'connected') {
      const b = button('Power off', () => {
        if (row.sessions > 0) {
          ask = {
            host: row.name,
            text: `${sessionsLine(row)} on ${row.name}. Power off anyway? They stop.`,
            confirm: 'Power off',
            run: async () => powerOff(row, true),
          }
          render()
        } else powerOff(row, false)
      })
      b.disabled = disabled
      b.setAttribute('aria-label', `Power off ${row.name}`)
      controls.append(b)
    } else {
      const b = button('Power on', () => {
        void act(row.name, () => window.aico.hosts.power(row.name, 'on'), `Starting ${row.name}`)
      })
      b.disabled = disabled
      b.setAttribute('aria-label', `Power on ${row.name}`)
      controls.append(b)
    }
    top.append(controls)
    card.append(top)
    card.append(el('p', 'aico-hosts-meta', sessionsLine(row)))
    if (summary.detail) card.append(el('p', 'aico-hosts-detail', summary.detail))
    if (ask?.host === row.name) {
      const current = ask
      const strip = el('div', 'aico-hosts-ask')
      strip.setAttribute('role', 'alertdialog')
      strip.append(el('p', 'aico-hosts-ask-text', current.text))
      const yes = button(
        current.confirm,
        () => {
          ask = null
          render()
          void current.run()
        },
        current.confirm === 'Trust' ? 'plain' : 'danger',
      )
      const no = button('Cancel', () => {
        ask = null
        render()
      })
      strip.append(yes, no)
      card.append(strip)
      queueMicrotask(() => no.focus())
    }
    card.append(loginsBlock(row))
    return card
  }

  function render(): void {
    if (root.hidden) return
    const focused = document.activeElement?.getAttribute('aria-label')
    body.replaceChildren()
    if (!hosts) body.append(el('p', 'aico-hosts-note', 'Loading hosts…'))
    else if (!hosts.ok) {
      body.append(
        el('p', 'aico-hosts-note', `Couldn’t load hosts: ${hosts.message}`),
        button('Try again', () => void loadHosts()),
      )
    } else if (hosts.value.length === 0)
      body.append(
        el('p', 'aico-hosts-note', 'No other hosts are set up. Sessions run on this computer.'),
      )
    else for (const row of hosts.value) body.append(hostCard(row))
    // Keep focus on the same control across a re-render.
    if (focused && !ask)
      body.querySelector<HTMLElement>(`[aria-label="${CSS.escape(focused)}"]`)?.focus()
  }

  function show(): void {
    lastFocus = document.activeElement
    root.hidden = false
    say('')
    render()
    close.focus()
    void loadNames().then(render)
    logins.clear()
    void loadHosts()
  }

  function hide(): void {
    root.hidden = true
    ask = null
    if (timer) clearTimeout(timer)
    timer = null
    if (lastFocus instanceof HTMLElement) lastFocus.focus()
  }

  window.addEventListener(HOSTS_OPEN_EVENT, show)
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (ask) {
        ask = null
        render()
      } else hide()
    }
  })
  root.addEventListener('mousedown', (event) => {
    if (event.target === root) hide()
  })
  window.aico.hosts.onChanged((host) => {
    if (!root.hidden) void loadLogins(host)
  })
}

if (typeof document !== 'undefined' && typeof window !== 'undefined' && window.aico?.hosts) wire()

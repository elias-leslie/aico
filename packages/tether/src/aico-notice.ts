// The Aico notice (contract v1) a session waiting on the owner and a model
// switch both send. A leaf, so the model notices do not import the waiting
// service (src/waiting.ts re-exports both names).

export interface WaitingNotice {
  v: 1
  source: 'aico'
  kind: 'todo'
  severity: 'warning'
  title: string
  body: string
  key: string
  open?: string
  actions: ['open']
  primary: 'open'
  push: 'phone' | 'tray'
  interrupt?: 'needs-you'
}

/** A session waiting on the owner, as an Aico notice (contract v1). */
export function waitingNotice(parts: {
  key: string
  title: string
  body: string
  open?: string
  /** Where it reaches the owner: the phone (default) or the desktop tray. */
  push?: 'phone' | 'tray'
}): WaitingNotice {
  return {
    v: 1,
    source: 'aico',
    kind: 'todo',
    severity: 'warning',
    title: parts.title.slice(0, 200),
    body: parts.body.slice(0, 1000),
    key: parts.key.replace(/[^A-Za-z0-9_.:/@+=,-]/g, '-').slice(0, 200),
    ...(parts.open?.startsWith('https://') ? { open: parts.open } : {}),
    actions: ['open'],
    primary: 'open',
    push: parts.push ?? 'phone',
    ...((parts.push ?? 'phone') === 'phone' ? { interrupt: 'needs-you' as const } : {}),
  }
}

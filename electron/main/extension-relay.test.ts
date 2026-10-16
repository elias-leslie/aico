import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

// The browser extension's background worker is a plain MV3 script, not part of
// the Electron build. Run it in a VM with a stubbed `chrome` and `fetch` to pin
// what it reports back after a send: callers toast from this, so it must say
// what actually happened.

const source = readFileSync(resolve(import.meta.dirname, '../../extension/background.js'), 'utf8')

type SendResult = { ok: boolean; status: number; timedOut?: boolean }
type Listener = (...args: unknown[]) => unknown

function loadWorker(fetchImpl: () => Promise<{ ok: boolean; status: number }>) {
  const listeners: Record<string, Listener> = {}
  const tabMessages: Array<{ tabId: number; msg: unknown; options: unknown }> = []
  const fetchCalls: Array<{ url: string; init: { body: string; signal?: unknown } }> = []
  const event = (name: string) => ({
    addListener: (fn: Listener) => {
      listeners[name] = fn
    },
  })
  const chrome = {
    runtime: { id: 'self', onInstalled: event('installed'), onMessage: event('message') },
    contextMenus: { onClicked: event('clicked'), removeAll: () => {}, create: () => {} },
    tabs: {
      sendMessage: (tabId: number, msg: unknown, options: unknown) => {
        tabMessages.push({ tabId, msg, options })
        return Promise.resolve()
      },
    },
  }
  const fetch = (url: string, init: { body: string; signal?: unknown }) => {
    fetchCalls.push({ url, init })
    return fetchImpl()
  }
  runInNewContext(source, { chrome, fetch, AbortSignal })
  return { listeners, tabMessages, fetchCalls }
}

function relay(worker: ReturnType<typeof loadWorker>): Promise<SendResult> {
  return new Promise((done) => {
    const sender = { id: 'self', tab: { id: 7 } }
    const msg = { type: 'aico:send', items: [{ kind: 'dom', snippet: 'hi', meta: {} }] }
    const keepOpen = worker.listeners.message(msg, sender, done)
    expect(keepOpen).toBe(true)
  })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('extension relay reports the real send outcome', () => {
  it('answers ok with the status when the sidecar accepts the batch', async () => {
    const worker = loadWorker(async () => ({ ok: true, status: 200 }))
    await expect(relay(worker)).resolves.toEqual({ ok: true, status: 200 })
    expect(worker.fetchCalls[0].url).toBe('http://127.0.0.1:8005/selection/send')
    expect(worker.fetchCalls[0].init.signal).toBeDefined()
  })

  it('answers not ok with the HTTP status when the sidecar refuses', async () => {
    const worker = loadWorker(async () => ({ ok: false, status: 403 }))
    await expect(relay(worker)).resolves.toEqual({ ok: false, status: 403 })
  })

  it('answers status 0 when nothing is listening', async () => {
    const worker = loadWorker(() => Promise.reject(new TypeError('Failed to fetch')))
    await expect(relay(worker)).resolves.toEqual({ ok: false, status: 0 })
  })

  it('flags a timeout apart from a refused connection, since Aico may have stored it', async () => {
    const timeout = new DOMException('signal timed out', 'TimeoutError')
    const worker = loadWorker(() => Promise.reject(timeout))
    await expect(relay(worker)).resolves.toEqual({ ok: false, status: 0, timedOut: true })
  })

  it('ignores relays from outside this extension', () => {
    const worker = loadWorker(async () => ({ ok: true, status: 200 }))
    const msg = { type: 'aico:send', items: [{ kind: 'dom', snippet: 'hi', meta: {} }] }
    expect(worker.listeners.message(msg, { id: 'other', tab: { id: 7 } }, () => {})).toBe(false)
    expect(worker.fetchCalls).toHaveLength(0)
  })
})

describe('context-menu sends give in-page feedback', () => {
  const click = { menuItemId: 'aico-send-selection', selectionText: 'quote', pageUrl: 'https://x' }
  const tab = { id: 9, title: 'X', url: 'https://x' }

  it('tells the page the send failed when the sidecar is down', async () => {
    const worker = loadWorker(() => Promise.reject(new TypeError('Failed to fetch')))
    worker.listeners.clicked(click, tab)
    await settle()
    expect(worker.tabMessages).toEqual([
      {
        tabId: 9,
        msg: { type: 'aico:sent', ok: false, status: 0, label: 'text' },
        options: { frameId: 0 },
      },
    ])
  })

  it('passes a timeout on to the page', async () => {
    const worker = loadWorker(() => Promise.reject(new DOMException('slow', 'TimeoutError')))
    worker.listeners.clicked(click, tab)
    await settle()
    expect(worker.tabMessages[0].msg).toEqual({
      type: 'aico:sent',
      ok: false,
      status: 0,
      timedOut: true,
      label: 'text',
    })
  })

  it('tells the page the send worked, naming what was sent', async () => {
    const worker = loadWorker(async () => ({ ok: true, status: 200 }))
    worker.listeners.clicked({ menuItemId: 'aico-send-link', linkUrl: 'https://y' }, tab)
    await settle()
    expect(worker.tabMessages[0].msg).toEqual({
      type: 'aico:sent',
      ok: true,
      status: 200,
      label: 'link',
    })
  })

  it('sends nothing for a click with nothing to send', async () => {
    const worker = loadWorker(async () => ({ ok: true, status: 200 }))
    worker.listeners.clicked({ menuItemId: 'aico-send-selection' }, tab)
    await settle()
    expect(worker.fetchCalls).toHaveLength(0)
    expect(worker.tabMessages).toHaveLength(0)
  })
})

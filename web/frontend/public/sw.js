// Aico's service worker: makes the phone app installable and keeps a read-only copy of the notes.
//
// - The app's own files (/_next/static, icons) are immutable: cache first.
// - Pages (/, /notes, /captures) and GET /api/notes*, /api/captures* and thumbs: network first, with the
//   last good answer kept. The worker answers from that copy when the fetch throws, the status is 5xx, or
//   the answer lacks the X-Aico-Host header aico-web puts on every response (when both tunnel connectors
//   are down Cloudflare answers with its own error page instead of failing the fetch).
// - While answering from the copy it tells the open pages (postMessage) so they can show the banner and
//   turn the write controls off. There is no offline queue: writes (anything but GET), uploads, SSE, range
//   requests and photo files are never touched here; they go straight to the network as before.
// - A redirect (Cloudflare Access sending the owner to its login) is passed to the browser untouched.
//
// Bump VERSION to drop everything kept.

const VERSION = 'v1'
const SHELL = `aico-shell-${VERSION}`
const DATA = `aico-data-${VERSION}`
const THUMBS = `aico-thumbs-${VERSION}`
const META = `aico-meta-${VERSION}`
const CURRENT = [SHELL, DATA, THUMBS, META]

const HOST_HEADER = 'x-aico-host'
const PAGES = ['/', '/notes', '/captures']
const THUMB_LIMIT = 200
/** After a fresh notes list, fetch this many notes' details (and their thumbs) so they open offline. */
const WARM_NOTES = 40
const WARM_THUMBS = 60
const WARM_EVERY_MS = 15 * 60 * 1000
const STATE_KEY = '/__aico/state'

/** Whether to answer from the kept copy: the fetch threw, the status is 5xx, or aico-web did not answer. */
function shouldFallBack({ threw, status, hostHeader }) {
  if (threw) return true
  if (status >= 500) return true
  return !hostHeader
}

/** What kind of request this is, or null when the worker leaves it alone. */
function classify(method, mode, hasRange, rawUrl, origin) {
  if (method !== 'GET' || hasRange) return null
  const url = new URL(rawUrl)
  if (url.origin !== origin) return null
  const path = url.pathname
  if (mode === 'navigate') return PAGES.includes(path.replace(/(.)\/$/, '$1')) ? 'page' : null
  if (path.startsWith('/_next/static/') || path.startsWith('/icons/')) return 'asset'
  if (!/^\/api\/(notes|captures)(\/|$)/.test(path)) return null
  if (/\/(file|preview)$/.test(path)) return null
  return /\/thumb$/.test(path) ? 'thumb' : 'data'
}

const pageKey = (url) => new URL(url).pathname.replace(/(.)\/$/, '$1')

// -- What the pages are told -----------------------------------------------------

let state = null // { offline, notesAt }, loaded from META after a restart

async function loadState() {
  if (state) return state
  try {
    const hit = await (await caches.open(META)).match(STATE_KEY)
    state = hit ? await hit.json() : { offline: false, notesAt: null }
  } catch {
    state = { offline: false, notesAt: null }
  }
  return state
}

async function broadcast() {
  const clients = await self.clients.matchAll({ type: 'window' })
  for (const client of clients) client.postMessage({ type: 'aico-state', ...state })
}

async function setState(change) {
  const current = await loadState()
  const next = { ...current, ...change }
  const changed = next.offline !== current.offline
  // notesAt moves on every poll; keep the write rare.
  const stale = Math.abs((next.notesAt ?? 0) - (current.notesAt ?? 0)) > 30_000
  state = next
  if (changed || stale) {
    try {
      await (await caches.open(META)).put(STATE_KEY, new Response(JSON.stringify(next)))
    } catch {}
  }
  if (changed) await broadcast()
}

// -- The kept copy -----------------------------------------------------------------

async function keep(cacheName, key, response, limit) {
  const cache = await caches.open(cacheName)
  // Delete first so a refreshed entry moves to the newest end of the cache's order.
  await cache.delete(key)
  await cache.put(key, response)
  if (!limit) return
  const keys = await cache.keys()
  for (const old of keys.slice(0, Math.max(0, keys.length - limit))) await cache.delete(old)
}

const canKeep = (response) => response.status === 200 && response.headers.has(HOST_HEADER)

async function viaNetwork(request) {
  // A redirect must reach the browser as it is (the Access login), not look like an outage.
  return request.mode === 'navigate' ? fetch(request) : fetch(request, { redirect: 'manual' })
}

async function networkFirst(event, kind) {
  const request = event.request
  const key = kind === 'page' ? pageKey(request.url) : request.url
  const cacheName = kind === 'page' ? SHELL : kind === 'thumb' ? THUMBS : DATA
  let response = null
  let threw = false
  try {
    response = await viaNetwork(request)
  } catch {
    threw = true
  }
  if (response?.type === 'opaqueredirect') return response
  const fallBack = shouldFallBack({
    threw,
    status: response?.status ?? 0,
    hostHeader: response?.headers.get(HOST_HEADER) ?? null,
  })
  if (!fallBack && response) {
    const path = new URL(request.url).pathname
    const notes = path.startsWith('/api/notes')
    // Copies are taken now: once the page starts reading this answer it cannot be cloned.
    const toKeep = canKeep(response) ? response.clone() : null
    const toWarm =
      toKeep && path === '/api/notes' && !new URL(request.url).searchParams.has('q')
        ? response.clone()
        : null
    event.waitUntil(
      (async () => {
        await setState({ offline: false, ...(notes ? { notesAt: Date.now() } : {}) })
        if (toKeep) await keep(cacheName, key, toKeep, kind === 'thumb' ? THUMB_LIMIT : 0)
        if (toWarm) await warm(toWarm)
      })().catch(() => {}),
    )
    return response
  }
  const cache = await caches.open(cacheName)
  const kept = (await cache.match(key)) ?? (kind === 'page' ? await cache.match('/') : undefined)
  if (kept) {
    event.waitUntil(setState({ offline: true }).catch(() => {}))
    return kept
  }
  return response ?? Response.error()
}

async function cacheFirst(event) {
  const cache = await caches.open(SHELL)
  const kept = await cache.match(event.request.url)
  if (kept) return kept
  const response = await viaNetwork(event.request)
  if (canKeep(response)) event.waitUntil(cache.put(event.request.url, response.clone()).catch(() => {}))
  return response
}

let warmedAt = 0

/** Fetch the details (and thumbs) of the newest notes, at most every WARM_EVERY_MS, so they open offline. */
async function warm(listResponse) {
  if (Date.now() - warmedAt < WARM_EVERY_MS) return
  warmedAt = Date.now()
  const { notes } = await listResponse.json()
  let thumbs = 0
  for (const note of (notes ?? []).slice(0, WARM_NOTES)) {
    try {
      const response = await fetch(`/api/notes/${note.id}`, { redirect: 'manual' })
      if (!canKeep(response)) continue
      await keep(DATA, new URL(`/api/notes/${note.id}`, self.location.origin).href, response.clone(), 0)
      const detail = await response.json()
      for (const attachment of detail.attachments ?? []) {
        if (!attachment.hasThumb || thumbs >= WARM_THUMBS) continue
        thumbs += 1
        const url = new URL(
          `/api/notes/${note.id}/attachments/${attachment.id}/thumb`,
          self.location.origin,
        ).href
        const thumb = await fetch(url, { redirect: 'manual' })
        if (canKeep(thumb)) await keep(THUMBS, url, thumb, THUMB_LIMIT)
      }
    } catch {
      // One note failing does not stop the rest; the next list refresh tries again after the pause.
    }
  }
}

// -- Install, activate, fetch ------------------------------------------------------

/** Keep the three pages and the files they name, so the app opens with no network. */
async function precache() {
  const cache = await caches.open(SHELL)
  const assets = new Set()
  for (const page of PAGES) {
    try {
      const response = await fetch(page, { redirect: 'manual' })
      if (!canKeep(response)) continue
      await cache.put(page, response.clone())
      for (const path of (await response.text()).match(/\/_next\/static\/[^"'\\\s)<>]+/g) ?? [])
        assets.add(path)
    } catch {}
  }
  for (const path of assets) {
    try {
      const response = await fetch(path, { redirect: 'manual' })
      if (canKeep(response)) await cache.put(new URL(path, self.location.origin).href, response)
    } catch {}
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().catch(() => {}).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name.startsWith('aico-') && !CURRENT.includes(name)) await caches.delete(name)
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const kind = classify(
    request.method,
    request.mode,
    request.headers.has('range'),
    request.url,
    self.location.origin,
  )
  if (kind === 'asset') event.respondWith(cacheFirst(event))
  else if (kind) event.respondWith(networkFirst(event, kind))
})

// A page asks for the state when it opens (it may have missed the broadcast).
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'aico-state?') return
  event.waitUntil(
    loadState().then((now) => event.source?.postMessage({ type: 'aico-state', ...now })),
  )
})

// Lets the tests drive the decisions and the handlers; nothing else reads it.
self.aicoSw = { shouldFallBack, classify, pageKey, VERSION }

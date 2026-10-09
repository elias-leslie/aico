// Aico extension — background service worker.
//
// The only component allowed to talk to the sidecar: a content script's fetch
// to 127.0.0.1 is blocked by the page's CORS, but a service worker holding
// `host_permissions` for the loopback origin is exempt. So every send funnels
// here: context-menu clicks build a record directly; the content script (pill /
// picker / tray) relays its records via chrome.runtime.sendMessage.
//
// All sends hit POST /selection/send, which stores the capture(s) AND pushes a
// deliver event over SSE to Aico's main process — which inserts a compact
// reference at the active widget's prompt. Web captures are kind:"dom"; the
// sub-type (text/element/link/image/page) rides in meta.type.

const SIDECAR = 'http://127.0.0.1:8005'
const SNIPPET_CAP = 400

// POST one or more records as an explicit, deliverable batch.
async function sendToBus(items) {
  try {
    const res = await fetch(`${SIDECAR}/selection/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    })
    return res.ok
  } catch {
    // Sidecar down / Aico not running — best-effort; the user just sees no insert.
    return false
  }
}

function baseMeta(info, tab) {
  return { url: info.pageUrl || tab?.url || '', title: tab?.title || '' }
}

// Build a frozen-shape record from a context-menu click.
function recordFromContext(info, tab) {
  const meta = baseMeta(info, tab)
  switch (info.menuItemId) {
    case 'aico-send-selection':
      if (!info.selectionText) return null
      return {
        kind: 'dom',
        snippet: info.selectionText.slice(0, SNIPPET_CAP),
        meta: { ...meta, type: 'text' },
      }
    case 'aico-send-link':
      if (!info.linkUrl) return null
      return {
        kind: 'dom',
        snippet: (info.selectionText || info.linkUrl).slice(0, SNIPPET_CAP),
        meta: { ...meta, type: 'link', href: info.linkUrl },
      }
    case 'aico-send-image':
      if (!info.srcUrl) return null
      return {
        kind: 'dom',
        snippet: info.srcUrl.slice(0, SNIPPET_CAP),
        meta: { ...meta, type: 'image', src: info.srcUrl },
      }
    case 'aico-send-page':
      return {
        kind: 'dom',
        snippet: (tab?.title || meta.url).slice(0, SNIPPET_CAP),
        meta: { ...meta, type: 'page' },
      }
    default:
      return null
  }
}

chrome.runtime.onInstalled.addListener(() => {
  const items = [
    ['aico-send-selection', 'Send selection to Aico', ['selection']],
    ['aico-send-link', 'Send link to Aico', ['link']],
    ['aico-send-image', 'Send image to Aico', ['image']],
    ['aico-send-page', 'Send page to Aico', ['page']],
    ['aico-pick', 'Pick an element for Aico…', ['page']],
  ]
  chrome.contextMenus.removeAll(() => {
    for (const [id, title, contexts] of items) {
      chrome.contextMenus.create({ id, title, contexts })
    }
  })
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'aico-pick') {
    if (tab?.id != null) chrome.tabs.sendMessage(tab.id, { type: 'aico:start-picker' })
    return
  }
  const record = recordFromContext(info, tab)
  if (record) void sendToBus([record])
})

// Mirrors the sidecar's batch cap (selection ring size).
const MAX_ITEMS = 50

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Rebuild a relayed record from known fields only; anything off-shape is dropped
// rather than forwarded. Content scripts only ever produce kind:"dom".
function sanitizeRecord(rec) {
  if (!isPlainObject(rec) || rec.kind !== 'dom' || typeof rec.snippet !== 'string') return null
  if (rec.meta !== undefined && !isPlainObject(rec.meta)) return null
  return { kind: 'dom', snippet: rec.snippet.slice(0, SNIPPET_CAP), meta: rec.meta || {} }
}

// Content-script relay: pill / picker / tray sends arrive here to clear CORS.
// Accept only messages from this extension's own content scripts (a tab-hosted
// sender with our runtime ID) carrying a well-formed batch.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender?.id !== chrome.runtime.id || !sender.tab) return false
  if (msg?.type !== 'aico:send' || !Array.isArray(msg.items)) return false
  if (!msg.items.length || msg.items.length > MAX_ITEMS) return false
  const items = msg.items.map(sanitizeRecord)
  if (items.some((rec) => rec === null)) return false
  sendToBus(items).then((ok) => sendResponse({ ok }))
  return true // keep the channel open for the async response
})

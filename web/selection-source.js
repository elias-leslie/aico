// Aico DOM selection source.
//
// Include this on your own web apps. It reports the user's current text
// selection to Aico's selection bus (the sidecar), debounced. The global
// "indicate" hotkey then harvests the latest capture and routes it to the
// last-focused widget. Token-efficient by construction: the snippet is capped
// and the meta is just url / title / a short CSS path.
//
//   <script src="/path/to/selection-source.js"></script>
//
// Override the sidecar origin before loading if it isn't the loopback default:
//   <script>window.AICO_SIDECAR = 'http://127.0.0.1:8005'</script>
;(() => {
  // biome-ignore lint/suspicious/noRedundantUseStrict: classic <script> (not an ES module) — strict mode is load-bearing
  'use strict'

  var DEFAULT_SIDECAR = 'http://127.0.0.1:8005'
  var SIDECAR = resolveSidecar(window.AICO_SIDECAR)
  var DEBOUNCE_MS = 200
  var SNIPPET_CAP = 200
  var timer = null

  // `window.AICO_SIDECAR` is DOM-clobberable (an element with id/name
  // "AICO_SIDECAR" shadows it), so accept only a string naming a loopback http
  // origin; anything else falls back to the default.
  function resolveSidecar(value) {
    if (typeof value !== 'string') return DEFAULT_SIDECAR
    var url
    try {
      url = new URL(value)
    } catch {
      return DEFAULT_SIDECAR
    }
    var loopback =
      url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
    if (url.protocol !== 'http:' || !loopback || url.username || url.password) {
      return DEFAULT_SIDECAR
    }
    return url.origin
  }

  // Short, human-legible CSS path of the selection's anchor (≤4 levels). Enough
  // for an agent to know *where* on the page the selection came from, cheaply.
  function cssPath(node) {
    var el = node && node.nodeType === 3 ? node.parentElement : node
    var parts = []
    while (el && el.nodeType === 1 && parts.length < 4) {
      let part = el.tagName.toLowerCase()
      if (el.id) {
        parts.unshift(`${part}#${el.id}`)
        break
      }
      if (typeof el.className === 'string' && el.className.trim()) {
        part += `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
      }
      parts.unshift(part)
      el = el.parentElement
    }
    return parts.join(' > ')
  }

  function report() {
    var sel = window.getSelection()
    var text = sel ? String(sel).trim() : ''
    if (!text) return
    var payload = {
      kind: 'dom',
      snippet: text.slice(0, SNIPPET_CAP),
      meta: {
        url: location.href,
        title: document.title,
        selector: sel.anchorNode ? cssPath(sel.anchorNode) : '',
      },
    }
    fetch(`${SIDECAR}/selection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {
      // Sidecar not running / unreachable — selection capture is best-effort.
    })
  }

  document.addEventListener('selectionchange', () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(report, DEBOUNCE_MS)
  })
})()

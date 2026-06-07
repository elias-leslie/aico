// Aico extension — content script.
//
// Renders Aico's in-page grab UI inside a Shadow DOM host (so page CSS can't
// bleed in) and relays captures to the background worker, which POSTs them to
// the sidecar. Three SOTA gestures, all explicit (EULA: no silent injection):
//
//   1. Pill   — auto-appears by a text selection; "Send" delivers it now, "+"
//               stashes it in the batch tray.
//   2. Picker — context-menu "Pick an element…" → hover-outline any element →
//               click to stash it; Esc / "Done" exits.
//   3. Tray   — accumulates stashed items; "Send N" delivers them as one batch.
//
// Every record keeps the frozen shape ({kind,snippet,meta}); web captures are
// kind:"dom" with the sub-type in meta.type.
;(() => {
  // biome-ignore lint/suspicious/noRedundantUseStrict: classic content script, not an ES module — strict mode is load-bearing
  'use strict'
  if (window.__aicoInjected) return
  window.__aicoInjected = true

  const SNIPPET_CAP = 400

  // --- record builders ----------------------------------------------------

  // Short, human-legible CSS path of a node (≤4 levels) — enough for an agent
  // to know *where* on the page a capture came from, cheaply.
  function cssPath(node) {
    let el = node && node.nodeType === 3 ? node.parentElement : node
    const parts = []
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

  function pageMeta() {
    return { url: location.href, title: document.title }
  }

  function selectionRecord() {
    const sel = window.getSelection()
    const text = sel ? String(sel).trim() : ''
    if (!text) return null
    return {
      kind: 'dom',
      snippet: text.slice(0, SNIPPET_CAP),
      meta: {
        ...pageMeta(),
        type: 'text',
        selector: sel.anchorNode ? cssPath(sel.anchorNode) : '',
      },
    }
  }

  function elementRecord(el) {
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
    return {
      kind: 'dom',
      snippet: (text || el.tagName.toLowerCase()).slice(0, SNIPPET_CAP),
      meta: {
        ...pageMeta(),
        type: 'element',
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '',
        selector: cssPath(el),
      },
    }
  }

  function send(items) {
    chrome.runtime.sendMessage({ type: 'aico:send', items }, (resp) => {
      // Swallow "receiving end does not exist" when the worker is asleep; the
      // first send wakes it. Feedback is the pill/tray flash, set by callers.
      void chrome.runtime.lastError
      void resp
    })
  }

  // --- shadow-DOM host -----------------------------------------------------

  const host = document.createElement('div')
  host.id = '__aico_host'
  host.style.cssText =
    'all: initial; position: fixed; z-index: 2147483647; inset: 0; pointer-events: none;'
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .pill, .tray, .toast { font: 13px/1.3 -apple-system, system-ui, sans-serif; pointer-events: auto; }
      .pill {
        position: fixed; display: none; gap: 0; align-items: stretch;
        background: rgba(28,28,32,.96); color: #f4f4f5; border-radius: 8px;
        box-shadow: 0 6px 22px rgba(0,0,0,.4); overflow: hidden; backdrop-filter: blur(8px);
      }
      .pill button {
        all: unset; cursor: pointer; padding: 6px 11px; color: inherit;
        display: flex; align-items: center;
      }
      .pill button:hover { background: rgba(255,255,255,.12); }
      .pill .send { font-weight: 600; }
      .pill .add { border-left: 1px solid rgba(255,255,255,.14); font-size: 15px; }
      .tray {
        position: fixed; right: 16px; bottom: 16px; display: none; flex-direction: column;
        width: 290px; max-height: 50vh; background: rgba(28,28,32,.97); color: #f4f4f5;
        border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.45); overflow: hidden;
        backdrop-filter: blur(10px);
      }
      .tray .head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 9px 12px; border-bottom: 1px solid rgba(255,255,255,.1); font-weight: 600;
      }
      .tray .head .x { all: unset; cursor: pointer; opacity: .6; padding: 0 4px; }
      .tray .head .x:hover { opacity: 1; }
      .tray .list { overflow-y: auto; flex: 1; }
      .tray .row {
        display: flex; align-items: center; gap: 8px; padding: 7px 12px;
        border-bottom: 1px solid rgba(255,255,255,.06);
      }
      .tray .row .chip {
        font-size: 10px; text-transform: uppercase; letter-spacing: .04em;
        background: rgba(245,200,120,.18); color: #f5c878; border-radius: 4px;
        padding: 1px 5px; flex: none;
      }
      .tray .row .txt { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: .9; }
      .tray .row .rm { all: unset; cursor: pointer; opacity: .5; flex: none; }
      .tray .row .rm:hover { opacity: 1; }
      .tray .send-all { all: unset; cursor: pointer; text-align: center; font-weight: 600;
        padding: 10px; background: rgba(245,200,120,.16); color: #f5c878; }
      .tray .send-all:hover { background: rgba(245,200,120,.26); }
      .toast {
        position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%);
        background: rgba(28,28,32,.96); color: #f4f4f5; padding: 8px 14px; border-radius: 8px;
        box-shadow: 0 6px 22px rgba(0,0,0,.4); display: none;
      }
      .toast b { color: #f5c878; }
      .pick-outline {
        position: fixed; display: none; pointer-events: none; border: 2px solid #f5c878;
        background: rgba(245,200,120,.12); border-radius: 3px; z-index: 1;
      }
    </style>
    <div class="pill">
      <button class="send">Send to Aico</button>
      <button class="add" title="Add to batch">＋</button>
    </div>
    <div class="tray">
      <div class="head"><span class="title">Aico batch</span><button class="x" title="Clear">✕</button></div>
      <div class="list"></div>
      <button class="send-all"></button>
    </div>
    <div class="toast"></div>
    <div class="pick-outline"></div>
  `
  document.documentElement.appendChild(host)

  const pillEl = root.querySelector('.pill')
  const trayEl = root.querySelector('.tray')
  const listEl = root.querySelector('.list')
  const sendAllEl = root.querySelector('.send-all')
  const toastEl = root.querySelector('.toast')
  const outlineEl = root.querySelector('.pick-outline')

  // --- toast ---------------------------------------------------------------

  let toastTimer = null
  // Build the toast from text nodes (and {b} for emphasis) rather than innerHTML,
  // so no caller can ever route page-derived text into an HTML sink.
  function flashToast(...segments) {
    toastEl.replaceChildren(
      ...segments.map((seg) => {
        if (typeof seg === 'string') return document.createTextNode(seg)
        const b = document.createElement('b')
        b.textContent = seg.b
        return b
      }),
    )
    toastEl.style.display = 'block'
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      toastEl.style.display = 'none'
    }, 2000)
  }

  // --- batch tray ----------------------------------------------------------

  const tray = []

  function renderTray() {
    if (!tray.length) {
      trayEl.style.display = 'none'
      return
    }
    trayEl.style.display = 'flex'
    listEl.replaceChildren(
      ...tray.map((rec, i) => {
        const row = document.createElement('div')
        row.className = 'row'
        const chip = document.createElement('span')
        chip.className = 'chip'
        chip.textContent = rec.meta?.type || rec.kind
        const txt = document.createElement('span')
        txt.className = 'txt'
        txt.textContent = rec.snippet
        const rm = document.createElement('button')
        rm.className = 'rm'
        rm.textContent = '✕'
        rm.title = 'Remove'
        rm.addEventListener('click', () => {
          tray.splice(i, 1)
          renderTray()
        })
        row.append(chip, txt, rm)
        return row
      }),
    )
    sendAllEl.textContent = `Send ${tray.length} to Aico`
  }

  function addToTray(rec) {
    if (!rec) return
    tray.push(rec)
    renderTray()
  }

  sendAllEl.addEventListener('click', () => {
    if (!tray.length) return
    const n = tray.length
    send(tray.splice(0))
    renderTray()
    flashToast('Sent ', { b: String(n) }, ` item${n > 1 ? 's' : ''} to Aico`)
  })

  root.querySelector('.x').addEventListener('click', () => {
    tray.length = 0
    renderTray()
  })

  // --- selection pill ------------------------------------------------------

  function hidePill() {
    pillEl.style.display = 'none'
  }

  function positionPill() {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !String(sel).trim()) return hidePill()
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    if (!rect.width && !rect.height) return hidePill()
    pillEl.style.display = 'flex'
    const pw = pillEl.offsetWidth || 130
    const ph = pillEl.offsetHeight || 32
    let top = rect.top - ph - 8
    if (top < 4) top = rect.bottom + 8 // flip below when near the top edge
    let left = rect.left + rect.width / 2 - pw / 2
    left = Math.max(4, Math.min(left, window.innerWidth - pw - 4))
    pillEl.style.top = `${top}px`
    pillEl.style.left = `${left}px`
  }

  root.querySelector('.send').addEventListener('click', () => {
    const rec = selectionRecord()
    if (rec) {
      send([rec])
      flashToast('Sent ', { b: rec.meta.type }, ' to Aico')
    }
    hidePill()
    window.getSelection()?.removeAllRanges()
  })

  root.querySelector('.add').addEventListener('click', () => {
    const rec = selectionRecord()
    if (rec) {
      addToTray(rec)
      flashToast('Added to batch')
    }
    hidePill()
    window.getSelection()?.removeAllRanges()
  })

  // Reposition after the mouse settles (selection finished). selectionchange
  // fires mid-drag, so debounce to the next frame on mouseup/keyup.
  function refreshPill() {
    requestAnimationFrame(positionPill)
  }
  document.addEventListener('mouseup', refreshPill)
  document.addEventListener('keyup', (e) => {
    if (e.shiftKey || e.key === 'Shift') refreshPill()
  })
  // Hide when the selection is cleared by an outside click (not on our UI).
  document.addEventListener('mousedown', (e) => {
    if (e.composedPath().includes(host)) return
    if (!String(window.getSelection() || '').trim()) hidePill()
  })

  // --- element picker ------------------------------------------------------

  let picking = false

  function elementUnder(x, y) {
    // Our host sits on top with pointer-events:none on the wrapper, but be safe.
    const el = document.elementFromPoint(x, y)
    return el && el !== host && !host.contains(el) ? el : null
  }

  function onPickMove(e) {
    const el = elementUnder(e.clientX, e.clientY)
    if (!el) return
    const r = el.getBoundingClientRect()
    outlineEl.style.display = 'block'
    outlineEl.style.top = `${r.top}px`
    outlineEl.style.left = `${r.left}px`
    outlineEl.style.width = `${r.width}px`
    outlineEl.style.height = `${r.height}px`
  }

  function onPickClick(e) {
    const el = elementUnder(e.clientX, e.clientY)
    if (!el) return
    e.preventDefault()
    e.stopPropagation()
    addToTray(elementRecord(el))
    flashToast('Added element to batch — Esc when done')
  }

  function onPickKey(e) {
    if (e.key === 'Escape') stopPicker()
  }

  function startPicker() {
    if (picking) return
    picking = true
    document.addEventListener('mousemove', onPickMove, true)
    document.addEventListener('click', onPickClick, true)
    document.addEventListener('keydown', onPickKey, true)
    flashToast('Picker on — click elements to add, Esc to finish')
  }

  function stopPicker() {
    picking = false
    outlineEl.style.display = 'none'
    document.removeEventListener('mousemove', onPickMove, true)
    document.removeEventListener('click', onPickClick, true)
    document.removeEventListener('keydown', onPickKey, true)
    if (tray.length) flashToast(`${tray.length} in batch — "Send" when ready`)
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'aico:start-picker') startPicker()
  })
})()

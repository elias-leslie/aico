// Chat mockup (M8b-2): static and clickable. The hash picks a view; ?frame=phone&screen=…
// draws one phone screen at 390px (the Phone view shows them in iframes). ?dialog=new,
// ?details=1, ?branch=3 and ?still=1 open a dialog, the details drawer, the branch dialog,
// or hold the streaming reply still, for screenshots.
;(() => {
  const { CHAIN, ROLES, PROJECTS, CHATS, TURNS, DETAILS } = window.MOCK
  const params = new URLSearchParams(location.search)
  const FRAME = params.get('frame')
  const SCREEN = params.get('screen') || 'list'
  if (FRAME) document.body.classList.add('frame')

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>')
  const roleName = (id) => ROLES.find((r) => r.id === id).name

  const PATHS = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    chev: '<path d="m9 6 6 6-6 6"/>',
    back: '<path d="M15 6 9 12l6 6"/>',
    branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-11.4 7.4"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
    clip: '<path d="m20 11.5-7.6 7.6a5 5 0 0 1-7.1-7.1l8-8a3.4 3.4 0 0 1 4.8 4.8l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.3-7.3"/>',
    camera: '<path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    image: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m20 16-5-5-8 8"/>',
    file: '<path d="M7 3.5h7l4 4V20.5H7z"/><path d="M14 3.5v4h4"/>',
    send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
    swap: '<path d="M5 9h13l-3-3M19 15H6l3 3"/>',
    hand: '<path d="M5 12h12M13 7l5 5-5 5"/>',
    fold: '<path d="M6 9h12M6 15h12M9 4l3 3 3-3M9 20l3-3 3 3"/>',
    resume: '<path d="M8 5v14l11-7z"/>',
    lock: '<rect x="6" y="11" width="12" height="9" rx="1.5"/><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3"/>',
    inbox: '<path d="M4 13h4l1.5 2.5h5L16 13h4M5 6h14l1 7v5H4v-5z"/>',
    chat: '<path d="M5 5.5h14v10H10l-4 3.5v-3.5H5z"/>',
    notes: '<path d="M6 4h12v16H6zM9 8h6M9 12h6M9 16h4"/>',
    status: '<path d="M4 12h3l2.5-6 5 12 2.5-6h3"/>',
    hosts: '<rect x="4" y="5" width="16" height="6" rx="1.5"/><rect x="4" y="13" width="16" height="6" rx="1.5"/>',
    refresh: '<path d="M19 8a7.5 7.5 0 1 0 .6 6M19 4v4h-4"/>',
    mark: '<path d="M12 3.5 14 9l5.5 1-4 3.8 1 5.7-4.5-2.7-4.5 2.7 1-5.7-4-3.8L10 9z"/>',
  }
  const icon = (n, size = 16) => `<svg class="i" viewBox="0 0 24 24" width="${size}" height="${size}" style="width:${size}px;height:${size}px" aria-hidden="true">${PATHS[n]}</svg>`

  const STATE = {
    needs: ['needs', 'Needs you'],
    working: ['working', 'Working'],
    idle: ['idle', 'Idle'],
    stopped: ['stopped', 'Stopped mid-reply'],
    failed: ['failed', 'No model answered'],
    finished: ['finished', 'Ended'],
  }
  const chip = (s, extra = '') => `<span class="chip ${s === 'loading' ? 'loading' : STATE[s][0]} ${extra}">${s === 'loading' ? 'Opening' : STATE[s][1]}</span>`

  // ---------- overlay, toast ----------
  const overlay = document.getElementById('overlay')
  function closeOverlay() { overlay.classList.remove('on'); overlay.innerHTML = '' }
  function openSheet(kind, title, body, foot) {
    overlay.innerHTML = `<div class="scrim" data-close></div><div class="sheet ${kind}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      ${kind === 'bottom' ? '<div class="grab"></div>' : ''}
      <header><h2>${title}</h2><button class="lantern-icon-btn" data-close aria-label="Close">${icon('x', 18)}</button></header>
      <div class="body">${body}</div>${foot ? `<footer>${foot}</footer>` : ''}</div>`
    overlay.classList.add('on')
    overlay.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeOverlay))
    return overlay.querySelector('.sheet')
  }
  function toast(text) {
    document.querySelectorAll('.toast').forEach((t) => t.remove())
    const t = document.createElement('div')
    t.className = 'toast'
    t.setAttribute('role', 'status')
    t.textContent = text
    document.body.append(t)
    setTimeout(() => t.remove(), 2600)
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOverlay() })

  // ---------- app chrome ----------
  function sidebar(current) {
    const needs = CHATS.filter((c) => c.state === 'needs')
    const rest = CHATS.filter((c) => c.state !== 'needs' && c.state !== 'finished')
    const meta = (c) => `${roleName(c.role)} · ${c.model} · ${c.state === 'needs' ? 'waiting for you' : STATE[c.state][1].toLowerCase()}`
    const row = (c) => `<button class="lantern-row${c.state === 'needs' ? ' needs' : ''}" ${c.id === current ? 'aria-current="true"' : ''} data-open="${c.id}">
        <span class="mark chat">${icon('chat', 15)}</span><b>${esc(c.title)}</b><span class="t">${c.at.replace(' PM', 'p').replace(' AM', 'a')}</span><small>${meta(c)}</small></button>`
    const other = `<button class="lantern-row"><span class="mark">${icon('mark', 15)}</span><b>aico</b><span class="t">2:40p</span><small>Claude Code · working</small></button>
      <button class="lantern-row"><span class="mark">${icon('mark', 15)}</span><b>summitflow</b><span class="t">1:12p</span><small>Codex · idle</small></button>`
    return `<aside class="sidebar" aria-label="Sessions">
      <h2>Sessions · ${needs.length + rest.length + 2}</h2>
      <nav class="side-nav" aria-label="Aico">
        <button>${icon('inbox', 15)}Needs you<span class="count">${needs.length}</span></button>
        <button aria-current="page">${icon('chat', 15)}Chats</button>
        <button>${icon('camera', 15)}Capture</button><button>${icon('notes', 15)}Notes</button>
        <button>${icon('status', 15)}Status</button><button>${icon('hosts', 15)}Hosts</button>
      </nav>
      <h3 class="lantern-sec">Needs you <span class="n">${needs.length}</span></h3>
      ${needs.map(row).join('')}
      <h3 class="lantern-sec">Other sessions <span class="n">${rest.length + 2}</span></h3>
      ${rest.map(row).join('')}${other}
    </aside>`
  }
  function shell(el, current, mainHtml) {
    el.innerHTML = `<div class="shell">${sidebar(current)}<main class="main">${mainHtml}</main></div>`
    el.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.open
      location.hash = id === 'c2' ? 'waiting' : id === 'c1' ? 'chat' : id === 'c4' ? 'states' : 'chat'
    }))
    return el.querySelector('main')
  }

  // ---------- chat list ----------
  function listHtml(chats) {
    const groups = [['Needs you', chats.filter((c) => c.state === 'needs')], ['Recent', chats.filter((c) => c.state !== 'needs')]]
    const row = (c) => `<button class="lrow${c.state === 'needs' ? ' needs' : ''}" data-open="${c.id}">
      <span>${chip(c.state)}</span>
      <span style="min-width:0"><div class="what">${esc(c.title)}</div><div class="last">${esc(c.last)}</div></span>
      <span class="cell"><b>${roleName(c.role)}</b></span>
      <span class="cell mono" title="The model that answered last">${c.model}</span>
      <span class="cell">${c.project}</span>
      <span class="cell when">${c.at}</span></button>`
    return groups.filter(([, g]) => g.length).map(([name, g]) => `<h3 class="lantern-sec" style="margin-left:2px">${name} <span class="n">${g.length}</span></h3>
      ${name === 'Recent' ? '<div class="lhead"><span>State</span><span>Chat</span><span>Role</span><span>Model</span><span>Project</span><span>Last activity</span></div>' : ''}
      <div class="rows">${g.map(row).join('')}</div>`).join('')
  }
  function listPage(main) {
    const needs = CHATS.filter((c) => c.state === 'needs').length
    main.innerHTML = `<div class="page">
      <div class="page-head"><h1>Chats</h1><span class="sub">${CHATS.length} chats · ${needs} needs you</span><span class="grow"></span>
        <button class="lantern-btn primary" data-new>${icon('plus')}New chat</button></div>
      <div class="filters">
        <label class="lantern-field">${icon('search')}<input placeholder="Search chats" aria-label="Search chats"></label>
        <label class="lbl">Role <select class="select" aria-label="Role"><option>Any</option>${ROLES.map((r) => `<option>${r.name}</option>`).join('')}</select></label>
        <label class="lbl">State <select class="select" aria-label="State"><option>Any</option>${Object.values(STATE).map((s) => `<option>${s[1]}</option>`).join('')}</select></label>
        <label class="lbl">Project <select class="select" aria-label="Project"><option>Any</option>${PROJECTS.map((p) => `<option>${p}</option>`).join('')}</select></label>
      </div>
      <div id="chat-rows">${listHtml(CHATS)}</div></div>`
    main.querySelector('[data-new]').addEventListener('click', newChat)
    main.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => { location.hash = b.dataset.open === 'c2' ? 'waiting' : b.dataset.open === 'c1' ? 'chat' : 'states' }))
  }

  function newChat() {
    const roleOpts = ROLES.map((r, i) => `<label><input type="radio" name="role" value="${r.id}" ${i === 0 ? 'checked' : ''}><span><b>${r.name}</b><small>${r.what}</small></span></label>`).join('')
    const sheet = openSheet('center', 'New chat', `
      <div class="field"><span>Role</span><div class="roles">${roleOpts}</div></div>
      <div class="field"><span>Model</span>
        <select class="select" id="nc-model" aria-label="Model"></select>
        <span class="route" id="nc-route"></span></div>
      <label class="field"><span>Project folder</span><select class="select">${PROJECTS.map((p) => `<option>${p}</option>`).join('')}</select></label>
      <label class="field"><span>Message</span><textarea placeholder="What do you need?"></textarea></label>
      <div><button class="lantern-btn ghost small">${icon('clip')}Add photos or files</button></div>`,
      '<button class="lantern-btn ghost" data-close>Cancel</button><button class="lantern-btn primary" data-start>Start chat</button>')
    const model = sheet.querySelector('#nc-model')
    const route = sheet.querySelector('#nc-route')
    const fill = () => {
      const role = ROLES.find((r) => r.id === sheet.querySelector('input[name=role]:checked').value)
      const chain = CHAIN[role.id]
      model.innerHTML = `<option>${chain[0]}, ${role.effort} (from routing)</option>${chain.slice(1).map((m) => `<option>${m}</option>`).join('')}`
      route.innerHTML = `Routing picked <b>${chain[0]}</b>: it has room. If it can’t answer, <b>${chain[1]}</b> takes over, then <b>${chain[2]}</b>.`
    }
    sheet.querySelectorAll('input[name=role]').forEach((r) => r.addEventListener('change', fill))
    fill()
    sheet.querySelector('[data-close]').addEventListener('click', closeOverlay)
    sheet.querySelector('[data-start]').addEventListener('click', () => { closeOverlay(); toast('Chat started. It’s at the top of your sessions.') })
    sheet.querySelector('textarea').focus()
  }

  // ---------- one chat ----------
  function toolHtml(t) {
    if (t.withheld)
      return `<details class="tool withheld"><summary title="The call names a credential path, so its output isn’t kept in the chat. The model still saw it."><span class="lock">${icon('lock', 14)}</span><span class="line">${esc(t.line)}</span><span class="note">Output not saved: credential path</span></summary></details>`
    const body = t.kind === 'edit'
      ? esc(t.body).split('\n').map((l) => l.startsWith('+') ? `<span class="add">${l}</span>` : l.startsWith('-') ? `<span class="del">${l}</span>` : l).join('\n')
      : esc(t.body)
    return `<details class="tool"><summary><span class="chev">${icon('chev', 14)}</span><span class="line">${esc(t.line)}</span><span class="note">${esc(t.note)}</span></summary><pre>${body}</pre></details>`
  }
  function eventHtml(h, turn) {
    if (h.kind === 'refusal')
      return `<div class="event" role="note">${icon('hand')}<div><p><b>${h.from}</b> declined this turn (${h.category}). <b>${h.to}</b> took it over with the whole chat; nothing above was lost.</p>
        <details><summary>What ${h.from} said</summary><pre>${esc(h.detail)}</pre></details></div></div>`
    return `<div class="event" role="note">${icon('swap')}<div><p><b>${h.from}</b> didn’t answer (${h.category}). <b>${h.to}</b> took the same request as turn ${turn + 1} and goes on from here.</p>
      <details><summary>What happened</summary><pre>${esc(h.detail)}</pre></details></div></div>`
  }
  function turnHtml(t, opts = {}) {
    if (t.who === 'you')
      return `<div class="msg you"><div class="head"><span class="who">You</span><span>${t.at}</span>
        <span class="acts"><button class="lantern-btn ghost" data-copy="your message">${icon('copy', 14)}Copy</button></span></div>
        <div class="bubble">${md(t.text)}</div></div>`
    if (t.handoff && (t.refused || t.noAnswer)) return eventHtml(t.handoff, t.turn)
    const streaming = t.streaming && opts.stream
    const acts = streaming ? '' : `<span class="acts"><button class="lantern-btn ghost" data-branch="${t.turn}">${icon('branch', 14)}Branch from here</button><button class="lantern-btn ghost" data-copy="turn ${t.turn}">${icon('copy', 14)}Copy</button></span>`
    return `<div class="msg model" data-turn="${t.turn}"><div class="head"><span class="model" title="Turn ${t.turn} · ${esc(t.tokens || '')}">${t.model}</span><span>Turn ${t.turn} · ${t.at}</span>${acts}</div>
      ${t.tools ? `<div class="tools">${t.tools.map(toolHtml).join('')}</div>` : ''}
      <div class="text">${streaming ? '' : md(t.text)}</div>
      ${streaming ? `<div class="writing">${t.model} is writing…</div>` : ''}</div>`
  }

  function composerHtml({ working, model, phone, attach, placeholder }) {
    const atts = attach ? `<div class="attach-row">
        <span class="att"><span class="thumb">${icon('image', 14)}</span><span style="min-width:0"><span class="name">Photo, 2.4 MB</span><span class="st">Sending 64%</span><span class="bar-p"><i style="width:64%"></i></span></span><button class="lantern-icon-btn" style="width:28px;height:28px" aria-label="Remove the photo">${icon('x', 14)}</button></span>
        <span class="att"><span class="thumb">${icon('file', 14)}</span><span style="min-width:0"><span class="name">sync-log.txt</span><span class="st">Ready</span></span><button class="lantern-icon-btn" style="width:28px;height:28px" aria-label="Remove sync-log.txt">${icon('x', 14)}</button></span></div>` : ''
    // While a reply is being written, Stop sits by the state; this button queues the message.
    const send = `<button class="send" aria-label="${working ? 'Send after this reply' : 'Send'}" title="${working ? 'Send after this reply' : 'Send'}" ${attach ? 'disabled' : ''}>${icon('send', 18)}</button>`
    if (phone)
      return `<div class="composer">${atts}<div class="box"><button class="lantern-icon-btn" data-attach aria-label="Add photos or files">${icon('plus', 20)}</button>
        <textarea rows="1" aria-label="Message" placeholder="${placeholder || 'Message'}">${attach ? 'This is what the phone showed, and its log' : ''}</textarea>${send}</div>
        <div class="bar"><span class="mono">${model}</span><span>·</span><span>${attach ? 'Sends when the photo is up' : working ? 'Sends after this reply' : 'Next turn'}</span></div></div>`
    return `<div class="composer"><div class="inner">${atts}<div class="box">
      <button class="lantern-icon-btn" data-attach aria-label="Add photos or files" title="Add photos or files">${icon('clip', 18)}</button>
      <textarea rows="1" aria-label="Message" placeholder="${placeholder || (working ? 'Message (sends when this reply ends)' : 'Message')}"></textarea>${send}</div>
      <div class="bar"><label class="lbl">Model <select class="select" aria-label="Model for the next turn"><option>${model} (answered last)</option>${CHAIN.implementation.filter((m) => m !== model).map((m) => `<option>${m}</option>`).join('')}</select></label>
      <label class="lbl">Effort <select class="select" aria-label="Effort"><option>xhigh</option><option>high</option><option>medium</option></select></label>
      <span class="grow"></span><span>Enter sends · Shift+Enter new line</span></div></div></div>`
  }

  function details() {
    const d = DETAILS
    return `<aside class="drawer" aria-label="Chat details"><div class="top"><h2>Details</h2><button class="lantern-icon-btn" data-close-drawer aria-label="Close details">${icon('x', 18)}</button></div>
      <dl>
        <dt>Now</dt><dd>Working on turn 5 with glm-5.3, since 2:33 PM</dd>
        <dt>Role</dt><dd>Implementation, effort xhigh</dd>
        <dt>Models</dt><dd><span class="mono">${CHAIN.implementation.join(' → ')}</span><br><span class="muted">The role’s order. A model that declines or fails hands the turn to the next.</span></dd>
        <dt>Folder</dt><dd class="mono">${d.folder}</dd>
        <dt>Tokens</dt><dd>${d.tokens.input} in (${d.tokens.cache} from cache, ${d.tokens.cacheWrite} written to cache) · ${d.tokens.output} out
          <table><tr><th>Model</th><th class="n">In</th><th class="n">Out</th></tr>${d.byModel.map((r) => `<tr><td><span class="mono">${r[0]}</span><br><span class="muted">${r[1]}</span></td><td class="n">${r[2]}</td><td class="n">${r[3]}</td></tr>`).join('')}</table></dd>
        <dt>Tool calls</dt><dd>${d.toolCalls}</dd>
        <dt>Handoffs</dt><dd>${d.handoffs}</dd>
        <dt>Summaries</dt><dd>None yet. Long chats are summarized to fit the model’s window.</dd>
        <dt>Started</dt><dd>${d.started} · 32 min so far</dd>
        <dt>From the CLI</dt><dd><div class="cmd"><code>aico agent show ${d.run}</code><button class="lantern-icon-btn" data-copy="the command" aria-label="Copy the command">${icon('copy', 15)}</button></div></dd>
      </dl></aside>`
  }

  function branchDialog(turn) {
    const t = TURNS.find((x) => x.turn === Number(turn)) || { model: 'gpt-6.1-sol' }
    const sheet = openSheet('center', `Branch from turn ${turn}`, `
      <p>A new chat starts with everything up to the end of turn ${turn} (${t.model}’s reply). This chat stays as it is.</p>
      <label class="field"><span>Message for the new chat</span><textarea placeholder="What should go differently?">Fix it without the revisions list: keep the server copy and put the phone’s text in a new note.</textarea></label>
      <label class="field"><span>Model</span><select class="select"><option>${t.model} (answered turn ${turn})</option>${CHAIN.implementation.filter((m) => m !== t.model).map((m) => `<option>${m}</option>`).join('')}</select></label>`,
      '<button class="lantern-btn ghost" data-close>Cancel</button><button class="lantern-btn primary" data-go>Start branch</button>')
    sheet.querySelector('[data-close]').addEventListener('click', closeOverlay)
    sheet.querySelector('[data-go]').addEventListener('click', () => { closeOverlay(); toast(`Branch started from turn ${turn}. It’s in Chats as “Notes sync, branch at turn ${turn}”.`) })
  }

  function wire(root) {
    root.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => toast(`Copied ${b.dataset.copy}.`)))
    root.querySelectorAll('[data-branch]').forEach((b) => b.addEventListener('click', () => branchDialog(b.dataset.branch)))
    root.querySelectorAll('[data-attach]').forEach((b) => b.addEventListener('click', () => attachSheet()))
  }

  function stream(root, still) {
    const t = TURNS.find((x) => x.streaming)
    const el = root.querySelector(`[data-turn="${t.turn}"] .text`)
    const words = t.text.split(' ')
    let n = still ? Math.floor(words.length * 0.55) : 0
    const draw = () => { el.innerHTML = `${md(words.slice(0, n).join(' '))}<span class="caret" aria-hidden="true"></span>` }
    draw()
    if (still) return
    const timer = setInterval(() => {
      n += 2
      if (n >= words.length) {
        clearInterval(timer)
        const msg = root.querySelector(`[data-turn="${t.turn}"]`)
        msg.outerHTML = turnHtml({ ...t, streaming: false })
        wire(root.querySelector(`[data-turn="${t.turn}"]`))
        const head = root.querySelector('.chat-head, .p-state')
        head.querySelector('.chip').outerHTML = chip('idle')
        head.querySelector('[data-stop]')?.remove()
        root.querySelector('.composer').outerHTML = composerHtml({ model: 'glm-5.3', phone: root.classList.contains('phone') })
        wire(root.querySelector('.composer'))
        return
      }
      draw()
    }, 140)
  }

  function chatHtml({ phone }) {
    const head = phone
      ? `<div class="p-head"><button class="lantern-icon-btn" aria-label="Back to chats">${icon('back', 20)}</button><h1>Notes sync drops edits made offline</h1><button class="lantern-icon-btn" aria-label="Details">${icon('info', 19)}</button></div>
         <div class="p-state">${chip('working')}<span>glm-5.3 · Implementation</span><span class="grow" style="flex:1"></span><button class="lantern-btn small" data-stop>Stop</button></div>`
      : `<header class="chat-head"><span class="crumb">Chats /</span><h1>Notes sync drops edits made offline</h1>${chip('working')}
          <span class="facts">Implementation · aico · since 2:12 PM</span><span class="grow"></span>
          <button class="lantern-btn" data-stop>${icon('stop', 14)}Stop</button>
          <button class="lantern-icon-btn" data-details aria-label="Details: tokens, models, run" title="Details: tokens, models, run">${icon('info', 18)}</button></header>`
    return `${head}<div class="${phone ? 'p-body' : 'chat-body'}"><div class="thread">${TURNS.map((t) => turnHtml(t, { stream: true })).join('')}</div></div>
      ${composerHtml({ working: true, model: 'glm-5.3', phone })}`
  }

  function chatView(main) {
    main.innerHTML = `<div class="chat">${chatHtml({ phone: false })}</div>`
    const root = main.querySelector('.chat')
    wire(root)
    stream(root, params.has('still'))
    const toggle = () => {
      const d = main.querySelector('.drawer')
      if (d) { d.remove(); return }
      main.insertAdjacentHTML('beforeend', details())
      const drawer = main.querySelector('.drawer')
      wire(drawer)
      drawer.querySelector('[data-close-drawer]').addEventListener('click', toggle)
    }
    root.querySelector('[data-details]').addEventListener('click', toggle)
    root.querySelector('[data-stop]').addEventListener('click', () => toast('Stopped. What glm-5.3 wrote so far is kept; Finish the reply picks it up.'))
    root.querySelector('.chat-body').scrollTop = 1e6
    if (params.has('details')) toggle()
    if (params.get('branch')) branchDialog(params.get('branch'))
    if (params.get('show-acts')) root.querySelector(`[data-turn="${params.get('show-acts')}"]`)?.classList.add('show-acts')
  }

  // ---------- waiting on the owner ----------
  function waitingThread() {
    return `<div class="event" role="note">${icon('fold')}<div><p>Turns 1–9 were summarized to fit gpt-6.1-sol’s window. The summary replaces them for the model; you can still read them here.</p>
        <details><summary>Show the summary</summary><pre>Compared where capture uploads live (originals, phone-sized copies), what the backups hold, and how much the originals take today (41 GB over 7 months).</pre></details></div></div>
      <div class="msg you"><div class="head"><span class="who">You</span><span>2:30 PM</span></div><div class="bubble">So what would you pick for the originals?</div></div>
      <div class="msg model show-acts"><div class="head"><span class="model" title="Turn 10 · In 31.5K (28.0K from cache) · out 820">gpt-6.1-sol</span><span>Turn 10 · 2:37 PM</span>
        <span class="acts"><button class="lantern-btn ghost" data-branch="10">${icon('branch', 14)}Branch from here</button><button class="lantern-btn ghost" data-copy="turn 10">${icon('copy', 14)}Copy</button></span></div>
        <div class="tools">${toolHtml({ kind: 'bash', line: 'Ran du -sh /srv/aico/captures/originals', note: '41G', body: '41G\t/srv/aico/captures/originals' })}</div>
        <div class="text">The phone-sized copies are what notes show, and they’re small. The originals are the space problem: about 6 GB a month. Either keeps a year of copies under 50 GB if the originals go after a while.</div></div>
      <div class="needs-card" role="group" aria-label="Question from this chat">
        <h3>It’s waiting for your answer</h3>
        <p>Keep original photos 30 or 90 days after they’re attached to a note? I’d pick 90: a month is short if you notice a bad copy late.</p>
        <div class="opts"><button class="lantern-btn" data-answer="30 days">30 days</button><button class="lantern-btn primary" data-answer="90 days">90 days (recommended)</button><span class="muted" style="align-self:center;font-size:12.5px">or reply below</span></div></div>`
  }
  function waitingView(main) {
    main.innerHTML = `<div class="chat"><header class="chat-head"><span class="crumb">Chats /</span><h1>Which retention for capture uploads?</h1>${chip('needs', 'beckon')}
        <span class="facts">Research · aico · asked 2:37 PM</span><span class="grow"></span>
        <button class="lantern-btn primary" data-answer-focus>Answer</button>
        <button class="lantern-icon-btn" aria-label="Details: tokens, models, run" title="Details: tokens, models, run">${icon('info', 18)}</button></header>
      <div class="chat-body"><div class="thread">${waitingThread()}</div></div>
      ${composerHtml({ model: 'gpt-6.1-sol', placeholder: 'Answer, or say something else' })}</div>`
    wire(main)
    main.querySelector('[data-answer-focus]').addEventListener('click', () => main.querySelector('.composer textarea').focus())
    main.querySelectorAll('[data-answer]').forEach((b) => b.addEventListener('click', () => toast(`Sent “${b.dataset.answer}”. The chat goes on.`)))
  }

  // ---------- phone ----------
  function keyboardHtml(sugg) {
    const row = (keys) => `<div class="krow">${keys.map((k) => `<span class="k${k.length > 1 ? ' w' : ''}${k === ' ' ? ' space' : ''}">${k === ' ' ? '' : k}</span>`).join('')}</div>`
    return `<div class="keyboard" aria-hidden="true"><div class="sugg">${sugg.map((s) => `<span>${s}</span>`).join('')}</div>
      ${row('qwertyuiop'.split(''))}${row('asdfghjkl'.split(''))}${row(['⇧', ...'zxcvbnm'.split(''), '⌫'])}${row(['?123', ',', ' ', '.', '⏎'])}</div>`
  }
  function attachSheet() {
    const sheet = openSheet('bottom', 'Add to this message', `<div class="pick-list">
      <button data-pick>${icon('camera', 20)}Camera</button><button data-pick>${icon('image', 20)}Photos</button><button data-pick>${icon('file', 20)}Files<small>Any kind</small></button></div>
      <p class="muted" style="font-size:12.5px">They upload while you type and go with your next message. The model gets photos as images and text files as text.</p>`)
    sheet.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => { closeOverlay(); if (FRAME) location.search = '?frame=phone&screen=attached'; else toast('Added. It uploads while you type.') }))
  }
  const phoneScreens = {
    list() {
      return `<div class="phone"><div class="p-head"><span style="width:8px"></span><h1>Chats</h1><button class="lantern-icon-btn" aria-label="Search chats">${icon('search', 19)}</button><button class="lantern-icon-btn" aria-label="New chat" style="color:var(--lantern)">${icon('plus', 21)}</button></div>
        <div class="p-body" style="padding:0">${CHATS.map((c) => `<button class="prow${c.state === 'needs' ? ' needs' : ''}"><b>${esc(c.title)}</b><span class="t">${c.at.replace('Yesterday ', 'Yest. ')}</span>
          <span class="chipline">${chip(c.state, c.state === 'needs' ? 'beckon' : '')}<span>${roleName(c.role)} · ${c.model}</span></span><small>${esc(c.last)}</small></button>`).join('')}</div></div>`
    },
    chat() { return `<div class="phone">${chatHtml({ phone: true })}</div>` },
    kb() {
      return `<div class="phone"><div class="p-head"><button class="lantern-icon-btn" aria-label="Back to chats">${icon('back', 20)}</button><h1>Notes sync drops edits…</h1>${chip('working')}<span style="width:4px"></span></div>
        <div class="p-body"><div class="thread">${turnHtml({ ...TURNS[TURNS.length - 1], streaming: false, tools: TURNS[TURNS.length - 1].tools.slice(3) })}</div></div>
        <div class="composer"><div class="box"><button class="lantern-icon-btn" data-attach aria-label="Add photos or files">${icon('plus', 20)}</button>
          <textarea rows="1" aria-label="Message">Also run the whole notes pack</textarea><button class="send stop" aria-label="Stop this reply">${icon('stop', 16)}</button></div>
          <div class="bar"><span class="mono">glm-5.3</span><span>·</span><span>Sends after this reply</span></div></div>
        ${keyboardHtml(['pack', 'package', 'packages'])}</div>`
    },
    attach() {
      const html = phoneScreens.kb().replace(/<div class="keyboard"[\s\S]*$/, '</div>')
      setTimeout(attachSheet, 0)
      return html
    },
    attached() {
      return `<div class="phone"><div class="p-head"><button class="lantern-icon-btn" aria-label="Back to chats">${icon('back', 20)}</button><h1>Notes sync drops edits…</h1>${chip('idle')}<span style="width:4px"></span></div>
        <div class="p-body"><div class="thread">${turnHtml({ ...TURNS[TURNS.length - 1], streaming: false, tools: [] })}</div></div>
        ${composerHtml({ model: 'glm-5.3', phone: true, attach: true })}
        ${keyboardHtml(['log', 'logs', 'logged'])}</div>`
    },
    waiting() {
      return `<div class="phone"><div class="p-head"><button class="lantern-icon-btn" aria-label="Back to chats">${icon('back', 20)}</button><h1>Which retention for capture…</h1>${chip('needs', 'beckon')}<span style="width:4px"></span></div>
        <div class="p-body"><div class="thread">${waitingThread()}</div></div>
        ${composerHtml({ model: 'gpt-6.1-sol', phone: true, placeholder: 'Answer' })}</div>`
    },
  }
  function phoneFrame(el) {
    el.innerHTML = (phoneScreens[SCREEN] || phoneScreens.list)()
    wire(el)
    if (SCREEN === 'chat') stream(el.querySelector('.phone'), params.has('still'))
    el.querySelectorAll('.p-body').forEach((b) => { if (SCREEN !== 'list') b.scrollTop = 1e6 })
    el.querySelectorAll('[data-answer]').forEach((b) => b.addEventListener('click', () => toast(`Sent “${b.dataset.answer}”.`)))
  }

  // ---------- states ----------
  const miniHead = (title, s, facts, action) => `<header class="chat-head"><h1>${title}</h1>${chip(s)}<span class="facts">${facts}</span><span class="grow"></span>${action || ''}</header>`
  const STATES = [
    ['loading', 'Loading', 'Opening a chat. Unknown counts show as dashes, never 0.',
      `${miniHead('Notes sync drops edits made offline', 'loading', 'Implementation · aico')}<div class="thread" role="status" aria-label="Opening the chat"><p class="muted" style="margin:0">Opening the chat…</p><span class="skel" style="width:70%"></span><span class="skel" style="width:92%"></span><span class="skel" style="width:54%"></span><p class="muted" style="margin:0;font-size:12.5px">Tokens: — · Tool calls: —</p></div>`],
    ['empty', 'Empty', 'No chats yet: a real zero, with the one action that helps.',
      `<div class="empty"><h2>No chats yet</h2><p>Pick a role and a project folder, then say what you need.<br>Chats you start show up here and in your sessions.</p><button class="lantern-btn primary">${icon('plus')}New chat</button></div>`],
    ['failed', 'Failed: provider down', 'Every model in the role’s order failed on the same turn. The message is kept, nothing is lost.',
      `${miniHead('Why is the nightly check slow?', 'failed', 'Research · summitflow', '<button class="lantern-btn primary small">Try again</button>')}<div class="thread">
        <div class="msg you"><div class="head"><span class="who">You</span><span>Yesterday 9:10 PM</span></div><div class="bubble">Compare last week’s nightly check times with this week’s and tell me which step got slower.</div></div>
        <div class="notice bad" role="alert"><p><b>No model answered.</b> gpt-6.1-sol, deepseek-v4.1-flash and glm-5.3 each returned a provider error (503, 502, no reply in 5 min). Your message is kept; Try again sends it to gpt-6.1-sol first.</p></div></div>`],
    ['open-failed', 'Failed: couldn’t open', 'The Aico server didn’t answer. Not shown as an empty chat.',
      `<div class="empty" role="alert"><h2>Couldn’t open this chat</h2><p>The Aico server didn’t answer. The chat itself isn’t affected; it may still be running.</p><button class="lantern-btn primary">${icon('refresh')}Try again</button></div>`],
    ['partial', 'Partial: stopped mid-reply', 'Aico restarted while a reply was being written. What arrived is kept and marked unfinished.',
      `${miniHead('Notes sync, branch at turn 3', 'stopped', 'Implementation · aico', '<button class="lantern-btn primary small">Finish the reply</button>')}<div class="thread">
        <div class="notice"><p><b>This reply stopped at 11:05 AM</b> when Aico restarted, partway through turn 4. Finish the reply has deepseek-v4.1-flash pick it up where the chat left off.</p></div>
        <div class="msg model unfinished"><div class="head"><span class="model">deepseek-v4.1-flash</span><span>Turn 4 · unfinished</span></div>
          <div class="tools">${toolHtml({ kind: 'edit', line: 'Edited packages/notes/src/merge.ts', note: '+9 −4', body: '+ const fresh = newNote({ body: edit.body, from: server.id })' })}</div>
          <div class="text">The server copy stays as it is, and the phone’s text goes into a new note linked from the old one. I still need to</div></div></div>`],
    ['resumed', 'Resumed', 'After Finish the reply: one plain line says what happened, then the turn completes.',
      `${miniHead('Notes sync, branch at turn 3', 'working', 'Implementation · aico', '<button class="lantern-btn small">Stop</button>')}<div class="thread">
        <div class="event wide" role="note">${icon('resume')}<p>Resumed at 11:20 AM. deepseek-v4.1-flash, the model that answered last, is finishing the stopped turn. Its unfinished text stays above as it was.</p></div>
        <div class="msg model"><div class="head"><span class="model">deepseek-v4.1-flash</span><span>Turn 4 · 11:20 AM</span></div><div class="text">Picking up where I stopped: both notes are kept, the new one links back to the old one, and the link goes when the old note is deleted<span class="caret" aria-hidden="true"></span></div></div></div>`],
    ['disconnected', 'Disconnected', 'This page lost Aico. The chat may still be running; what arrived stays, marked as of when.',
      `${miniHead('Notes sync drops edits made offline', 'idle', 'Implementation · aico', '<button class="lantern-btn primary small">Reconnect</button>')}<div class="thread">
        <div class="notice"><p><b>Lost the connection at 2:44 PM.</b> The chat may still be running. Showing what arrived until then.</p></div>
        <p class="muted" style="margin:0">… turns 1–5 as before …</p></div>`],
    ['swap', 'Stopped: another model answered', 'The provider answered with a model the role didn’t pick, so nothing more ran on it.',
      `${miniHead('Review: backup restore drill script', 'stopped', 'Review · aico', '<button class="lantern-btn primary small">Try again</button>')}<div class="thread">
        <div class="notice"><p><b>Stopped at turn 3.</b> Asked for gpt-6.1-sol, but the provider answered with gpt-6.1-mini, so the chat stopped before anything ran on it. Try again asks gpt-6.1-sol again; you can also pick another model below.</p></div></div>`],
    ['rules', 'Can’t start: role rules unreadable', 'The harness fails closed: no model runs if the role’s rules can’t be read.',
      `<div class="empty" role="alert"><h2>This chat can’t start</h2><p>Aico couldn’t read the rules for the Implementation role, so no model runs. Your message is kept.<br><code>aico models route --role implementation</code> shows what’s wrong.</p><button class="lantern-btn primary">${icon('refresh')}Try again</button></div>`],
  ]
  function statesView(el) {
    el.innerHTML = `<div class="state-grid">${STATES.map(([id, t, cap, html]) => `<section class="state-card" id="state-${id}"><h3>${t}</h3><p class="cap">${cap}</p><div class="frame">${html}</div></section>`).join('')}</div>`
    wire(el)
  }

  // ---------- views ----------
  const built = {}
  const views = {
    list(el) { listPage(shell(el, null, '')); if (params.get('dialog') === 'new') newChat() },
    chat(el) { chatView(shell(el, 'c1', '')) },
    phone(el) {
      const f = (screen, title, cap) => `<figure><figcaption><b>${title}</b><br>${cap}</figcaption><div class="phone-frame"><iframe title="${esc(title)}" src="index.html?frame=phone&screen=${screen}${screen === 'chat' ? '&still=1' : ''}"></iframe></div></figure>`
      el.innerHTML = `<div class="gallery">
        ${f('list', 'Chats at 390px', 'Needs you first, then by last activity. State chip, role and model on one line; the last thing said under it.')}
        ${f('chat', 'A chat, replying', 'State, model and Stop sit in one line under the title. Tool calls are one line each; tap to open.')}
        ${f('kb', 'Keyboard open', 'The header gives way: back, a short title, the state. The newest reply stays in view above the message box. “Sends after this reply”.')}
        ${f('attach', 'Add photos or files', 'The + opens Aico’s capture choices: Camera, Photos, Files.')}
        ${f('attached', 'Attached, uploading', 'Each file shows its upload. Send waits until the photo is up, and says so.')}
        ${f('waiting', 'Waiting on you', 'The question card with its answers as buttons; the chip is the one thing that moves.')}
      </div>`
    },
    waiting(el) { waitingView(shell(el, 'c2', '')) },
    states(el) { statesView(el) },
  }

  function route() {
    if (FRAME) { const v = document.getElementById('v-frame'); v.classList.add('on'); phoneFrame(v); return }
    const name = location.hash.slice(1) || 'list'
    const key = views[name] ? name : 'list'
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === `v-${key}`))
    document.querySelectorAll('.mock-nav a').forEach((a) => (a.getAttribute('href') === `#${key}` ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')))
    closeOverlay()
    if (!built[key]) { built[key] = true; views[key](document.getElementById(`v-${key}`)) }
    window.scrollTo(0, 0)
  }
  window.addEventListener('hashchange', route)
  route()
})()

// Status mockup: renders every view from rows.js. The late/unknown rules,
// filters, sort and rollup follow packages/status/src/show.ts.
;(() => {
  const NOW = window.MOCK_NOW
  const params = new URLSearchParams(location.search)
  const FRAME = params.get('frame')
  const KB = params.get('kb') === '1'
  const SHEET = params.get('sheet')
  if (FRAME) document.body.classList.add('frame')
  if (KB) document.body.classList.add('kb')

  const SHOWN = ['failed', 'late', 'unknown', 'warn', 'ok', 'off']
  const PROBLEMS = ['failed', 'late', 'unknown', 'warn']
  const WORD = { failed: 'Failed', late: 'Late', unknown: 'Unknown', warn: 'Warning', ok: 'OK', off: 'Off', running: 'Running' }
  const ROLLWORD = { failed: 'failed', late: 'late', unknown: 'unknown', warn: 'warnings', ok: 'OK', off: 'off' }
  const KINDS = ['check', 'job', 'backup', 'service', 'vm', 'machine', 'link', 'grant', 'repo']
  const SORTS = [['problems', 'Problems first'], ['what', 'Name'], ['updated', 'Last report'], ['next', 'Next due']]
  const ACTION_ORDER = ['look', 'run', 'log', 'detail']
  const ACTION_LABEL = { look: 'Look into it', run: 'Run now', log: 'Log', detail: 'Detail', hosts: 'Hosts' }
  const label = (m) => window.MACHINE_LABEL[m] || m

  // ---- icons (lucide paths, as the app uses lucide-react) ----
  const P = {
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    filter: '<path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/>',
    run: '<polygon points="6 3 20 12 6 21 6 3"/>',
    log: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    detail: '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
    look: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    hosts: '<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    status: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
    notes: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
    back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    lantern: '<path d="M9 3h6"/><path d="M12 3v2"/><rect x="7" y="5" width="10" height="14" rx="3"/><path d="M12 10v4"/><path d="M9 21h6"/>',
  }
  const icon = (n, size = 16) => `<svg class="i" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${P[n]}</svg>`
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

  // ---- time: the web app shows 12-hour local times ----
  const TZ = 'America/New_York'
  const dayKey = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(ms)
  const clock = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(ms)
  const md = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric' }).format(ms)
  function fmt(ms) {
    if (ms == null || Number.isNaN(ms)) return '—'
    const d = dayKey(ms)
    if (d === dayKey(NOW)) return clock(ms)
    if (d === dayKey(NOW - 864e5)) return `yesterday ${clock(ms)}`
    if (d === dayKey(NOW + 864e5)) return `tomorrow ${clock(ms)}`
    return `${md(ms)}, ${clock(ms)}`
  }
  // Phone: weekday instead of "yesterday" keeps the label short.
  const wd = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(ms)
  function fmtShort(ms) {
    if (ms == null) return '—'
    if (dayKey(ms) === dayKey(NOW)) return clock(ms)
    return Math.abs(NOW - ms) < 6 * 864e5 ? `${wd(ms)} ${clock(ms)}` : md(ms)
  }
  const ago = (ms) => {
    const m = Math.round((NOW - ms) / 6e4)
    if (m < 60) return `${m} min ago`
    return m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.floor(m / 1440)} days ago`
  }

  // ---- the show.ts rules ----
  function lateSince(r, now) {
    if (r.state === 'off' || !r.next_run) return null
    const due = Date.parse(r.next_run)
    return now > due ? due : null
  }
  function show(rows, now) {
    const silent = new Map()
    for (const r of rows) {
      if (r.kind !== 'machine') continue
      const since = r.state === 'off' ? Date.parse(r.at) : lateSince(r, now)
      silent.set(r.machine, { since, why: r.state === 'off' ? 'off' : 'late' })
    }
    return rows.map((r) => {
      const base = { ...r, updated: Date.parse(r.at), last: r.last_run ? Date.parse(r.last_run) : null, next: r.next_run ? Date.parse(r.next_run) : null }
      if (r.kind !== 'machine') {
        const m = silent.get(r.machine)
        if (m === undefined) return { ...base, shown: 'unknown', since: null, why: 'none' }
        if (m.since !== null) return { ...base, shown: 'unknown', since: m.since, why: m.why }
      }
      const late = lateSince(r, now)
      if (late !== null) return { ...base, shown: 'late', since: late }
      return { ...base, shown: r.state, since: null }
    })
  }
  const rank = (r) => SHOWN.indexOf(r.shown)
  const byWhat = (a, b) => a.what.localeCompare(b.what) || a.id.localeCompare(b.id)
  const ORDER = {
    problems: (a, b) => rank(a) - rank(b) || byWhat(a, b),
    what: byWhat,
    updated: (a, b) => b.updated - a.updated || byWhat(a, b),
    next: (a, b) => (a.next ?? Infinity) - (b.next ?? Infinity) || byWhat(a, b),
  }
  function matches(r, f, skipState) {
    if (!skipState && f.states.size && !f.states.has(r.shown)) return false
    if (f.kind && r.kind !== f.kind) return false
    if (f.machine && r.machine !== f.machine) return false
    if (f.project && r.project !== f.project) return false
    const n = f.search.trim().toLowerCase()
    if (n && ![r.id, r.what, r.meaning, r.kind, r.machine, r.project ?? ''].some((x) => x.toLowerCase().includes(n))) return false
    return true
  }
  function rollup(rows) {
    const counts = Object.fromEntries(SHOWN.map((s) => [s, 0]))
    for (const r of rows) counts[r.shown] += 1
    const problems = PROBLEMS.reduce((n, s) => n + counts[s], 0)
    return { problems, healthy: rows.length - problems, counts }
  }
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
  function rollupLine(ru) {
    if (!ru.problems) return 'No problems'
    const parts = PROBLEMS.filter((s) => ru.counts[s]).map((s) => `${ru.counts[s]} ${ru.counts[s] === 1 && s === 'warn' ? 'warning' : ROLLWORD[s]}`)
    return `${plural(ru.problems, 'problem')}: ${parts.join(', ')}`
  }

  // ---- row pieces ----
  const chip = (s, extra = '') => `<span class="chip ${s}"${extra}>${WORD[s]}</span>`
  function reason(r) {
    if (r.shown === 'late') return 'Didn’t report when due.'
    if (r.shown !== 'unknown') return ''
    if (r.why === 'off') return `${r.machine} is off, so this can’t report.`
    if (r.why === 'late') return `${r.machine} stopped reporting.`
    return `Aico hasn’t heard from ${r.machine} itself.`
  }
  function meaningHtml(r) {
    const why = reason(r)
    return why ? `<span class="why">${esc(why)}</span> Last report: ${esc(r.meaning)}` : esc(r.meaning)
  }
  function whenHtml(r) {
    if (r.shown === 'late') return `<span class="late-t">Late since ${fmt(r.since)}</span><div class="sec">Last ran ${fmt(r.last)}</div>`
    if (r.shown === 'unknown') {
      const top = r.since ? `<b>Unknown since ${fmt(r.since)}</b>` : `<b>No word from ${esc(r.machine)}</b>`
      return `${top}<div class="sec">Last report ${fmt(r.updated)}</div>`
    }
    if (r.shown === 'off') return `Off since ${fmt(r.updated)}`
    const next = r.next ? `<div class="sec">Next ${fmt(r.next)}</div>` : ''
    return `Ran ${fmt(r.last ?? r.updated)}${next}`
  }
  function whenShort(r) {
    if (r.shown === 'late') return `<span class="late-t">since ${fmtShort(r.since)}</span>`
    if (r.shown === 'unknown') return r.since ? `since ${fmtShort(r.since)}` : 'no word'
    if (r.shown === 'off') return `since ${fmtShort(r.updated)}`
    return `ran ${fmtShort(r.last ?? r.updated)}`
  }
  function rowActions(r) {
    const acts = [...(r.actions || [])].sort((a, b) => ACTION_ORDER.indexOf(a.kind) - ACTION_ORDER.indexOf(b.kind))
    if (r.shown === 'unknown') acts.unshift({ kind: 'hosts', ref: r.machine })
    const primary =
      r.shown === 'unknown' ? 'hosts'
        : r.shown === 'late' ? (acts.find((a) => a.kind === 'run') ? 'run' : 'look')
          : r.shown === 'failed' || r.shown === 'warn' ? (acts.find((a) => a.kind === 'look') ? 'look' : acts[0]?.kind) : null
    return { acts, primary }
  }
  function actionButtons(r, big, skip = []) {
    const { acts, primary } = rowActions(r)
    return acts.filter((a) => !skip.includes(a.kind)).map((a) => {
      const off = a.kind === 'run' && r.shown === 'unknown'
      const cls = `lantern-btn ${big ? '' : 'small'} ${a.kind === primary ? 'primary' : big ? '' : 'ghost'}`
      const title = off ? `${r.machine} isn’t reporting, so it can’t run now` : a.kind === 'hosts' ? `Open ${label(r.machine)} in Hosts` : a.ref
      return `<button type="button" class="${cls}" data-act="${a.kind}" data-id="${esc(r.id)}" title="${esc(title)}" aria-label="${ACTION_LABEL[a.kind]}"${off ? ' disabled' : ''}>${icon(a.kind === 'hosts' ? 'hosts' : a.kind, 14)}<span class="lbl">${ACTION_LABEL[a.kind]}</span></button>`
    }).join('')
  }
  function rowHtml(r, st) {
    const healthy = !PROBLEMS.includes(r.shown)
    const running = st.running.has(r.id)
    const open = st.openId === r.id
    const refs = (r.actions || []).filter((a) => a.kind !== 'detail').map((a) => `<dt>${ACTION_LABEL[a.kind]}</dt><dd class="mono">${esc(a.ref)}</dd>`).join('')
    return `<div class="row${healthy ? ' healthy' : ''}${open ? ' open' : ''}" data-row="${esc(r.id)}" tabindex="0" aria-expanded="${open}">
      <div class="chipcell">${running ? chip('running') : chip(r.shown)}</div>
      <div class="main-cell"><div class="what">${esc(r.what)}</div><div class="meaning">${meaningHtml(r)}</div>
        <span class="meta-m">${esc(r.kind)} · ${esc(r.machine)}${r.project ? ` · ${esc(r.project)}` : ''}</span></div>
      <div class="where"><b>${esc(r.kind)}</b> · ${esc(label(r.machine))}${r.project ? `<br>${esc(r.project)}` : ''}</div>
      <div class="when"><span class="phone-only">${whenShort(r)}</span><span class="desk">${whenHtml(r)}</span></div>
      <div class="acts">${actionButtons(r)}</div>
      <div class="more"><dl>
        <dt>Row</dt><dd class="mono">${esc(r.id)}</dd>
        <dt>Last run</dt><dd>${fmt(r.last)}</dd>
        <dt>Next due</dt><dd>${r.next ? fmt(r.next) : 'No schedule'}</dd>
        <dt>Last report</dt><dd>${fmt(r.updated)} (${ago(r.updated)})</dd>
        ${refs}
      </dl></div>
    </div>`
  }

  // ---- the Status page (one component for the screen, the project page and the states) ----
  function newState(extra = {}) {
    return { states: new Set(), kind: '', machine: '', project: '', search: '', sort: 'problems', healthyOpen: false, openId: null, running: new Set(), ...extra }
  }
  function selectHtml(name, value, opts, allLabel, fixed) {
    return `<select class="select${value ? ' set' : ''}" data-f="${name}" aria-label="${allLabel}"${fixed ? ' disabled' : ''}>
      <option value="">${allLabel}</option>${opts.map(([v, l]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`
  }
  function statusPage(el, cfg) {
    const st = newState(cfg.state || {})
    const fixedProject = cfg.project || ''
    if (fixedProject) st.project = fixedProject
    const mode = cfg.mode || 'live'
    const all = show(cfg.rows || window.MOCK_ROWS, NOW)
    el._st = st

    function head(ru, total) {
      const machines = new Set(all.map((r) => r.machine)).size
      let sub
      if (mode === 'loading') sub = 'Loading…'
      else if (mode === 'failed') sub = 'Not loaded'
      else if (mode === 'empty') sub = 'No rows yet'
      else if (mode === 'stale') sub = `As of ${fmt(NOW - 14 * 6e4)} · couldn’t refresh`
      else sub = `${plural(total, 'row')} from ${plural(machines, 'machine')} · updated ${fmt(NOW)}`
      const title = fixedProject
        ? `<span class="crumb"><a href="#screen">Projects</a> /</span><h1>${esc(fixedProject)}</h1>`
        : '<h1>Status</h1>'
      const active = st.states.size + (st.kind ? 1 : 0) + (st.machine ? 1 : 0) + (st.project && !fixedProject ? 1 : 0)
      return `<div class="status-head">${title}<span class="sub">${sub}</span>
        <span class="tools phone-only"><button class="lantern-icon-btn" data-ui="search" aria-label="Search rows">${icon('search', 18)}</button>
        <button class="lantern-icon-btn" data-ui="filters" aria-label="Filters and sort">${icon('filter', 18)}${active ? `<span class="dot">${active}</span>` : ''}</button></span></div>
        ${fixedProject ? '<div class="tabs" role="tablist"><button role="tab" aria-selected="false">Sessions</button><button role="tab" aria-selected="true">Status</button><button role="tab" aria-selected="false">Mockups</button></div>' : ''}`
    }
    function rollupHtml(scope) {
      if (mode === 'loading' || mode === 'failed' || mode === 'empty') {
        const w = mode === 'empty' ? '0' : '—'
        return `<div class="rollup" aria-label="Rollup">${PROBLEMS.map((s) => `<span class="chip ${s} zero">${w} ${ROLLWORD[s]}</span>`).join('')}<span class="chip ok zero">${w} healthy</span></div>`
      }
      const ru = rollup(scope)
      return `<div class="rollup" role="group" aria-label="Filter by state">${PROBLEMS.map((s) =>
        `<button type="button" class="chip ${s}${ru.counts[s] ? '' : ' zero'}" data-state="${s}" aria-pressed="${st.states.has(s)}"><span class="n">${ru.counts[s]}</span> ${ru.counts[s] === 1 && s === 'warn' ? 'warning' : ROLLWORD[s]}</button>`).join('')}
        <button type="button" class="chip ok" data-state="ok" aria-pressed="${st.states.has('ok')}"><span class="n">${ru.counts.ok}</span> OK</button>
        <button type="button" class="chip off" data-state="off" aria-pressed="${st.states.has('off')}"><span class="n">${ru.counts.off}</span> off</button></div>`
    }
    function filtersHtml() {
      const machines = [...new Set(all.map((r) => r.machine))].sort().map((m) => [m, label(m)])
      const projects = [...new Set(all.map((r) => r.project).filter(Boolean))].sort().map((p) => [p, p])
      const any = st.states.size || st.kind || st.machine || (st.project && !fixedProject) || st.search
      return `<div class="filters">
        <label class="lantern-field">${icon('search', 15)}<input type="search" data-f="search" placeholder="Search rows" aria-label="Search rows" value="${esc(st.search)}"></label>
        ${selectHtml('kind', st.kind, KINDS.map((k) => [k, k]), 'All kinds')}
        ${selectHtml('machine', st.machine, machines, 'All machines')}
        ${fixedProject ? `<span class="fixed-filter">Project: <b>${esc(fixedProject)}</b></span>` : selectHtml('project', st.project, projects, 'All projects')}
        <label class="lbl">Sort <select class="select" data-f="sort" aria-label="Sort">${SORTS.map(([v, l]) => `<option value="${v}"${v === st.sort ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        ${any ? '<button type="button" class="lantern-btn ghost small" data-ui="clear">Clear filters</button>' : ''}
      </div>`
    }
    function noticeHtml() {
      if (mode === 'failed') return `<div class="notice bad" role="alert"><p><b>Couldn’t load status.</b> The Aico server didn’t answer at ${fmt(NOW)}. Nothing here counts as healthy until it does.</p><button class="lantern-btn small" data-ui="retry">${icon('refresh', 14)}Try again</button></div>`
      if (mode === 'partial') {
        const n = all.filter((r) => r.machine === 'davion-gem' && r.kind !== 'machine').length
        return `<div class="notice wait" role="status"><p><b>davion-gem isn’t answering.</b> No word since ${fmt(Date.parse('2026-11-03T19:58:00-05:00'))}, so its ${n} rows show unknown. The rest are current.</p><button class="lantern-btn small primary" data-act="hosts" data-id="davion-gem/machine">${icon('hosts', 14)}Hosts</button></div>`
      }
      if (mode === 'stale') return `<div class="notice wait" role="status"><p><b>Showing status from ${fmt(NOW - 14 * 6e4)}, 14 minutes ago.</b> Couldn’t refresh: no connection to Aico. States may have changed since.</p><button class="lantern-btn small" data-ui="retry">${icon('refresh', 14)}Refresh</button></div>`
      return ''
    }
    function bodyHtml(problems, healthy, scopeCount) {
      if (mode === 'loading') {
        const bar = (w) => `<div class="row"><div><span class="bar" style="display:block;width:60px;height:20px;border-radius:10px;background:var(--paper-veil)"></span></div><div><div class="bar" style="width:${w}%"></div><div class="bar" style="width:${w + 20}%;margin-top:8px;opacity:.6"></div></div><div class="when muted">—</div></div>`
        return `<p class="muted" style="margin:6px 2px 10px">Loading status…</p><div class="rows skeleton" aria-hidden="true">${bar(30)}${bar(45)}${bar(25)}</div>`
      }
      if (mode === 'failed') return '<div class="rows"><div class="empty-note"><h3>No rows to show</h3>The list comes back when the server answers. <code class="mono">aico status</code> on any machine reads the same rows.</div></div>'
      if (mode === 'empty') return '<div class="rows"><div class="empty-note"><h3>No rows yet</h3>Each check, job, backup and service adds its row the first time it reports.<br>Nothing has reported to this Aico so far.</div></div>'
      if (!problems.length && !healthy.length) {
        return `<div class="rows"><div class="empty-note"><h3>Nothing matches</h3>${plural(scopeCount, 'row')} hidden by these filters. <button class="lantern-btn ghost small" data-ui="clear">Clear filters</button></div></div>`
      }
      const showHealthy = st.healthyOpen || st.search.trim() || st.states.has('ok') || st.states.has('off') || !problems.length && st.states.size
      const ruH = rollup(healthy)
      let html = ''
      if (problems.length) {
        html += `<div class="group"><div class="lantern-sec">Problems <span class="n">${problems.length}</span></div><div class="rows">${problems.map((r) => rowHtml(r, st)).join('')}</div></div>`
      } else if (!st.states.size) {
        html += `<div class="group"><div class="rows"><div class="empty-note" style="padding:16px"><h3 style="margin:0">No problems</h3></div></div></div>`
      }
      if (healthy.length) {
        const fold = `<button type="button" class="healthy-fold" data-ui="fold" aria-expanded="${!!showHealthy}"><span><b>${healthy.length} healthy</b> <span class="muted">· ${[ruH.counts.ok && `${ruH.counts.ok} OK`, ruH.counts.off && `${ruH.counts.off} off`].filter(Boolean).join(', ')}</span></span>${icon('chevron', 16)}</button>`
        html += `<div class="group" style="margin-top:14px">${fold}${showHealthy ? `<div class="rows" style="margin-top:8px">${healthy.map((r) => rowHtml(r, st)).join('')}</div>` : ''}</div>`
      }
      return html
    }

    function render() {
      const scope = all.filter((r) => matches(r, st, true))
      const shown = scope.filter((r) => matches(r, st, false)).sort(ORDER[st.sort])
      const problems = shown.filter((r) => PROBLEMS.includes(r.shown))
      const healthy = shown.filter((r) => !PROBLEMS.includes(r.shown))
      const kbHead = cfg.kb
        ? `<div class="kb-head"><label class="lantern-field">${icon('search', 16)}<input type="search" data-f="search" aria-label="Search rows" value="${esc(st.search)}" autofocus></label><button class="lantern-btn ghost" data-ui="cancel-search">Cancel</button></div>
           <div class="kb-meta">${plural(shown.length, 'match', 'matches')} · ${problems.length ? plural(problems.length, 'problem') : 'no problems'}</div>`
        : ''
      el.innerHTML = cfg.kb
        ? `${kbHead}<div class="status-wrap"><div class="status" style="padding-top:8px">${bodyHtml(problems, healthy, scope.length)}</div></div>`
        : `<div class="status">${head(rollup(all), all.length)}${rollupHtml(scope)}${noticeHtml()}${filtersHtml()}${bodyHtml(problems, healthy, scope.length)}</div>`
      if (cfg.kb) {
        const input = el.querySelector('input[data-f="search"]')
        input?.focus()
        input?.setSelectionRange(input.value.length, input.value.length)
      }
    }
    el._render = render

    el.addEventListener('click', (e) => {
      const t = e.target.closest('[data-state],[data-ui],[data-act],[data-row]')
      if (!t || !el.contains(t)) return
      if (t.dataset.state) {
        const s = t.dataset.state
        st.states.has(s) ? st.states.delete(s) : st.states.add(s)
        return render()
      }
      if (t.dataset.ui === 'fold') { st.healthyOpen = !st.healthyOpen; return render() }
      if (t.dataset.ui === 'clear') { Object.assign(st, { states: new Set(), kind: '', machine: '', project: fixedProject, search: '' }); return render() }
      if (t.dataset.ui === 'retry') return toast('Trying again…')
      if (t.dataset.ui === 'search') { location.search = '?frame=phone&kb=1'; return }
      if (t.dataset.ui === 'cancel-search') { location.search = '?frame=phone'; return }
      if (t.dataset.ui === 'filters') return filterSheet(st, all, fixedProject, render)
      if (t.dataset.act) return doAction(t.dataset.act, all.find((r) => r.id === t.dataset.id), st, render)
      if (t.dataset.row) {
        const r = all.find((x) => x.id === t.dataset.row)
        if (isPhone()) return rowSheet(r, st, render)
        st.openId = st.openId === r.id ? null : r.id
        return render()
      }
    })
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.dataset?.row) e.target.click()
    })
    el.addEventListener('input', (e) => {
      const f = e.target.dataset?.f
      if (f === 'search') {
        st.search = e.target.value
        const pos = e.target.selectionStart
        render()
        const input = el.querySelector('input[data-f="search"]')
        input.focus()
        input.setSelectionRange(pos, pos)
      }
    })
    el.addEventListener('change', (e) => {
      const f = e.target.dataset?.f
      if (f && f !== 'search') { st[f] = e.target.value; render() }
    })
    render()
    return { st, render, all }
  }

  const isPhone = () => window.matchMedia('(max-width: 767px)').matches

  // ---- overlays ----
  const overlay = document.getElementById('overlay')
  function closeOverlay() { overlay.innerHTML = '' }
  function openSheet(kind, title, body, foot = '') {
    overlay.innerHTML = `<div class="scrim" data-close></div><div class="sheet ${kind}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      ${kind === 'bottom' ? '<div class="grab" aria-hidden="true"></div>' : ''}
      <header><h2>${title}</h2><button class="lantern-icon-btn" data-close aria-label="Close">${icon('x', 18)}</button></header>
      <div class="body">${body}</div>${foot ? `<div class="foot">${foot}</div>` : ''}</div>`
    overlay.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeOverlay))
    return overlay.querySelector('.sheet')
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOverlay() })
  let toastTimer
  function toast(text) {
    document.querySelector('.toast')?.remove()
    const d = document.createElement('div')
    d.className = 'toast'
    d.setAttribute('role', 'status')
    d.textContent = text
    document.body.append(d)
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => d.remove(), 2600)
  }

  function rowSheet(r, st, render) {
    const sheet = openSheet('bottom', esc(r.what), `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">${chip(r.shown)}<span class="muted" style="font-size:12.5px">${esc(r.kind)} · ${esc(label(r.machine))}${r.project ? ` · ${esc(r.project)}` : ''}</span></div>
      <p style="margin:0 0 10px">${meaningHtml(r)}</p>
      <div class="muted" style="font-size:12.5px;margin-bottom:14px">${whenHtml(r).replace(/<div class="sec">/g, '<div>')}</div>
      <div style="display:grid;gap:8px" class="sheet-acts">${actionButtons(r, true)}</div>`)
    sheet.querySelector('.sheet-acts').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]')
      if (b) doAction(b.dataset.act, r, st, render)
    })
  }
  function filterSheet(st, all, fixedProject, render) {
    const machines = [...new Set(all.map((r) => r.machine))].sort().map((m) => [m, label(m)])
    const projects = [...new Set(all.map((r) => r.project).filter(Boolean))].sort().map((p) => [p, p])
    const field = (lbl, html) => `<label style="display:grid;gap:4px;margin-bottom:10px"><span class="muted" style="font-size:12px">${lbl}</span>${html}</label>`
    const sheet = openSheet('bottom', 'Filters', `
      ${field('Kind', selectHtml('kind', st.kind, KINDS.map((k) => [k, k]), 'All kinds'))}
      ${field('Machine', selectHtml('machine', st.machine, machines, 'All machines'))}
      ${fixedProject ? '' : field('Project', selectHtml('project', st.project, projects, 'All projects'))}
      ${field('Sort', `<select class="select" data-f="sort">${SORTS.map(([v, l]) => `<option value="${v}"${v === st.sort ? ' selected' : ''}>${l}</option>`).join('')}</select>`)}`,
    '<button class="lantern-btn ghost" data-fclear>Clear</button><button class="lantern-btn primary" data-close>Show rows</button>')
    sheet.querySelectorAll('select').forEach((s) => s.addEventListener('change', () => { st[s.dataset.f] = s.value; render() }))
    sheet.querySelector('[data-fclear]').addEventListener('click', () => { Object.assign(st, { kind: '', machine: '', project: fixedProject, sort: 'problems' }); render(); closeOverlay() })
    sheet.querySelectorAll('select').forEach((s) => { s.style.width = '100%'; s.style.height = '44px' })
  }

  const LOGS = {
    'aico/aico-db-drive': `Nov 03 02:10:01 aico systemd[812]: Starting aico-backup-drive.service - Aico database to Drive...
Nov 03 02:10:02 aico aico-backup[20431]: snapshot aico.db: 418 MB, data up to 02:10
Nov 03 02:10:09 aico aico-backup[20431]: upload to drive:aico-backups/2026-11-03
Nov 03 02:11:03 aico rclone[20440]: Failed to create file system: couldn't fetch token: invalid_grant: maybe token expired? - try refreshing with "rclone config reconnect drive:"
Nov 03 02:11:04 aico aico-backup[20431]: failed: Drive login expired; newest Drive copy holds data from 2026-11-01 02:10
Nov 03 02:11:04 aico systemd[812]: aico-backup-drive.service: Main process exited, status=1/FAILURE
Nov 03 02:11:04 aico systemd[812]: aico-backup-drive.service: Failed with result 'exit-code'.`,
    'davion-sidarli/listeners': `20:15:00 listeners: 23 listening sockets, 22 allowed
20:15:00 listeners: NEW 0.0.0.0:8890 tcp python3 pid 41822 user kasadis cwd /srv/scratch/tmp-serve
20:15:00 listeners: not in allowed list (data/listeners.allow), state failed`,
  }

  function doAction(kind, r, st, render) {
    if (!r) return
    if (kind === 'run') {
      st.running.add(r.id)
      render()
      toast(`Started “${r.what}”. The row updates when it reports.`)
      setTimeout(() => { st.running.delete(r.id); render() }, 2200)
      return
    }
    if (kind === 'hosts') return toast(`Opens Hosts at ${label(r.machine)}, where you can start it.`)
    if (kind === 'detail') { closeOverlay(); location.hash = '#restore'; return }
    const ref = (r.actions || []).find((a) => a.kind === kind)?.ref ?? ''
    if (kind === 'log') {
      const lines = LOGS[r.id] || `${fmt(r.updated)}  ${r.what}: ${r.state}\n${fmt(r.updated)}  ${r.meaning}`
      openSheet(isPhone() ? 'bottom' : 'side', `Log · ${esc(r.what)}`,
        `<p class="muted" style="font-size:12.5px;margin:0 0 8px">Last lines on ${esc(label(r.machine))}, from <span class="mono">${esc(ref)}</span></p><pre>${esc(lines)}</pre>`,
        `<button class="lantern-btn ghost small" data-copy>${icon('copy', 14)}Copy command</button>`)
      return
    }
    if (kind === 'look') {
      const msg = `Status row ${r.id} is ${r.shown}: ${r.meaning} Find out why and fix it.`
      const sheet = openSheet(isPhone() ? 'bottom' : 'center', 'Look into it',
        `<p style="margin:0 0 10px;font-size:13px">Starts a session on <b>${esc(label(r.machine))}</b> in <span class="mono">${esc(ref)}</span>, with this as its first message:</p>
         <textarea aria-label="First message">${esc(msg)}</textarea>
         <p class="muted" style="font-size:12px;margin:8px 0 0">The session links back to this row. You can change the message first.</p>`,
        '<button class="lantern-btn ghost" data-close>Cancel</button><button class="lantern-btn primary" data-start>Start session</button>')
      sheet.querySelector('[data-start]').addEventListener('click', () => { closeOverlay(); toast('Session started: it’s in your session list.') })
    }
  }

  // ---- app chrome ----
  function sidebar(problems, worst) {
    return `<aside class="sidebar" aria-label="Sessions">
      <h2>Sessions · 1</h2>
      <nav class="side-nav" aria-label="Aico">
        <button>${icon('inbox', 15)}Needs you</button><button>${icon('camera', 15)}Capture</button><button>${icon('notes', 15)}Notes</button>
        <button aria-current="page">${icon('status', 15)}Status${problems ? `<span class="count ${worst}">${problems}</span>` : ''}</button>
        <button>${icon('hosts', 15)}Hosts</button>
      </nav>
      <div class="session-row"><span style="color:var(--lantern)">✻</span><b>Aico</b><span class="muted" style="font-size:12px">&lt;1m</span><small>Claude Code · working</small></div>
    </aside>`
  }
  function shell(viewEl, mainHtml) {
    const ru = rollup(show(window.MOCK_ROWS, NOW))
    const worst = PROBLEMS.find((s) => ru.counts[s]) || ''
    viewEl.innerHTML = `<div class="shell">${sidebar(ru.problems, worst === 'failed' ? 'failed' : '')}<main class="main">${mainHtml}</main></div>`
    return viewEl.querySelector('main')
  }

  // ---- views ----
  const built = {}
  const views = {
    screen(el) {
      const main = FRAME ? el : shell(el, '')
      const page = document.createElement('div')
      main.append(page)
      statusPage(page, { kb: KB, state: KB ? { search: 'drive' } : {} })
      if (KB) el.insertAdjacentHTML('beforeend', keyboardHtml())
      if (SHEET) {
        const r = show(window.MOCK_ROWS, NOW).find((x) => x.id === SHEET)
        rowSheet(r, page._st, page._render)
      }
    },
    project(el) {
      const main = shell(el, '')
      const page = document.createElement('div')
      main.append(page)
      statusPage(page, { project: 'aico' })
    },
    phone(el) {
      const f = (q, title, cap) => `<figure><figcaption><b>${title}</b><br>${cap}</figcaption><div class="phone-frame"><iframe title="${esc(title)}" src="index.html?${q}#screen"></iframe></div></figure>`
      el.innerHTML = `<div class="gallery">
        ${f('frame=phone', 'Status at 390px', 'Problems first; healthy rows fold into one line. The state chips filter; search and the other filters sit behind the two icons.')}
        ${f('frame=phone&kb=1', 'Search with the keyboard open', 'The header gives way to the search field. Matches show with a short count; healthy matches unfold.')}
        ${f('frame=phone&sheet=aico%2Faico-db-drive', 'A row, tapped', 'Tapping a row opens its sheet: the state, what it means, and the actions as full-width buttons.')}
      </div>`
    },
    tray(el) {
      const rows = show(window.MOCK_ROWS, NOW)
      const ru = rollup(rows)
      const failed = rows.filter((r) => r.shown === 'failed').sort(byWhat)
      const top = rows.filter((r) => PROBLEMS.includes(r.shown)).sort(ORDER.problems).slice(0, 3)
      const rest = PROBLEMS.filter((s) => s !== 'failed' && ru.counts[s]).map((s) => `${ru.counts[s]} ${ROLLWORD[s]}`).join(', ')
      el.innerHTML = `<div class="panels">
        <section class="panel"><h3>Tray badge</h3><p class="cap">The badge counts problems and takes the colour of the worst one. Opening it lists the top three and the rollup.</p>
          <div class="topbar"><span>Activities</span><span class="clock">Tue Nov 3 ${clock(NOW)}</span>
            <span class="tray"><span class="tray-aico" aria-label="Aico status: ${ru.problems} problems">${icon('lantern', 15)}<span class="badge">${ru.problems}</span></span><span>🔊</span><span>⏻</span></span></div>
          <div class="tray-menu">
            <div class="hd"><b>${rollupLine(ru)}</b><span class="muted" style="font-size:12px">${ru.healthy} healthy · updated ${clock(NOW)}</span></div><hr>
            ${top.map((r) => `<div class="item"><span class="chip ${r.shown}" style="height:18px;font-size:10.5px;margin-right:6px">${WORD[r.shown]}</span>${esc(r.what)}<small>${esc(r.shown === 'late' ? `Late since ${fmt(r.since)}` : r.shown === 'unknown' ? reason(r) : r.meaning)}</small></div>`).join('')}
            <hr><div class="item"><b>Open Status</b><small>${ru.problems - top.length} more problems</small></div>
          </div>
        </section>
        <section class="panel"><h3>Phone alert</h3><p class="cap">The app push leads with what failed, then the rest of the rollup. One alert per change, not per row.</p>
          <div class="notif"><div class="app"><i></i>Aico · Status · now</div>
            <b>${failed.length} failed: ${failed.map((r) => esc(r.what)).join(', ')}</b>
            <div>${esc(failed[0].meaning)}</div>
            <div class="muted" style="margin-top:4px">Also ${rest}. ${ru.healthy} healthy.</div>
            <div class="acts"><span>Open Status</span><span>Look into it</span></div></div>
          <p class="cap" style="margin:14px 0 6px">With nothing failed, the alert names the worst state instead:</p>
          <div class="notif"><div class="app"><i></i>Aico · Status · 9:40 PM</div><b>2 late: ECC memory errors, Nightly GitHub publication</b><div>ECC memory errors: late since 2:30 PM.</div></div>
        </section>
        <section class="panel"><h3>Same rows in the CLI</h3><p class="cap"><span class="mono">aico status</span> and <span class="mono">st status</span> print the same rollup first.</p>
<pre class="cli">${esc(`${rollupLine(ru)}.
${ru.healthy} healthy (${ru.counts.ok} OK, ${ru.counts.off} off).

FAILED   Aico database to Drive
         (backup, aico, aico)
         Upload refused: the Drive login
         expired. The newest copy on Drive
         holds data from Nov 1, 2:10 AM.
         Last run today 02:10.
         Next due tomorrow 02:40.
...`)}</pre></section>
      </div>`
    },
    states(el) {
      const partialRows = window.MOCK_ROWS.map((r) => r.id === 'davion-gem/machine'
        ? { ...r, last_run: '2026-11-03T19:48:00-05:00', next_run: '2026-11-03T19:58:00-05:00', at: '2026-11-03T19:48:00-05:00' } : r)
      const cards = [
        ['loading', 'Loading', 'First load. No counts until rows arrive; the chips show a dash, never 0.'],
        ['empty', 'Empty', 'The server answered with no rows: a fresh install. Zero is real here.'],
        ['failed', 'Failed (API down)', 'The server didn’t answer. Counts show a dash and nothing reads as healthy.'],
        ['partial', 'Partial (one machine not answering)', 'davion-gem’s machine row went late, so its rows show unknown since then.'],
        ['stale', 'Stale', 'The page lost its connection; it keeps the last rows and says how old they are.'],
      ]
      el.innerHTML = `<div class="state-grid">${cards.map(([m, t, c]) => `<div class="state-card"><h3>${t}</h3><p class="cap">${c}</p><div class="frame" id="state-${m}"></div></div>`).join('')}</div>`
      for (const [m] of cards) {
        statusPage(el.querySelector(`#state-${m}`), { mode: m, rows: m === 'partial' ? partialRows : m === 'empty' ? [] : undefined })
      }
    },
    restore(el) {
      const r = show(window.MOCK_ROWS, NOW).find((x) => x.id === 'aico/aico-db-drive')
      const copies = [
        ['CT 160 · hourly, append-only', '2026-11-03T20:00:00-05:00', '2026-11-03T20:01:00-05:00', '418 MB', 'Checked hourly'],
        ['CT 160 · hourly, append-only', '2026-11-03T19:00:00-05:00', '2026-11-03T19:01:00-05:00', '418 MB', ''],
        ['Drive · daily', '2026-11-01T02:10:00-05:00', '2026-11-01T02:11:00-05:00', '411 MB', 'Restore test passed Nov 1'],
        ['Drive · daily', '2026-10-31T02:10:00-04:00', '2026-10-31T02:12:00-04:00', '409 MB', ''],
      ]
      const ms = (s) => Date.parse(s)
      const main = shell(el, `<div class="detail">
        <a class="back" href="#screen">${icon('back', 15)}Status</a>
        <div class="detail-head">${chip(r.shown)}<h1>${esc(r.what)}</h1><span class="muted" style="font-size:12.5px">backup · ${esc(label(r.machine))} · aico</span></div>
        <p class="lead">${esc(r.meaning)}</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">${actionButtons(r, true, ['detail'])}</div>
        <section><h2>Copies</h2><p>Newest data is safe on CT 160 (8:00 PM today). Drive’s newest copy is 2 days old. Ages are the age of the data inside each copy, not of the upload.</p>
          <table class="copies"><thead><tr><th>Where</th><th>Data from</th><th>Age</th><th class="hide-m">Uploaded</th><th class="hide-m">Size</th><th class="hide-m">Checks</th></tr></thead><tbody>
          ${copies.map(([w, d, u, s, c]) => `<tr><td>${w}</td><td>${fmt(ms(d))}</td><td class="${NOW - ms(d) > 864e5 * 1.5 ? 'age-bad' : ''}">${ago(ms(d)).replace(' ago', '')}</td><td class="hide-m">${fmt(ms(u))}</td><td class="hide-m">${s}</td><td class="hide-m muted">${c || '—'}</td></tr>`).join('')}
          </tbody></table></section>
        <section><h2>Restore</h2><p>Pick a copy and where it goes. Restoring to a folder never touches the live database.</p>
          <div class="two"><div>
            <label class="choice"><input type="radio" name="copy" checked><span>CT 160 · 8:00 PM today<small>Newest data</small></span></label>
            <label class="choice"><input type="radio" name="copy"><span>Drive · Nov 1, 2:10 AM<small>Newest on Drive; restore test passed</small></span></label>
          </div><div>
            <label class="choice"><input type="radio" name="to" checked><span>To a new folder<small class="mono">~/restore/aico-db-20261103</small></span></label>
            <label class="choice danger"><input type="radio" name="to"><span>Over the live database on aico<small>Stops the Aico web server on aico while it runs. Asks again before it starts.</small></span></label>
          </div></div>
          <pre class="cli" style="margin:10px 0">aico backup restore aico-db --copy ct160:2026-11-03T20:00 --to ~/restore/aico-db-20261103</pre>
          <button class="lantern-btn primary">Restore to folder</button>
        </section>
        <section><h2>Last restore test</h2><p>Nov 1, 2:40 AM: the Drive copy restored to a folder and opened. 1,284 notes and 57 captures. Next test after the next good Drive copy.</p></section>
      </div>`)
      main.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act]')
        if (b) doAction(b.dataset.act, r, { running: new Set() }, () => {})
      })
    },
  }

  function keyboardHtml() {
    const row = (keys) => `<div class="krow">${keys.map((k) => `<span class="k${k.length > 1 ? ' w' : ''}${k === ' ' ? ' space' : ''}">${k === ' ' ? '' : k}</span>`).join('')}</div>`
    return `<div class="keyboard" aria-hidden="true"><div class="sugg"><span>drive</span><span>drives</span><span>driver</span></div>
      ${row('qwertyuiop'.split(''))}${row('asdfghjkl'.split(''))}${row(['⇧', ...'zxcvbnm'.split(''), '⌫'])}${row(['?123', ',', ' ', '.', 'Go'])}</div>`
  }

  function route() {
    const name = FRAME ? 'screen' : (location.hash.slice(1) || 'screen')
    const key = views[name] ? name : 'screen'
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === `v-${key}`))
    document.querySelectorAll('.mock-nav a').forEach((a) => a.toggleAttribute('aria-current', a.getAttribute('href') === `#${key}`))
    document.querySelectorAll('.mock-nav a').forEach((a) => a.getAttribute('href') === `#${key}` ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'))
    closeOverlay()
    if (!built[key]) { built[key] = true; views[key](document.getElementById(`v-${key}`)) }
    window.scrollTo(0, 0)
  }
  window.addEventListener('hashchange', route)
  route()
})()

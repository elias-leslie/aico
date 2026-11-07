#!/usr/bin/env node
// Aico UI latency bench: times every owner-facing action in the live web app.
//
//   node scripts/perf-bench.cjs [--url http://127.0.0.1:3002] [--phone] [--only a,b] [--runs 3] [--out DIR]
//
// "ms" is when the action's work was visibly finished: the last DOM change or
// network response, followed by a quiet window (--quiet, default 400 ms, which
// is subtracted). Hard loads count from navigation start. --phone runs 390x844
// with 4x CPU throttle. It creates and ends its own shell session; it never
// reads note contents. Needs playwright-core and a chromium (see CHROME/PW).
const fs = require('node:fs')
const path = require('node:path')

const PW =
  process.env.PW ||
  '/home/kasadis/.local/lib/node_modules/@playwright/cli/node_modules/playwright-core'
const CHROME =
  process.env.CHROME ||
  '/home/kasadis/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome'
const { chromium } = require(PW)

const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : dflt
}
const URL_BASE = opt('url', 'http://127.0.0.1:3002')
const PHONE = args.includes('--phone')
// --net: add WAN-like latency (ms) and 20 Mbps, e.g. --net 50
const NET = Number(opt('net', 0))
const RUNS = Number(opt('runs', 3))
const QUIET = Number(opt('quiet', 400))
const ONLY = opt('only', '')
  ?.split(',')
  .filter(Boolean)
const OUT = opt('out', path.join(__dirname, '..', 'evidence', 'perf'))
fs.mkdirSync(OUT, { recursive: true })

const PAGES = [
  ['status', '/status'],
  ['projects', '/projects'],
  ['today', '/today'],
  ['recent', '/history'],
  ['quota', '/quota'],
  ['backups', '/backups'],
  ['grants', '/grants'],
  ['logins', '/logins'],
  ['machines', '/machines'],
  ['recovery', '/recovery'],
  ['notes', '/notes'],
  ['context', '/agents'],
  ['phone-app', '/app'],
]

// Injected into every page before its scripts run.
const INIT = `(() => {
  const m = (window.__m = { t0: 0, lastMut: 0, lastNet: 0, pending: 0, fetches: [], long: [], ws: {} })
  const now = () => performance.now()
  new MutationObserver(() => { m.lastMut = now() }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
  const f = window.fetch
  window.fetch = function (input, init) {
    const url = String((input && input.url) || input)
    const rec = { url: url.replace(location.origin, ''), s: now() - m.t0, e: null }
    m.pending++; m.fetches.push(rec)
    return f.apply(this, arguments).finally(() => { m.pending--; rec.e = now() - m.t0; m.lastNet = now() })
  }
  const WS = window.WebSocket
  window.WebSocket = function (u, p) {
    const w = p ? new WS(u, p) : new WS(u)
    const s = now(); m.ws = { url: u, s: s - m.t0 }
    w.addEventListener('open', () => { m.ws.open = now() - m.t0 })
    w.addEventListener('message', () => { if (m.ws.first == null) m.ws.first = now() - m.t0 })
    return w
  }
  window.WebSocket.prototype = WS.prototype
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) m.long.push(Math.round(e.duration)) }).observe({ type: 'longtask', buffered: true }) } catch {}
  m.start = () => { m.t0 = now(); m.lastMut = m.t0; m.lastNet = m.t0; m.fetches = []; m.long = []; m.ws = {} }
  m.settle = (quiet, needFetch) => new Promise((res) => {
    const tick = () => {
      const t = now()
      if ((m.fetches.length > 0 || !needFetch) && m.pending === 0 && t - m.lastMut >= quiet && t - m.lastNet >= quiet) {
        res({ ms: Math.round(Math.max(m.lastMut, m.lastNet) - m.t0), fetches: m.fetches.length, list: m.fetches.filter((x) => x.url.startsWith('/api/')).map((x) => x.url.split('?')[0] + '@' + Math.round(x.s) + '-' + (x.e == null ? '?' : Math.round(x.e))), long: m.long.reduce((a, b) => a + b, 0), ws: m.ws,
          paint: (performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime })
      } else if (t - m.t0 > 20000) res({ ms: -1, fetches: m.fetches.length, pending: m.fetches.filter((x) => x.e == null).map((x) => x.url) })
      else setTimeout(tick, 40)
    }
    tick()
  })
})()`

const results = []
const VERBOSE = args.includes('--verbose')
let lastList = []
const record = (name, ms, extra = {}) => {
  results.push({ name, ms, ...extra })
  if (VERBOSE && lastList.length) console.log('      ' + lastList.join(' '))
  const x = Object.entries(extra)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ')
  console.log(`${String(ms).padStart(6)} ms  ${name}  ${x}`)
}
const want = (name) => !ONLY?.length || ONLY.some((o) => name.startsWith(o))

async function newCtx(browser) {
  const ctx = await browser.newContext({
    viewport: PHONE ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    hasTouch: PHONE,
    isMobile: PHONE,
  })
  await ctx.addInitScript(INIT)
  const page = await ctx.newPage()
  if (PHONE || NET) {
    const cdp = await ctx.newCDPSession(page)
    if (PHONE) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    if (NET) {
      await cdp.send('Network.enable')
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: NET, downloadThroughput: 2.5e6, uploadThroughput: 1.25e6 })
    }
  }
  return { ctx, page }
}

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]

async function hardLoad(page, url, name, tag) {
  await page.goto(url, { waitUntil: 'commit' })
  const r = await page.evaluate((q) => window.__m.settle(q, true), QUIET)
  lastList = r.list || []
  record(`${tag} ${name}`, Math.max(0, r.ms), { fcp: Math.round(r.paint || 0), fetches: r.fetches, long: r.long })
  return r.ms
}

async function openMenu(page) {
  if (!PHONE) return
  const vis = await page.locator('a[href="/projects"]').first().isVisible().catch(() => false)
  if (vis) return
  await page.locator('button[aria-label^="Sessions and everything else"]').first().click()
  await page.waitForTimeout(350)
}

async function clientNav(page, name, href) {
  await page.goto(`${URL_BASE}/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  await openMenu(page)
  const link = page.locator(`a[href="${href}"]`).first()
  await link.scrollIntoViewIfNeeded()
  await page.evaluate(() => window.__m.start())
  await link.click()
  const r = await page.evaluate((q) => window.__m.settle(q), QUIET)
  lastList = r.list || []
  record(`nav ${name}`, r.ms, { fetches: r.fetches, long: r.long, ...(r.pending ? { pending: r.pending } : {}) })
  return r.ms
}

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true })
  const tag = (PHONE ? 'phone' : 'desktop') + (NET ? `-net${NET}` : '')
  console.log(`# ${tag} ${URL_BASE} runs=${RUNS}`)

  // Cold (empty cache) and warm (cached assets) home and pages.
  if (want('hard')) {
    for (const [name, p] of [['home', '/'], ...PAGES]) {
      const cold = []
      const warm = []
      for (let i = 0; i < RUNS; i++) {
        const { ctx, page } = await newCtx(browser)
        cold.push(await hardLoad(page, URL_BASE + p, name, `hard-cold`))
        warm.push(await hardLoad(page, URL_BASE + p, name, `hard-warm`))
        await ctx.close()
      }
      console.log(`  -> ${name}: cold median ${median(cold)} warm median ${median(warm)}`)
    }
  }

  const { ctx, page } = await newCtx(browser)

  if (want('nav')) {
    for (const [name, p] of PAGES.filter((x) => x[0] !== 'notes')) {
      const v = []
      for (let i = 0; i < RUNS; i++) v.push(await clientNav(page, name, p))
      console.log(`  -> nav ${name}: median ${median(v)}`)
    }
    // Context tabs
    await page.goto(`${URL_BASE}/agents`, { waitUntil: 'networkidle' })
    for (const tab of ['Prompts', 'Roles', 'Memory', 'Cost']) {
      await page.evaluate(() => window.__m.start())
      await page.locator(`button:text-is("${tab}")`).first().click()
      const r = await page.evaluate((q) => window.__m.settle(q), QUIET)
  lastList = r.list || []
      record(`context tab ${tab}`, r.ms, { fetches: r.fetches })
    }
  }

  if (want('dialog')) {
    for (let i = 0; i < RUNS; i++) {
      await page.goto(`${URL_BASE}/`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(1500)
      await page.evaluate(() => window.__m.start())
      await page.locator('button:has-text("New session"):visible').first().click()
      await page.waitForSelector('[data-testid=new-session-dialog] [role=radio]')
      const r = await page.evaluate((q) => window.__m.settle(q), QUIET)
  lastList = r.list || []
      record('new session dialog', r.ms, { fetches: r.fetches })
    }
  }

  if (want('session')) {
    // Start a shell, open it, end it. Past session from Recent.
    for (let i = 0; i < RUNS; i++) {
      await page.goto(`${URL_BASE}/`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(1500)
      await page.locator('button:has-text("New session"):visible').first().click()
      await page.waitForSelector('[data-testid=new-session-dialog] [role=radio]')
      await page.locator('[data-testid=new-session-dialog] button:text-is("Shell")').click()
      await page.locator('[data-testid=new-session-dialog] [role=radio]:has-text("Aico")').first().click()
      await page.evaluate(() => window.__m.start())
      await page.locator('[data-testid=new-session-dialog] button.primary').click()
      await page.waitForFunction(() => /[?&]session=/.test(location.search), null, { timeout: 15000 })
      const tUrl = await page.evaluate(() => performance.now() - window.__m.t0)
      await page.locator('button[aria-label="Session menu"]').waitFor()
      const tHeader = await page.evaluate(() => performance.now() - window.__m.t0)
      await page.waitForFunction(() => window.__m.ws && window.__m.ws.first != null, null, { timeout: 15000 })
      const r = await page.evaluate((q) => window.__m.settle(q), QUIET)
  lastList = r.list || []
      record('start shell -> header', Math.round(tHeader), { url: Math.round(tUrl), fetches: r.fetches })
      record('start shell -> first terminal output', Math.round(r.ws.first), { wsOpen: Math.round(r.ws.open || 0), settled: r.ms })
      const sid = new URLSearchParams(await page.evaluate(() => location.search)).get('session')

      // reopen the live session (hard load): time to first terminal output
      await page.goto(`${URL_BASE}/?session=${sid}`, { waitUntil: 'commit' })
      await page.waitForFunction(() => window.__m.ws && window.__m.ws.first != null, null, { timeout: 15000 })
      const r2 = await page.evaluate((q) => window.__m.settle(q), QUIET)
      record('open live session (hard) -> first terminal output', Math.round(r2.ws.first), { settled: r2.ms, fetches: r2.fetches })

      // switch to it from the list (client nav)
      await page.goto(`${URL_BASE}/`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(1500)
      await openMenu(page).catch(() => {})
      const row = page.locator(`a[href*="session=${sid}"], button:has-text("Shell ·")`).first()
      await page.evaluate(() => window.__m.start())
      await row.click()
      await page.waitForFunction(() => /[?&]session=/.test(location.search), null, { timeout: 15000 })
      await page.locator('button[aria-label="Session menu"]').waitFor()
      const r3 = await page.evaluate((q) => window.__m.settle(q), QUIET)
      record('open live session (click in list) -> terminal settled', r3.ms, { ws: r3.ws.first ?? 'n/a' })

      // end it
      await page.locator('button[aria-label="Session menu"]').click()
      await page.locator('text=End session').first().click()
      await page.waitForTimeout(300)
      await page.evaluate(() => window.__m.start())
      await page.locator('[role=alertdialog] button:has-text("End session"), [role=dialog] button:has-text("End session")').last().click()
      await page.waitForFunction((id) => !location.search.includes(id), sid, { timeout: 15000 }).catch(() => {})
      const r4 = await page.evaluate((q) => window.__m.settle(q), QUIET)
      record('end session (confirm -> settled)', r4.ms, { fetches: r4.fetches })
    }

    for (let i = 0; i < RUNS; i++) {
      await page.goto(`${URL_BASE}/history`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(500)
      const link = page.locator('a[href^="/history?session="]:has-text("Finished")').nth(i)
      await page.evaluate(() => window.__m.start())
      await link.click()
      const r = await page.evaluate((q) => window.__m.settle(q), QUIET)
  lastList = r.list || []
      record('open past session from Recent', r.ms, { fetches: r.fetches, long: r.long })
    }
  }

  if (want('width')) {
    await page.goto(`${URL_BASE}/`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1500)
    for (const label of ['Wider', 'Wider', 'Narrower', 'Narrower']) {
      const b = page.locator(`button[aria-label="${label}"], button:has-text("${label}")`).first()
      if (!(await b.isVisible().catch(() => false))) continue
      await page.evaluate(() => window.__m.start())
      await b.click()
      const r = await page.evaluate((q) => window.__m.settle(q), QUIET)
  lastList = r.list || []
      record(`width ${label}`, r.ms)
    }
  }

  await ctx.close()
  await browser.close()
  fs.writeFileSync(path.join(OUT, `bench-${tag}.json`), JSON.stringify(results, null, 1))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

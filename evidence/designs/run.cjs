// Live check of the Designs tab with throwaway designs (card.html, logo.svg, flow.mmd, notes.md in /srv/scratch/designs-test).
const { chromium } = require('/home/kasadis/.local/lib/node_modules/@playwright/cli/node_modules/playwright-core')
const { execSync } = require('node:child_process')
const OUT = '/srv/workspaces/projects/aico/evidence/designs'
const BASE = 'http://127.0.0.1:3002'
const log = (...a) => console.log(...a)
;(async () => {
  const browser = await chromium.launch({ executablePath: '/home/kasadis/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome' })
  for (const [name, width, height] of [['wide', 1440, 900], ['narrow', 520, 900]]) {
    const ctx = await browser.newContext({ viewport: { width, height } })
    const page = await ctx.newPage()
    const problems = []
    page.on('pageerror', (e) => problems.push('PAGEERROR ' + e.message))
    page.on('console', (m) => { if (m.type() === 'error') problems.push('CONSOLE ' + m.text()) })
    page.on('requestfailed', (r) => problems.push('REQFAIL ' + r.url() + ' ' + r.failure()?.errorText))
    page.on('response', (r) => { if (r.status() >= 400) problems.push('HTTP ' + r.status() + ' ' + r.url()) })
    await page.goto(`${BASE}/workbench?tab=designs&project=aico`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1500)
    await page.screenshot({ path: `${OUT}/${name}-1-list.png` })
    const idx = { html: 'Throwaway card', svg: 'Throwaway logo', mermaid: 'Throwaway flow', md: 'Throwaway notes' }
    let n = 2
    for (const [kind, title] of Object.entries(idx)) {
      await page.getByRole('button', { name: new RegExp(title) }).click()
      await page.waitForTimeout(kind === 'html' || kind === 'svg' ? 1200 : 3500)
      await page.screenshot({ path: `${OUT}/${name}-${n++}-${kind}.png` })
      const frame = page.frames().find((f) => f.url().includes('/view?'))
      if (kind === 'html') {
        const probe = await frame.evaluate(async () => {
          const r = {}
          try { r.cookie = document.cookie } catch (e) { r.cookie = 'blocked: ' + e.name }
          try { r.parent = parent.document.title } catch (e) { r.parent = 'blocked: ' + e.name }
          try { r.api = (await fetch('/api/sessions')).status } catch (e) { r.api = 'blocked: ' + e.name }
          r.origin = location.origin
          return r
        })
        log(name, 'html sandbox probe', JSON.stringify(probe))
      }
      if (kind === 'mermaid' || kind === 'md') log(name, kind, 'svg drawn:', await frame.evaluate(() => document.querySelectorAll('svg').length), '| failed box:', await frame.evaluate(() => document.querySelectorAll('.failed').length), '| script tags in md body:', await frame.evaluate(() => document.querySelectorAll('article script').length))
    }
    log(name, 'sandbox attrs:', await page.evaluate(() => [...document.querySelectorAll('iframe')].map((f) => f.getAttribute('sandbox'))))
    log(name, 'problems:', JSON.stringify(problems, null, 1))
    if (name === 'wide') {
      // Re-add the HTML design with new content and watch the open view refresh on its own.
      await page.getByRole('button', { name: /Throwaway card/ }).click()
      await page.waitForTimeout(1200)
      const before = await page.frames().find((f) => f.url().includes('/view?')).evaluate(() => document.querySelector('h1').textContent)
      execSync("sed -i 's/v2 (re-added)/v3 (re-added again)/; s/Second version/Third version/' /srv/scratch/designs-test/card.html && st mockup add /srv/scratch/designs-test/card.html --project aico --title 'Throwaway card'", { stdio: 'inherit' })
      const t0 = Date.now()
      let after = before
      while (Date.now() - t0 < 15000 && after === before) {
        await page.waitForTimeout(500)
        after = await page.frames().find((f) => f.url().includes('/view?')).evaluate(() => document.querySelector('h1')?.textContent ?? '')
      }
      log('refresh:', JSON.stringify(before), '->', JSON.stringify(after), 'after', Date.now() - t0, 'ms; list count of Throwaway card rows:', await page.getByRole('button', { name: /Throwaway card/ }).count())
      await page.screenshot({ path: `${OUT}/wide-6-refreshed.png` })
    }
    // Files > Rendered
    const fp = new URLSearchParams({ tab: 'files', path: '/srv/scratch/designs-test/card.html' })
    await page.goto(`${BASE}/workbench?${fp}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(2500)
    await page.screenshot({ path: `${OUT}/${name}-7-files-source.png` })
    await page.getByRole('button', { name: 'Rendered' }).click()
    await page.waitForTimeout(1500)
    await page.screenshot({ path: `${OUT}/${name}-8-files-rendered.png` })
    log(name, 'files frame sandbox:', await page.evaluate(() => document.querySelector('iframe')?.getAttribute('sandbox')))
    await ctx.close()
  }
  await browser.close()
})().catch((e) => { console.error(e); process.exit(1) })

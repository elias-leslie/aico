// Live check of the design question card, link buttons in a question body, and the new-share count on Files > Shared.
const { chromium } = require('/home/kasadis/.local/lib/node_modules/@playwright/cli/node_modules/playwright-core')
const OUT = '/srv/workspaces/projects/aico/evidence/designs'
const BASE = 'http://127.0.0.1:3002'
;(async () => {
  const browser = await chromium.launch({ executablePath: '/home/kasadis/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome' })
  for (const [name, opts] of [
    ['wide', { viewport: { width: 1440, height: 900 } }],
    ['narrow', { viewport: { width: 520, height: 900 }, hasTouch: true, isMobile: true }],
  ]) {
    const ctx = await browser.newContext(opts)
    const page = await ctx.newPage()
    const problems = []
    page.on('pageerror', (e) => problems.push('PAGEERROR ' + e.message))
    page.on('console', (m) => { if (m.type() === 'error') problems.push('CONSOLE ' + m.text()) })
    await page.goto(`${BASE}/needs-you`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1500)
    const card = page.getByTestId('ask-card').filter({ hasText: 'Which design should we use?' })
    await card.first().screenshot({ path: `${OUT}/card-${name}-design.png` })
    const other = page.getByTestId('ask-card').filter({ hasText: 'link buttons in a question' })
    await other.first().screenshot({ path: `${OUT}/card-${name}-links.png` })
    console.log(name, 'design card buttons:', await card.first().locator('a, button').allInnerTexts())
    console.log(name, 'design card text has "(": ', /\(\w{12}\)/.test(await card.first().innerText()), '| has /workbench:', (await card.first().innerText()).includes('/workbench'))
    console.log(name, 'links card buttons:', await other.first().locator('a, button').allInnerTexts())
    await page.screenshot({ path: `${OUT}/card-${name}-page.png` })
    if (name === 'narrow') {
      await card.first().getByRole('link', { name: 'Open design' }).click()
      await page.waitForTimeout(1500)
      console.log(name, 'Open design went to:', page.url())
      await page.screenshot({ path: `${OUT}/card-${name}-opened.png` })
    } else {
      const [popup] = await Promise.all([
        ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null),
        card.first().getByRole('link', { name: 'Open design' }).click(),
      ])
      if (popup) {
        await popup.waitForLoadState('networkidle')
        await popup.waitForTimeout(1500)
        console.log(name, 'Open design popup:', popup.url())
        await popup.screenshot({ path: `${OUT}/card-${name}-opened.png` })
      } else console.log(name, 'no popup opened')
    }
    // Files > Shared: a count of what came since it was last open.
    const shows = (await (await fetch(`${BASE}/api/shows`)).json()).shows
    const before = shows.at(-3).createdAt // the last two shares count as new
    await ctx.addInitScript((value) => { try { localStorage.setItem('aico:shared-opened-at', value) } catch {} }, before)
    const files = await ctx.newPage()
    await files.goto(`${BASE}/workbench?tab=files`, { waitUntil: 'networkidle' })
    await files.waitForTimeout(2000)
    const chip = files.getByRole('button', { name: /^Shared/ })
    console.log(name, 'Shared button:', await chip.innerText())
    await files.screenshot({ path: `${OUT}/shared-${name}-new.png` })
    await chip.click()
    await files.waitForTimeout(1200)
    console.log(name, 'Shared button after opening:', await files.getByRole('button', { name: /^Shared/ }).innerText())
    console.log(name, 'problems:', problems)
    await ctx.close()
  }
  await browser.close()
})()

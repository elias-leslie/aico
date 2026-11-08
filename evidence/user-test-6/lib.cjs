const { chromium } = require('/home/kasadis/.local/lib/node_modules/@playwright/cli/node_modules/playwright-core');
async function open(phone, path = '/') {
  const browser = await chromium.launch({ executablePath: '/home/kasadis/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome', headless: true });
  const page = await browser.newPage(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:3002' + path, { waitUntil: 'networkidle', timeout: 60000 });
  return { browser, page };
}
module.exports = { open };

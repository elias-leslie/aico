// Opens Aico with made-up questions and access requests. Everything to do with questions stays in
// this browser: answers never reach the server, so nothing touches the real list or anyone's phone.
const { chromium } = require('/home/kasadis/.local/lib/node_modules/@playwright/cli/node_modules/playwright-core');
const MIN = 60000;
function asks(now) {
  const base = { session: null, options: [], recommended: null, body: null, command: null, share: null, attached: [], wantsFiles: null, files: [], blocking: false, state: 'open', answer: null, note: null, delivery: 'wake', launcher: null, answerTo: null, answeredAt: null };
  const ask = (id, age, rest) => ({ ...base, id, createdAt: now - age * MIN, updatedAt: now - age * MIN, ...rest });
  return [
    ask('aaaaaaaaaaa1', 90, { requester: 'Backups lane', question: 'Should the nightly backup keep 30 days of copies instead of 14?', options: ['Keep 30 days', 'Keep 14 days'], recommended: 0, body: 'The Drive folder has room for about 40 days at the current size.', blocking: true }),
    ask('aaaaaaaaaaa2', 12, { requester: 'Docs lane', question: 'Does this draft of the install guide read right to you?', attached: [{ path: '/srv/scratch/zz-test-files/zz-test-readme.txt', name: 'zz-test-readme.txt', kind: 'file', size: 42 }, { path: '/srv/scratch/zz-test-files/gone.txt', name: 'gone.txt', kind: 'missing', size: null }] }),
    ask('aaaaaaaaaaa3', 200, { requester: 'Router lane', question: 'Please run this on the router and tell me what it prints', command: 'ip -br addr show', body: 'I have no way to reach the router from here.' }),
    ask('aaaaaaaaaaa4', 30, { requester: 'Receipts lane', question: 'Send me a photo of the receipt from Saturday', wantsFiles: { min: 1, max: 2, hint: 'A clear photo of the whole receipt' } }),
    ask('aaaaaaaaaaa5', 45, { requester: null, origin: 'status', question: 'The nightly export has failed three nights running', options: ['Look now', 'Leave it'], open: 'https://example.com/item' }),
    ask('aaaaaaaaaaa6', 600, { requester: 'Standby lane', host: 'standby', peer: { state: 'down', since: now - 40 * MIN, listedAt: now - 41 * MIN }, question: 'Should the standby take over the morning digest?', options: ['Yes', 'No'] }),
    ask('aaaaaaaaaaa7', 300, { requester: 'Notes lane', question: 'Which name do you prefer for the export folder?', options: ['exports', 'archive'], state: 'answered', answer: 'exports', answeredAt: now - 90 * MIN, updatedAt: now - 90 * MIN, answerTo: 'Notes lane' }),
  ];
}
async function open(phone, path = '/') {
  const browser = await chromium.launch({ executablePath: '/home/kasadis/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome', headless: true });
  const context = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
  const list = asks(Date.now());
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await context.route(/\/api\/asks(\/|\?|$)/, async (route) => {
    const request = route.request();
    const m = new URL(request.url()).pathname.match(/\/api\/asks\/([^/]+)\/(answer|done)$/);
    if (!m) return request.method() === 'GET' ? json(route, { asks: list }) : json(route, { error: 'not in this test' }, 400);
    const item = list.find((a) => a.id === m[1]);
    if (!item) return json(route, { error: 'no such question' }, 404);
    const body = request.postDataJSON() || {};
    const at = Date.now();
    if (m[2] === 'done') item.state = 'done';
    else {
      item.state = 'answered';
      item.answer = body.text ?? item.options[body.option] ?? null;
      item.note = body.note ?? null;
      item.answeredAt = at;
      item.answerTo = item.requester;
    }
    item.updatedAt = at;
    return json(route, { ask: item });
  });
  await context.route(/\/api\/approvals/, (route) => json(route, { state: 'ok', taps: [{ id: 'tap1', title: 'Admin access to GitHub for 30 minutes', url: 'https://example.com/tap', expiresInS: 540 }] }));
  await context.route(/\/api\/captures/, (route) => (route.request().method() === 'GET' ? route.continue() : json(route, { error: 'uploads are off in this test' }, 400)));
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:3002' + path, { waitUntil: 'networkidle', timeout: 60000 });
  return { browser, context, page };
}
module.exports = { open };

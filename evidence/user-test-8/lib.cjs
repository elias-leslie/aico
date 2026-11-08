// Opens Aico for a tester. Questions, access requests and logins are made up and stay in this browser,
// session and history titles are made up, live sessions don't connect, Files sees only the test folder, notes show only zz-test- ones, and only notes and file reads reach the server.
const { chromium } = require('/home/kasadis/.local/lib/node_modules/@playwright/cli/node_modules/playwright-core');
const MIN = 60000;
function asks(now) {
  const base = { session: null, options: [], recommended: null, body: null, command: null, share: null, attached: [], wantsFiles: null, files: [], blocking: false, state: 'open', answer: null, note: null, delivery: 'wake', launcher: null, answerTo: null, answeredAt: null };
  const ask = (id, age, rest) => ({ ...base, id, createdAt: now - age * MIN, updatedAt: now - age * MIN, ...rest });
  return [
    ask('aaaaaaaaaaa1', 90, { requester: 'Backups lane', question: 'Should the nightly backup keep 30 days of copies instead of 14?', options: ['Keep 30 days', 'Keep 14 days'], recommended: 0, body: 'The Drive folder has room for about 40 days at the current size.', blocking: true }),
    ask('aaaaaaaaaaa2', 12, { requester: 'Docs lane', question: 'Does this draft of the install guide read right to you?', attached: [{ path: '/srv/scratch/zz-test-files/zz-test-readme.txt', name: 'zz-test-readme.txt', kind: 'file', size: 42 }] }),
    ask('aaaaaaaaaaa4', 30, { requester: 'Receipts lane', question: 'Send me a photo of the receipt from Saturday', wantsFiles: { min: 1, max: 2, hint: 'A clear photo of the whole receipt' } }),
    ask('aaaaaaaaaaa5', 45, { requester: null, origin: 'status', question: 'The nightly export has failed three nights running', options: ['Look now', 'Leave it'], open: 'https://example.com/item' }),
    ask('aaaaaaaaaaa7', 300, { requester: 'Notes lane', question: 'Which name do you prefer for the export folder?', options: ['exports', 'archive'], state: 'answered', answer: 'exports', answeredAt: now - 90 * MIN, updatedAt: now - 90 * MIN, answerTo: 'Notes lane' }),
  ];
}
const iso = (ago) => new Date(Date.now() - ago * MIN).toISOString();
const login = (name, target, actor, username) => ({ name, kind: 'lab login', notes: '', state: 'active', machines: ['workstation'], roles: [], created: iso(9000), rotated: null, lastUsed: iso(120), lab: { target, actor, kind: 'account', fields: ['username', 'password'], expires_at: null, username, login_url: `https://${target}.example.com/login` } });
const LOGINS = { machine: 'workstation', revealSeconds: 30, assignments: { 'zz-test-role': ['_lab_school--default'] }, entries: [login('_lab_school--default', 'school', 'default', 'parent.one'), login('_lab_school--second', 'school', 'second', 'parent.two'), login('_lab_library--default', 'library', 'default', 'reader'), { ...login('zz-api-key', 'x', 'y', ''), kind: 'API key', lab: undefined, notes: 'A made-up key' }] };
const AUDIT = { events: [{ at: iso(30), action: 'rotate', name: '_lab_school--default', actor: 'owner' }, { at: iso(200), action: 'add', name: '_lab_library--default', actor: 'agent' }] };
const TEST_FILES = '/srv/scratch/zz-test-files';
// Every session and history title is made up: real ones can name the owner's family or files.
const masked = (s, i = 0) => ({ ...s, name: `zz-test session ${i + 1}`, title: `zz-test session ${i + 1}`, doing: null, task: null, activity_detail: null, working_dir: s.working_dir ? TEST_FILES : s.working_dir, cwd: s.cwd ? TEST_FILES : s.cwd });
const aico = (t) => /aico/i.test(`${t.project ?? ''} ${t.project_name ?? ''} ${t.project_id ?? ''}`) || /^zz-test-/.test(t.name ?? t.title ?? '');
async function open(phone, path = '/') {
  const browser = await chromium.launch({ executablePath: '/home/kasadis/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome', headless: true });
  const context = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
  const list = asks(Date.now());
  const seen = new Set();
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const edit = async (route, change) => {
    const response = await route.fetch();
    const data = await response.json().catch(() => null);
    return data ? json(route, change(data), response.status()) : route.fulfill({ response });
  };
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname: p } = new URL(request.url());
    if (/neri|hunter/i.test(request.url())) return json(route, { error: 'not in this test' }, 403);
    if (p === '/api/files/places') return json(route, { places: [{ id: 'home', label: 'Home', path: TEST_FILES }] });
    if (/shared/.test(p)) return json(route, { paths: [], items: [], entries: [] });
    if (/\/files(\/|$)/.test(p)) {
      const q = new URL(request.url()).searchParams;
      const where = p.startsWith('/api/files/page') ? decodeURIComponent(p.slice('/api/files/page'.length)) : (q.get('root') ?? q.get('path') ?? '');
      if (where === TEST_FILES || where.startsWith(TEST_FILES + '/')) return route.continue();
      return p.endsWith('/tree') ? json(route, { entries: [], path: '', total: 0 }) : json(route, { error: 'not in this test' }, 403);
    }
    if (p.startsWith('/api/asks')) {
      const m = p.match(/\/api\/asks\/([^/]+)\/(answer|done)$/);
      if (!m) return request.method() === 'GET' ? json(route, { asks: list }) : json(route, { error: 'not in this test' }, 400);
      const item = list.find((a) => a.id === m[1]);
      if (!item) return json(route, { error: 'no such question' }, 404);
      const body = request.postDataJSON() || {};
      if (m[2] === 'done') item.state = 'done';
      else Object.assign(item, { state: 'answered', answer: body.text ?? item.options[body.option] ?? null, note: body.note ?? null, answeredAt: Date.now(), answerTo: item.requester });
      item.updatedAt = Date.now();
      return json(route, { ask: item });
    }
    if (p.startsWith('/api/approvals')) return json(route, { state: 'ok', taps: [{ id: 'tap1', title: 'Admin access to GitHub for 30 minutes', url: 'https://example.com/tap', expiresInS: 540 }] });
    if (p === '/api/logins/audit') return json(route, AUDIT);
    if (p === '/api/logins/sessions') return json(route, { sessions: [] });
    if (p === '/api/logins/roles') return json(route, { roles: ['zz-test-role'] });
    if (p.startsWith('/api/logins')) return request.method() === 'GET' && p === '/api/logins' ? json(route, LOGINS) : json(route, { error: 'not in this test' }, 400);
    if (request.method() !== 'GET' && !/^\/api\/(notes|files)/.test(p)) return json(route, { error: 'not in this test' }, 400);
    if (p === '/api/notes/labels') return json(route, { labels: [] });
    if (p === '/api/notes') return request.method() === 'GET' ? edit(route, (d) => ({ ...d, notes: (d.notes ?? []).filter((n) => /^zz-test-/.test(n.title ?? '')), total: (d.notes ?? []).filter((n) => /^zz-test-/.test(n.title ?? '')).length })) : route.continue();
    if (p === '/api/shows') return json(route, { shows: [] });
    if (p === '/api/grants') return edit(route, (d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, Array.isArray(v) ? [] : v])));
    if (p === '/api/panes') return edit(route, (d) => ({ ...d, items: (d.items ?? []).map((pane, i) => ({ ...pane, pane_name: `zz-test session ${i + 1}`, sessions: (pane.sessions ?? []).map((x) => masked(x, i)) })) }));
    if (/^\/api\/sessions\/[^/]+/.test(p) || /^\/api\/panes\/[^/]+/.test(p) && p !== '/api/panes/detached') return json(route, { error: 'not in this test' }, 403);
    if (p === '/api/sessions') return edit(route, (d) => { const items = (d.items ?? []).filter(aico).map((x, i) => masked(x, i)); return { ...d, items, total: items.length }; });
    if (p === '/api/history/search') return json(route, { items: [] });
    if (p === '/api/history') return edit(route, (d) => ({ ...d, items: (d.items ?? []).map((s, i) => { if (s.test) seen.add(s.id); return { ...masked(s, i), project: aico(s) ? s.project : 'other' }; }) }));
    const one = p.match(/^\/api\/history\/([^/]+)/);
    if (one && one[1] !== 'live' && !seen.has(decodeURIComponent(one[1]))) return json(route, { error: 'not in this test' }, 403);
    return route.continue();
  });
  await context.routeWebSocket(/terminal|\/ws\b/, (ws) => ws.close());
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:3002' + path, { waitUntil: 'networkidle', timeout: 60000 });
  return { browser, context, page };
}
module.exports = { open };

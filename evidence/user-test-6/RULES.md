# Rules for testers
- Aico web app: http://127.0.0.1:3002 (headless browser only, never the owner's desktop Chrome or any desktop window).
  Headless Chromium via Playwright: require('/home/kasadis/.local/lib/node_modules/@playwright/cli/node_modules/playwright-core'),
  executablePath '/home/kasadis/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome'.
  A ready helper: /srv/workspaces/projects/aico/evidence/user-test-6/lib.cjs (open(phone, path) -> {browser, page}); require it by that full path.
- Test at two widths: phone 390x844 (isMobile, hasTouch) and desktop 1440x900. Use only what the screen shows you; don't read the app's source code or docs.
- Never type into, answer, end or rename anything you did not create. Existing sessions and "Needs you" items belong to the owner: look, don't touch.
- Sessions, notes, logins or files you create: name them starting with "zz-test-". Sessions you start must be Shell sessions (never an Agent). End or delete everything you created before you finish.
- Do not power machines on or off, restore or delete backups, change settings you did not create, run or pause routines, or tap approve or deny on a real grant. You may open dialogs to see what they say, then cancel.
- Do not open the Neri app or any security case data.
- Write everything (scripts, screenshots, report.md) only in your own output folder.
- report.md: for each step, what you tried, what you saw (screenshot name), and every point where you were unsure what to do, what a word meant, or something looked wrong. Confusion counts as a finding. Quote the exact text on screen. Read your screenshots back: judge what a person would see, not only the DOM.
- Never use rm in a command or script (it stops at a safety prompt nobody can answer). Overwrite files or use a fresh folder.

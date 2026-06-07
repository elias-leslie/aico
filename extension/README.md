# Aico browser extension (MV3)

Send selected web content to your active Aico widget through the local sidecar.

## What it does

A capture is delivered only after an explicit user gesture:

- selection pill: select text, then click **Send to Aico**
- context menu: send selected text, a link, an image, or the whole page
- element picker: choose page elements and send them as a batch
- batch tray: collect multiple items and send them together

The extension posts to `POST /selection/send` on the local sidecar. Aico stores the capture in a small local SQLite ring buffer, delivers an event to the main process, and inserts a compact reference into the last-focused widget prompt. It does not press Enter for you.

## Architecture

- `manifest.json` — MV3 manifest with host permission for `http://127.0.0.1:8005/*`.
- `background.js` — owns context menus and all sidecar network calls.
- `content.js` — page UI in a Shadow DOM; sends selected records to the background worker.

Capture records use `kind: "dom"` and put the DOM subtype (`text`, `element`, `link`, `image`, or `page`) in `meta.type`.

## Load it for development

1. Start Aico so the sidecar is up on `127.0.0.1:8005`.
2. Chrome/Chromium → `chrome://extensions` → enable **Developer mode**.
3. **Load unpacked** → select this `extension/` directory.
4. Select text on a page and send it with the pill or context menu.

If the sidecar is not running, sends are best-effort and do not affect the page.

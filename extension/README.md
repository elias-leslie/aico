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

- `manifest.json` — MV3 manifest with host permission for `http://127.0.0.1:8005/*` and a public `key` that pins the extension ID.
- `background.js` — owns context menus and all sidecar network calls.
- `content.js` — page UI in a Shadow DOM; sends selected records to the background worker.

Capture records use `kind: "dom"` and put the DOM subtype (`text`, `element`, `link`, `image`, or `page`) in `meta.type`.

## Load it for development

1. Start Aico so the sidecar is up on `127.0.0.1:8005`.
2. Chrome/Chromium → `chrome://extensions` → enable **Developer mode**.
3. **Load unpacked** → select this `extension/` directory.
4. Select text on a page and send it with the pill or context menu.

## Extension ID

The manifest's `key` field holds only a public key, so every unpacked load gets the same extension ID: `oejadbpdecaenbbihglcnchnkmlilmjf`. The sidecar accepts `chrome-extension://` requests and CORS only from that ID. The private key was discarded, so this ID can't be used to sign a packed `.crx`.

To trust a different build (a fork with its own `key`, or a store-published ID), set `AICO_EXTENSION_IDS` for the sidecar to a comma-separated list of IDs. The list replaces the default, so include `oejadbpdecaenbbihglcnchnkmlilmjf` if you still load this extension.

Every send ends in a toast on the page that says what happened: **Sent … to Aico** when the sidecar took it, **Not sent.** with the reason (Aico unreachable, an HTTP error, or the extension not answering, which reloading the page fixes), or **No answer.** when Aico didn't reply within 5 seconds and may have stored it anyway. A failed batch stays in the tray, and a failed pill send is kept there for a retry. Context-menu sends toast too, except on pages the extension can't run in, such as `chrome://` pages, and tabs opened before the extension last loaded or reloaded (reload the tab to get toasts there). "Sent" means the sidecar stored the capture; it doesn't yet confirm that a widget received it.

// What a design or a viewed file looks like on the page: the kinds Aico can show, and the
// documents the web server wraps around the text kinds so each shows in a sandboxed frame.
//
// Every document is meant for an iframe without allow-same-origin, and says so itself too (the
// CSP `sandbox` header): it runs in an opaque origin, so it can't use Aico's cookies or API.
// Nothing is loaded from the network but Aico's own token stylesheet and the two vendored
// libraries (Markdown and Mermaid, pinned under web-frontend/public/vendor).

export const DESIGN_KINDS = ['html', 'svg', 'image', 'pdf', 'markdown', 'mermaid'] as const
export type DesignKind = (typeof DESIGN_KINDS)[number]

const EXTENSIONS: Readonly<Record<string, DesignKind>> = {
  '.html': 'html',
  '.htm': 'html',
  '.svg': 'svg',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.pdf': 'pdf',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.mmd': 'mermaid',
  '.mermaid': 'mermaid',
}

/** The kind a file name suggests, or null when Aico can't show it. */
export function designKindOf(name: string): DesignKind | null {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? null : (EXTENSIONS[name.slice(dot).toLowerCase()] ?? null)
}

/** Kinds kept as bytes; the rest are text. */
export const isBinaryKind = (kind: DesignKind): boolean => kind === 'image' || kind === 'pdf'

/** What the bytes are, by their first bytes (never by the name a sender gave them). */
export function sniffMedia(bytes: Buffer): { kind: 'image' | 'pdf'; type: string } | null {
  const head = bytes.subarray(0, 12)
  if (head.subarray(0, 8).equals(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1')))
    return { kind: 'image', type: 'image/png' }
  if (head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))
    return { kind: 'image', type: 'image/jpeg' }
  const start = head.subarray(0, 6).toString('latin1')
  if (start === 'GIF87a' || start === 'GIF89a') return { kind: 'image', type: 'image/gif' }
  if (
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return { kind: 'image', type: 'image/webp' }
  if (head.subarray(0, 5).toString('latin1') === '%PDF-')
    return { kind: 'pdf', type: 'application/pdf' }
  return null
}

/** The vendored libraries, as the web server serves them (web-frontend/public/vendor). */
const MERMAID_SCRIPT = '/vendor/mermaid-11.17.2.min.js'
const MARKED_SCRIPT = '/vendor/marked-18.0.11.umd.js'

/** A design's own HTML: no origin privileges, external resources, forms, or nested frames. Inline
 * scripts can demonstrate a design's interactions inside the sandbox. */
export const MOCKUP_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  'sandbox allow-scripts',
].join('; ')

/** Documents Aico wrote around a text file: its own stylesheet and the vendored scripts only. */
export const WRAPPED_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  'sandbox allow-scripts',
].join('; ')

/** An image or a PDF, served as itself. A PDF can't be sandboxed (the viewer won't open), but it
 * is only ever a PDF: nosniff, and not a page. */
export const IMAGE_CSP = "default-src 'none'; frame-ancestors 'self'; sandbox"
export const PDF_CSP = "frame-ancestors 'self'"

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
}

const PAGE_CSS = `
html,body{margin:0;min-height:100%}
body{background:var(--ink,#0b0d11);color:var(--bone,#e7e2d6);font:15px/1.55 var(--font-ui,system-ui,sans-serif)}
.canvas{box-sizing:border-box;width:100%;height:100vh;padding:12px;display:flex}
.canvas img{width:100%;height:100%;object-fit:contain;background:var(--bone,#e7e2d6);border-radius:6px}
.note{margin:0;padding:16px;color:var(--mist,#8b8f94)}
pre.mermaid{margin:0;padding:16px;display:flex;justify-content:center;color:var(--bone,#e7e2d6);font:13px/1.45 var(--font-mono,ui-monospace,monospace);white-space:pre}
pre.mermaid[data-processed]{white-space:normal}
.failed{margin:16px;padding:12px;border-radius:6px;background:var(--paper,rgba(245,240,233,.06));box-shadow:inset 0 0 0 1px var(--ember,#c9483d)}
.failed p{margin:0 0 6px}
.failed pre{margin:0;overflow:auto;color:var(--mist,#8b8f94);font:12px/1.45 var(--font-mono,ui-monospace,monospace)}
`

const MARKDOWN_CSS = `
article{box-sizing:border-box;max-width:760px;margin:0 auto;padding:20px 16px 40px}
h1,h2,h3,h4{font-family:var(--font-display,Georgia,serif);font-weight:600;line-height:1.25;margin:1.4em 0 .5em}
h1{font-size:1.7em;margin-top:0}h2{font-size:1.35em}h3{font-size:1.15em}h4{font-size:1em}
p,ul,ol,blockquote,table,pre{margin:0 0 1em}
ul,ol{padding-left:1.5em}
code{font:.88em var(--font-mono,ui-monospace,monospace);background:var(--paper,rgba(245,240,233,.06));padding:.1em .35em;border-radius:4px}
pre{overflow:auto;background:var(--paper,rgba(245,240,233,.06));padding:12px;border-radius:6px}
pre code{background:none;padding:0}
blockquote{margin-left:0;padding-left:12px;color:var(--mist,#8b8f94);box-shadow:inset 3px 0 0 var(--frame-edge,rgba(229,166,71,.26))}
table{border-collapse:collapse;display:block;overflow:auto}
th,td{padding:5px 10px;box-shadow:inset 0 0 0 1px var(--frame-edge,rgba(229,166,71,.26));text-align:left}
hr{border:0;height:1px;background:var(--frame-edge,rgba(229,166,71,.26));margin:1.5em 0}
.link{text-decoration:underline;text-decoration-color:var(--mist,#8b8f94)}
img{max-width:100%}
`

const MERMAID_RUN = `
(function () {
  var lib = self.__esbuild_esm_mermaid_nm && self.__esbuild_esm_mermaid_nm.mermaid;
  var mermaid = lib && (lib.default || lib);
  var nodes = [].slice.call(document.querySelectorAll('pre.mermaid'));
  function say(node, text) {
    var box = document.createElement('div');
    box.className = 'failed';
    var p = document.createElement('p');
    p.textContent = text;
    var source = document.createElement('pre');
    source.textContent = node.getAttribute('data-source') || '';
    box.appendChild(p);
    box.appendChild(source);
    node.replaceWith(box);
  }
  nodes.forEach(function (node) { node.setAttribute('data-source', node.textContent); });
  if (!mermaid) { nodes.forEach(function (node) { say(node, 'The diagram viewer did not load.'); }); return; }
  var css = getComputedStyle(document.documentElement);
  var rgb = function (name, fallback) {
    var parts = css.getPropertyValue(name).trim().split(/\\s+/);
    return parts.length === 3 ? 'rgb(' + parts.join(',') + ')' : fallback;
  };
  var hex = function (name, fallback) { return css.getPropertyValue(name).trim() || fallback; };
  var bone = rgb('--bone-rgb', '#e7e2d6'), rim = hex('--rim', '#1c1f24');
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: {
      background: rgb('--ink-rgb', '#0b0d11'), primaryColor: rim, primaryTextColor: bone,
      primaryBorderColor: hex('--lantern-deep', '#b47a2a'), lineColor: hex('--mist', '#8b8f94'),
      secondaryColor: rim, tertiaryColor: rim, textColor: bone, noteBkgColor: rim, noteTextColor: bone,
      fontFamily: hex('--font-ui', 'system-ui, sans-serif')
    }
  });
  nodes.forEach(function (node) {
    mermaid.run({ nodes: [node] }).catch(function (error) {
      say(node, 'This diagram could not be drawn: ' + String((error && error.message) || error).split('\\n')[0]);
    });
  });
})();
`

const MARKDOWN_RUN = `
(function () {
  var source = document.getElementById('src').value;
  var out = document.getElementById('out');
  var esc = function (text) {
    return String(text).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  if (!self.marked) { out.textContent = 'The Markdown viewer did not load.'; return; }
  self.marked.use({
    renderer: {
      // Raw HTML in the text shows as text, links and images never load anything.
      html: function (token) { return esc(token.text || token.raw || ''); },
      link: function (token) {
        return '<span class="link" title="' + esc(token.href || '') + '">' + this.parser.parseInline(token.tokens) + '</span>';
      },
      image: function (token) { return esc(token.text || ''); },
      code: function (token) {
        if (token.lang !== 'mermaid') return false;
        return '<pre class="mermaid">' + esc(token.text) + '</pre>';
      }
    }
  });
  out.innerHTML = self.marked.parse(source);
  if (out.querySelector('pre.mermaid')) {
    var script = document.createElement('script');
    script.src = ${JSON.stringify(MERMAID_SCRIPT)};
    script.onload = function () { ${MERMAID_RUN.replace(/\n/g, ' ')} };
    document.head.appendChild(script);
  }
})();
`

const TOKENS =
  '<link rel="stylesheet" href="/ui-kit/tokens.css"><link rel="stylesheet" href="/ui-kit/fonts.css">'

function page(title: string, css: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>${TOKENS}<style>${PAGE_CSS}${css}</style></head><body>${body}</body></html>`
}

/** A text kind as the document that shows it. HTML is the file itself; `title` names the page. */
export function viewDocument(
  kind: 'svg' | 'markdown' | 'mermaid',
  text: string,
  title: string,
): string {
  if (kind === 'svg') {
    const url = `data:image/svg+xml;base64,${Buffer.from(text, 'utf8').toString('base64')}`
    return page(
      title,
      '',
      `<div class="canvas"><img alt="${escapeHtml(title)}" src="${url}"></div>`,
    )
  }
  if (kind === 'mermaid')
    return page(
      title,
      '',
      `<pre class="mermaid">${escapeHtml(text)}</pre><script src="${MERMAID_SCRIPT}"></script><script>${MERMAID_RUN}</script>`,
    )
  return page(
    title,
    MARKDOWN_CSS,
    `<textarea id="src" hidden>\n${escapeHtml(text)}</textarea><article id="out"></article><script src="${MARKED_SCRIPT}"></script><script>${MARKDOWN_RUN}</script>`,
  )
}

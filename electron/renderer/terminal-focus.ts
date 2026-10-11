/** Keyboard focus belongs to the terminal unless something else in the window
 * holds it (the rename input, palette, compose draft, history overlay). A
 * freshly opened or restored window starts with focus on the page body, so
 * typing after the window comes forward went nowhere until a click. */
export function terminalShouldTakeFocus(doc: Pick<Document, 'activeElement' | 'body'>): boolean {
  const active = doc.activeElement
  return active === null || active === doc.body
}

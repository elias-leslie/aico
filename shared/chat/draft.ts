// Put text back in the chat's message box, the way Claude Code does with
// follow-ups that were waiting when you pressed Stop: unsent, for the owner to
// send or edit. The shared chat component keeps the box's text to itself and has
// no way to be handed some, so this types it in as the browser would (the box
// is a plain textarea, and its change event is what the component listens to).

/** The text to show: what was waiting, then whatever the owner had already typed. */
export function mergeDraft(restored: readonly string[], typed: string): string {
  return [...restored, typed.trim() ? typed : ''].filter((part) => part !== '').join('\n\n')
}

/** Put `restored` ahead of what is typed in the first message box under `root`. False when there is none. */
export function restoreDraft(root: ParentNode | null, restored: readonly string[]): boolean {
  const box = root?.querySelector('textarea')
  if (!box || !restored.length) return false
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (!setValue) return false
  setValue.call(box, mergeDraft(restored, box.value))
  box.dispatchEvent(new Event('input', { bubbles: true }))
  box.focus()
  box.setSelectionRange(box.value.length, box.value.length)
  return true
}

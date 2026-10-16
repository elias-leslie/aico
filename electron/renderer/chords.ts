// The Ctrl+Shift chords a window handles itself, by KeyboardEvent.code. The key
// handlers dispatch on this table and the menu, palette and tooltips label
// actions from it, so a label always names the key that works.

export const WINDOW_CHORDS = {
  palette: 'KeyP',
  hub: 'KeyH',
  refresh: 'KeyR',
  copy: 'KeyC',
  paste: 'KeyV',
} as const

export type WindowChord = keyof typeof WINDOW_CHORDS

/** The chord a key event is, if it is one of the window's (Ctrl+Shift, no Alt or Super). */
export function windowChord(
  e: Pick<KeyboardEvent, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'code'>,
): WindowChord | null {
  if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return null
  const hit = Object.entries(WINDOW_CHORDS).find(([, code]) => code === e.code)
  return hit ? (hit[0] as WindowChord) : null
}

/** How a window chord reads: `Ctrl+Shift+P`. */
export function chordLabel(chord: WindowChord): string {
  return `Ctrl+Shift+${WINDOW_CHORDS[chord].replace(/^Key/, '')}`
}

const MODIFIER_LABELS: Record<string, string> = {
  commandorcontrol: 'Ctrl',
  cmdorctrl: 'Ctrl',
  control: 'Ctrl',
  ctrl: 'Ctrl',
  command: 'Super',
  cmd: 'Super',
  super: 'Super',
  meta: 'Super',
  alt: 'Alt',
  option: 'Alt',
  altgr: 'AltGr',
  shift: 'Shift',
}

/** How an Electron accelerator main registered reads (`CommandOrControl+Shift+Space`
 * reads `Ctrl+Shift+Space`); '' when none is registered. */
export function acceleratorLabel(accelerator: string | null | undefined): string {
  if (!accelerator) return ''
  return accelerator
    .split('+')
    .map(
      (part) =>
        MODIFIER_LABELS[part.toLowerCase()] ?? (part.length === 1 ? part.toUpperCase() : part),
    )
    .join('+')
}

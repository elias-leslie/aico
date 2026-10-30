/** Lantern colours code needs outside CSS (PWA manifest, browser theme
 * colour). They are tokens in shared/tokens.css; a test keeps
 * them equal. */
export const LANTERN_RIM = '#1c1f24'

/** The web terminal's typeface: JetBrains Mono, wider than the desktop's
 * Iosevka default and easier to read on a phone. Named as the desktop's
 * JetBrains Mono setting names it. */
export const LANTERN_MONO_FACE = 'JetBrains Mono'
/** The agent-TUI symbols JetBrains Mono lacks (⎿ ✻ ✢ ⏺ …); assets/fonts. */
export const LANTERN_SYMBOLS_FACE = 'FreeMono Symbols'
export const LANTERN_MONO_FAMILY = `'${LANTERN_MONO_FACE}', '${LANTERN_SYMBOLS_FACE}', ui-monospace, monospace`

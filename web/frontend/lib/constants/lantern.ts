/** Lantern colours code needs outside CSS (PWA manifest, browser theme
 * colour). They are tokens in electron/renderer/tokens.css; a test keeps
 * them equal. */
export const LANTERN_RIM = '#1c1f24'

/** The web terminal's typeface: JetBrains Mono, wider than the desktop's
 * Iosevka default and easier to read on a phone. Named as the desktop's
 * JetBrains Mono setting names it. */
export const LANTERN_MONO_FACE = 'JetBrains Mono'
export const LANTERN_MONO_FAMILY = `'${LANTERN_MONO_FACE}', ui-monospace, monospace`

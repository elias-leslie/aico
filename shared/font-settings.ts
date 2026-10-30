/** Vendored fallback for the agent-TUI symbols (⎿ ✻ ✢ ⏺ …) no terminal font
 * here draws; every family lists it right after its own face. */
export const SYMBOLS_FACE = "'FreeMono Symbols'"
/** A character the symbols face draws, so `document.fonts.load` fetches it. */
export const SYMBOLS_SAMPLE = '⎿'

export const AICO_FONTS = [
  {
    id: 'iosevka',
    name: 'Iosevka',
    family: "'Iosevka', 'FreeMono Symbols', ui-monospace, monospace",
    loadFace: "'Iosevka'",
  },
  {
    id: 'system-mono',
    name: 'System Mono',
    family: "ui-monospace, 'SF Mono', Menlo, Consolas, 'FreeMono Symbols', monospace",
    loadFace: 'monospace',
  },
  {
    id: 'jetbrains-mono',
    name: 'JetBrains Mono',
    family: "'JetBrains Mono', 'FreeMono Symbols', ui-monospace, monospace",
    loadFace: "'JetBrains Mono'",
  },
  {
    id: 'fira-code',
    name: 'Fira Code',
    family: "'Fira Code', 'FreeMono Symbols', ui-monospace, monospace",
    loadFace: "'Fira Code'",
  },
  {
    id: 'source-code-pro',
    name: 'Source Code Pro',
    family: "'Source Code Pro', 'FreeMono Symbols', ui-monospace, monospace",
    loadFace: "'Source Code Pro'",
  },
  {
    id: 'cascadia',
    name: 'Cascadia Code',
    family: "'Cascadia Code', 'Cascadia Mono', 'FreeMono Symbols', ui-monospace, monospace",
    loadFace: "'Cascadia Code'",
  },
] as const

export const AICO_FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20] as const

export type AicoFontId = (typeof AICO_FONTS)[number]['id']
export type AicoFontSize = (typeof AICO_FONT_SIZES)[number]

export interface AicoTerminalFontSettings {
  fontId: AicoFontId
  fontSize: AicoFontSize
}

export const DEFAULT_TERMINAL_FONT_SETTINGS: AicoTerminalFontSettings = {
  fontId: 'iosevka',
  fontSize: 13,
}

export function parseTerminalFontSettings(input: unknown): AicoTerminalFontSettings {
  const record = typeof input === 'object' && input !== null ? input : {}
  const fontId = 'fontId' in record ? record.fontId : undefined
  const fontSize = 'fontSize' in record ? record.fontSize : undefined

  return {
    fontId: AICO_FONTS.some((font) => font.id === fontId)
      ? (fontId as AicoFontId)
      : DEFAULT_TERMINAL_FONT_SETTINGS.fontId,
    fontSize: AICO_FONT_SIZES.includes(fontSize as AicoFontSize)
      ? (fontSize as AicoFontSize)
      : DEFAULT_TERMINAL_FONT_SETTINGS.fontSize,
  }
}

export function fontFamilyFor(fontId: AicoFontId): string {
  return AICO_FONTS.find((font) => font.id === fontId)?.family ?? AICO_FONTS[0].family
}

export function fontLoadFaceFor(fontId: AicoFontId): string {
  return AICO_FONTS.find((font) => font.id === fontId)?.loadFace ?? AICO_FONTS[0].loadFace
}

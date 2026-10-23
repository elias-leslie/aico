export interface AnsiColorProfile {
  analyzedChars: number
  hasColor: boolean
  dominantMode: 'none' | 'ansi' | '256' | 'rgb'
  basicColors: number
  brightColors: number
  color256: number
  truecolor: number
  oscPalette: number
  oscHyperlinks: number
  resetCount: number
}

const DEFAULT_ANALYZED_CHARS = 65_536

function parseSgrParams(params: string): number[] {
  if (!params) return [0]
  return params
    .split(/[;:]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part))
}

export function profileAnsiColors(
  text: string,
  maxChars: number = DEFAULT_ANALYZED_CHARS,
): AnsiColorProfile {
  const analyzed = text.length > maxChars ? text.slice(-maxChars) : text
  let basicColors = 0
  let brightColors = 0
  let color256 = 0
  let truecolor = 0
  let oscPalette = 0
  let oscHyperlinks = 0
  let resetCount = 0

  // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is required to detect ANSI SGR sequences
  const sgrRegex = /\x1b\[([0-9;:]*)m/g
  for (
    let match = sgrRegex.exec(analyzed);
    match !== null;
    match = sgrRegex.exec(analyzed)
  ) {
    const params = parseSgrParams(match[1] ?? '')
    for (let i = 0; i < params.length; i += 1) {
      const value = params[i]
      if (value === 0) {
        resetCount += 1
        continue
      }
      if ((value >= 30 && value <= 37) || (value >= 40 && value <= 47)) {
        basicColors += 1
        continue
      }
      if ((value >= 90 && value <= 97) || (value >= 100 && value <= 107)) {
        brightColors += 1
        continue
      }
      if ((value === 38 || value === 48) && i + 1 < params.length) {
        const mode = params[i + 1]
        if (mode === 5 && i + 2 < params.length) {
          color256 += 1
          i += 2
          continue
        }
        if (mode === 2 && i + 4 < params.length) {
          truecolor += 1
          i += 4
        }
      }
    }
  }

  // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is required to detect ANSI OSC sequences
  const oscRegex = /\x1b\]([0-9]+);/g
  for (
    let match = oscRegex.exec(analyzed);
    match !== null;
    match = oscRegex.exec(analyzed)
  ) {
    const code = Number.parseInt(match[1] ?? '', 10)
    if (code === 8) {
      oscHyperlinks += 1
      continue
    }
    if (code === 4 || code === 10 || code === 11 || code === 12) {
      oscPalette += 1
    }
  }

  let dominantMode: AnsiColorProfile['dominantMode'] = 'none'
  if (truecolor > 0) dominantMode = 'rgb'
  else if (color256 > 0) dominantMode = '256'
  else if (basicColors + brightColors > 0) dominantMode = 'ansi'

  return {
    analyzedChars: analyzed.length,
    hasColor:
      basicColors + brightColors + color256 + truecolor + oscPalette > 0,
    dominantMode,
    basicColors,
    brightColors,
    color256,
    truecolor,
    oscPalette,
    oscHyperlinks,
    resetCount,
  }
}

export function formatAnsiColorProfile(profile: AnsiColorProfile): string {
  return [
    `mode=${profile.dominantMode}`,
    `ansi=${profile.basicColors}`,
    `bright=${profile.brightColors}`,
    `256=${profile.color256}`,
    `rgb=${profile.truecolor}`,
    `osc=${profile.oscPalette}`,
    `reset=${profile.resetCount}`,
  ].join(' ')
}

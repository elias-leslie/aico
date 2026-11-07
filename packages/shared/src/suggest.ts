// "Did you mean": the known name closest to a mistyped one, for CLI errors.

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0] as number
    row[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j] as number
      row[j] = Math.min(
        above + 1,
        (row[j - 1] as number) + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      diagonal = above
    }
  }
  return row[b.length] as number
}

/** The name within two edits of `word` (the nearest first), or null. */
export function nearest(word: string, names: readonly string[]): string | null {
  let best: string | null = null
  let bestDistance = 3
  for (const name of names) {
    const d = distance(word.toLowerCase(), name.toLowerCase())
    if (d < bestDistance) {
      best = name
      bestDistance = d
    }
  }
  return best
}

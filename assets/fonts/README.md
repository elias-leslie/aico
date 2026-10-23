# Vendored fonts

Latin-subset `woff2` for the Lantern aesthetic. All four are SIL Open Font
License 1.1; redistribution in this form is permitted.

| File | Family / weight | Source |
|------|-----------------|--------|
| `Fraunces-Variable.woff2`, `Fraunces-Variable-Italic.woff2` | Fraunces, variable `wght 100–900` (display) | github.com/undercasetype/Fraunces — via `@fontsource-variable/fraunces` (latin) |
| `Pretendard-Regular.woff2`, `Pretendard-SemiBold.woff2` | Pretendard 400 / 600 (UI) | github.com/orioncactus/pretendard — `pretendard` npm |
| `Iosevka-400.woff2` | Iosevka 400 (mono) | github.com/be5invis/Iosevka — via `@fontsource/iosevka` (latin) |
| `JetBrainsMono-Regular.woff2`, `JetBrainsMono-Bold.woff2` | JetBrains Mono 400 / 700 (web terminal), full glyph set | github.com/JetBrains/JetBrainsMono release v2.304, `fonts/webfonts/` |

These were copied out of the npm packages (which are not kept as deps — only the
woff2 we use are vendored). To refresh: re-install the packages, copy the
matching `latin` woff2 from `node_modules/.../files/`, then uninstall again.

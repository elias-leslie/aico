# Changelog

## 0.2.6 - 2026-04-18

- Added Hermes as a built-in agent tool preset across mode switching, Settings, and external tmux session detection.
- Hardened the Hermes/TUI prompt workflow: prompt cleaning now has stronger diff/refinement/edit coverage and graceful fallback to the original prompt when the cleaner errors.
- Fixed the Hermes scrollback overlay regression so history entry still anchors at the live bottom output before you scroll backward.
- Excluded frontend build artifacts from Python sdists so release bundles stay clean.
- Documented built-in agent presets and the Agent Hub prompt-cleaning flow in the README.
- Bumped security-sensitive dependencies, including `python-multipart` to `0.0.26` and `mako` to `1.3.11`.

## 0.2.5 - 2026-04-15

- Detached panes now open into dedicated scoped windows, with `Close Pane` keeping the prior remove-from-layout behavior.
- Added same-pane project switching with mode carry-over so project swaps stay in the active tool mode instead of dropping back to plain shell.
- Fixed detached-window attach/reopen flow so panes no longer get stuck on `Open an A-Term` after attach/open actions.
- Restored a mobile-first session switcher model: one touch-friendly bottom sheet, global session visibility across attached and detached work, and no duplicate desktop-only header controls.
- Stopped stray ad-hoc panes from auto-spawning during temporary zero-pane transitions by verifying true global pane count before auto-create.
- Tightened overlay/mobile pane-selection scrolling so long switcher lists can be scrolled reliably on touch devices.

## 0.2.4 - 2026-04-10

- Added low-noise Dependabot coverage with monthly grouped updates and semver-major updates ignored by default.
- Updated frontend dependencies, including the Next.js security patch to 16.2.3.
- Fixed prompt preview line keys so the upgraded Biome gate passes cleanly without suppressions.
- Verified the public repo has no open Dependabot, CodeQL, or secret scanning alerts.

## 0.2.3 - 2026-04-10

- Refreshed the public README around A-Term's core strengths: persistent agent panes, file browsing, prompt-ready Notes, and release-oriented workflows.
- Replaced the main README screenshots with real captures from the running A-Term app, including clean 5-pane and 4-pane layouts.
- Normalized saved pane group sizes so stale layout ratios no longer leave gaps in restored multi-pane grids.
- Added public-release polish for README badges, contributor credit, CI visibility, CodeQL, Dependabot, and repository security posture.

## 0.2.2 - 2026-04-10

- Prepared the first public release baseline after the Terminal to A-Term rename.
- Hardened public repository scans and identity manifest path handling.
- Clarified release metadata, contributor credit, and installation documentation.

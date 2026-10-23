import { KEYBOARD_SPACING_METRICS, type KeyboardSpacingPreset } from './types'

export function getKeyboardStyles(
  rowHeight: number,
  keyboardSpacing: KeyboardSpacingPreset,
): string {
  const baseFontSize = rowHeight <= 36 ? 16 : rowHeight <= 44 ? 18 : 20
  const wideFontSize = rowHeight <= 36 ? 12 : rowHeight <= 44 ? 13 : 14
  const iconFontSize = rowHeight <= 36 ? 20 : rowHeight <= 44 ? 22 : 24
  const spacing = KEYBOARD_SPACING_METRICS[keyboardSpacing]

  return `
    .a-term-keyboard-theme {
      background: var(--term-bg-surface);
      padding: ${spacing.keyboardPadding}px;
      border-radius: 0;
    }

    .a-term-keyboard-theme .hg-button {
      background: var(--term-bg-elevated);
      color: var(--term-text-primary);
      border: 1px solid var(--term-border);
      border-radius: ${spacing.keyRadius}px;
      height: ${rowHeight}px;
      min-width: ${spacing.minKeyWidth}px;
      font-size: ${baseFontSize}px;
      font-weight: 400;
      box-shadow: none;
      flex: 1 1 0;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.1s ease;
    }

    .a-term-keyboard-theme .hg-button:active {
      background: var(--term-border-active);
      box-shadow: 0 0 8px var(--term-accent-glow);
    }

    .a-term-keyboard-theme .hg-button.accent-key {
      background: var(--term-bg-elevated);
      border-color: var(--term-border-active);
    }

    .a-term-keyboard-theme .hg-button.accent-key:active {
      background: var(--term-accent);
      color: var(--term-accent-foreground);
    }

    .a-term-keyboard-theme .hg-button.wide-key {
      background: var(--term-bg-elevated);
      font-size: ${wideFontSize}px;
      font-weight: 500;
    }

    .a-term-keyboard-theme .hg-button[data-skbtn="{shift}"],
    .a-term-keyboard-theme .hg-button[data-skbtn="{bksp}"],
    .a-term-keyboard-theme .hg-button[data-skbtn="{enter}"] {
      font-size: ${iconFontSize}px;
    }

    .a-term-keyboard-theme .hg-button.modifier-sticky {
      background: var(--term-bg-elevated);
      border: 1px solid var(--term-accent-muted);
      color: var(--term-accent);
    }

    .a-term-keyboard-theme .hg-button.modifier-locked {
      background: var(--term-accent);
      color: var(--term-accent-foreground);
      border-color: var(--term-accent);
      box-shadow: 0 0 8px var(--term-accent-glow);
    }

    .a-term-keyboard-theme .hg-row {
      display: flex;
      flex-direction: row;
      gap: ${spacing.keyGap}px;
      margin-bottom: ${spacing.rowGap}px;
    }

    .a-term-keyboard-theme .hg-row:last-child {
      margin-bottom: 0;
    }

    .a-term-keyboard-theme .hg-row:nth-child(3) {
      padding-left: ${spacing.rowInsetPercent}%;
      padding-right: ${spacing.rowInsetPercent}%;
    }

    .a-term-keyboard-theme .hg-button[data-skbtn="{shift}"],
    .a-term-keyboard-theme .hg-button[data-skbtn="{bksp}"] {
      flex: 1.5 1 0;
    }

    .a-term-keyboard-theme .hg-button[data-skbtn="{sym}"],
    .a-term-keyboard-theme .hg-button[data-skbtn="{abc}"] {
      flex: 1.5 1 0;
    }

    .a-term-keyboard-theme .hg-button[data-skbtn="{space}"] {
      flex: 4 1 0;
    }

    .a-term-keyboard-theme .hg-button[data-skbtn="{enter}"] {
      flex: 1.5 1 0;
    }

    .a-term-keyboard-theme .hg-button[data-skbtn="'"],
    .a-term-keyboard-theme .hg-button[data-skbtn="."],
    .a-term-keyboard-theme .hg-button[data-skbtn=","] {
      flex: 1 1 0;
    }
  `
}

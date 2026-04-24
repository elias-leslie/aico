// Modifier key states: off, sticky (single-tap, applies to next key), locked (double-tap, persists)
export type ModifierState = 'off' | 'sticky' | 'locked'

// State for all modifier keys
export interface ModifierStates {
  shift: ModifierState
  ctrl: ModifierState
  alt: ModifierState
}

// Configuration for a single key
export interface KeyConfig {
  label: string
  sequence: string
  width?: number // Width multiplier (1 = normal, 1.5 = 1.5x width, etc.)
  isModifier?: boolean
}

// A-Term input handler type
export type ATermInputHandler = (sequence: string) => void

// Keyboard size presets for mobile
export type KeyboardSizePreset = 'small' | 'medium' | 'large'
export type KeyboardSpacingPreset = 'tight' | 'normal' | 'roomy'
export type MobileKeyboardMode = 'custom' | 'native'

// Map size presets to row heights in pixels
export const KEYBOARD_SIZE_HEIGHTS: Record<KeyboardSizePreset, number> = {
  small: 36,
  medium: 44,
  large: 52,
}

export const CONTROL_BAR_BUTTON_SIZES: Record<KeyboardSizePreset, number> = {
  small: 40,
  medium: 44,
  large: 50,
}

export const CONTROL_BAR_ARROW_SIZES: Record<KeyboardSizePreset, number> = {
  small: 48,
  medium: 56,
  large: 64,
}

export const NATIVE_INPUT_HEIGHTS: Record<KeyboardSizePreset, number> = {
  small: 40,
  medium: 46,
  large: 52,
}

export const KEYBOARD_SPACING_METRICS: Record<
  KeyboardSpacingPreset,
  {
    keyboardPadding: number
    rowGap: number
    keyGap: number
    rowInsetPercent: number
    keyRadius: number
    minKeyWidth: number
    controlPaddingX: number
    controlPaddingY: number
    controlRowGap: number
    arrowGroupGap: number
    nativeInputGap: number
  }
> = {
  tight: {
    keyboardPadding: 4,
    rowGap: 3,
    keyGap: 2,
    rowInsetPercent: 3,
    keyRadius: 6,
    minKeyWidth: 28,
    controlPaddingX: 6,
    controlPaddingY: 4,
    controlRowGap: 8,
    arrowGroupGap: 10,
    nativeInputGap: 6,
  },
  normal: {
    keyboardPadding: 6,
    rowGap: 4,
    keyGap: 3,
    rowInsetPercent: 5,
    keyRadius: 7,
    minKeyWidth: 30,
    controlPaddingX: 8,
    controlPaddingY: 6,
    controlRowGap: 10,
    arrowGroupGap: 14,
    nativeInputGap: 8,
  },
  roomy: {
    keyboardPadding: 8,
    rowGap: 6,
    keyGap: 5,
    rowInsetPercent: 8,
    keyRadius: 8,
    minKeyWidth: 34,
    controlPaddingX: 10,
    controlPaddingY: 8,
    controlRowGap: 12,
    arrowGroupGap: 18,
    nativeInputGap: 10,
  },
}

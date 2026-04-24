'use client'

import { useCallback, useMemo, useRef } from 'react'
import { APP_THEME_OPTIONS, type AppThemePreference } from '@/lib/app-theme'
import {
  A_TERM_CURSOR_STYLES,
  A_TERM_FONT_SIZES,
  A_TERM_FONTS,
  A_TERM_SCROLLBACK_OPTIONS,
  A_TERM_THEMES,
  type ATermCursorStyle,
  type ATermFontId,
  type ATermFontSize,
  type ATermScrollback,
  type ATermThemeId,
} from '@/lib/hooks/use-a-term-settings'
import { useAppTheme } from '@/lib/hooks/use-app-theme'
import { useClickOutside } from '@/lib/hooks/use-click-outside'
import type {
  KeyboardSizePreset,
  KeyboardSpacingPreset,
  MobileKeyboardMode,
} from './keyboard/types'
import { AgentToolsSettings } from './settings/AgentToolsSettings'
import { SettingButtonGroup } from './settings/SettingButtonGroup'
import { SettingCheckbox } from './settings/SettingCheckbox'
import { SettingSelect } from './settings/SettingSelect'
import { SettingsButton } from './settings/SettingsButton'
import { SettingsPanel } from './settings/SettingsPanel'

export interface SettingsDropdownProps {
  fontId: ATermFontId
  fontSize: ATermFontSize
  scrollback: ATermScrollback
  cursorStyle: ATermCursorStyle
  cursorBlink: boolean
  themeId: ATermThemeId
  setFontId: (id: ATermFontId) => void
  setFontSize: (size: ATermFontSize) => void
  setScrollback: (scrollback: ATermScrollback) => void
  setCursorStyle: (style: ATermCursorStyle) => void
  setCursorBlink: (blink: boolean) => void
  setThemeId: (id: ATermThemeId) => void
  showSettings: boolean
  setShowSettings: (show: boolean) => void
  keyboardMode?: MobileKeyboardMode
  setKeyboardMode?: (mode: MobileKeyboardMode) => void
  keyboardSize?: KeyboardSizePreset
  keyboardSpacing?: KeyboardSpacingPreset
  setKeyboardSpacing?: (spacing: KeyboardSpacingPreset) => void
  setKeyboardSize?: (size: KeyboardSizePreset) => void
  isMobile?: boolean
  renderTrigger?: boolean
}

export function SettingsDropdown({
  fontId,
  fontSize,
  scrollback,
  cursorStyle,
  cursorBlink,
  themeId,
  setFontId,
  setFontSize,
  setScrollback,
  setCursorStyle,
  setCursorBlink,
  setThemeId,
  showSettings,
  setShowSettings,
  keyboardMode,
  setKeyboardMode,
  keyboardSize,
  keyboardSpacing,
  setKeyboardSpacing,
  setKeyboardSize,
  isMobile,
  renderTrigger = true,
}: SettingsDropdownProps) {
  const { themePreference, setThemePreference } = useAppTheme()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const closeDropdown = useCallback(
    () => setShowSettings(false),
    [setShowSettings],
  )

  const clickOutsideRefs = useMemo(
    () => (renderTrigger ? [buttonRef, dropdownRef] : [dropdownRef]),
    [renderTrigger],
  )

  useClickOutside(clickOutsideRefs, closeDropdown, showSettings)

  // Prepare options for select components
  const fontOptions = A_TERM_FONTS.map((font) => ({
    value: font.id,
    label: font.name,
  }))

  const fontSizeOptions = A_TERM_FONT_SIZES.map((size) => ({
    value: size,
    label: `${size}px`,
  }))

  const themeOptions = Object.entries(A_TERM_THEMES).map(([id, { name }]) => ({
    value: id,
    label: name,
  }))

  const appThemeOptions = APP_THEME_OPTIONS.map((option) => ({
    value: option.value,
    label: option.label,
  }))

  const scrollbackOptions = A_TERM_SCROLLBACK_OPTIONS.map((opt) => ({
    value: opt.value,
    label: opt.label,
  }))

  const showKeyboardSettings =
    isMobile &&
    keyboardMode !== undefined &&
    keyboardSize !== undefined &&
    keyboardSpacing !== undefined &&
    setKeyboardMode &&
    setKeyboardSize &&
    setKeyboardSpacing

  return (
    <div className={renderTrigger ? 'relative ml-2' : ''}>
      {renderTrigger && (
        <SettingsButton
          ref={buttonRef}
          isActive={showSettings}
          onClick={() => setShowSettings(!showSettings)}
        />
      )}

      <SettingsPanel
        ref={dropdownRef}
        isOpen={showSettings}
        hasButton={renderTrigger}
        buttonRef={buttonRef}
      >
        <SettingSelect
          label="Font Family"
          value={fontId}
          onChange={(val) => setFontId(val as ATermFontId)}
          options={fontOptions}
        />

        <SettingSelect
          label="Font Size"
          value={fontSize}
          onChange={(val) => setFontSize(val as ATermFontSize)}
          options={fontSizeOptions}
        />

        <SettingSelect
          label="App Theme"
          value={themePreference}
          onChange={(val) => setThemePreference(val as AppThemePreference)}
          options={appThemeOptions}
        />

        <SettingSelect
          label="A-Term Theme"
          value={themeId}
          onChange={(val) => setThemeId(val as ATermThemeId)}
          options={themeOptions}
        />

        <SettingButtonGroup
          label="Cursor Style"
          value={cursorStyle}
          options={A_TERM_CURSOR_STYLES}
          onChange={setCursorStyle}
        />

        <SettingCheckbox
          label="Cursor Blink"
          checked={cursorBlink}
          onChange={setCursorBlink}
        />

        <div className={showKeyboardSettings ? 'mb-4' : ''}>
          <SettingSelect
            label="Scrollback Buffer"
            value={scrollback}
            onChange={(val) => setScrollback(val as ATermScrollback)}
            options={scrollbackOptions}
          />
        </div>

        {showKeyboardSettings && (
          <>
            <SettingButtonGroup
              label="Keyboard Input"
              value={keyboardMode}
              options={['custom', 'native'] as const}
              onChange={setKeyboardMode}
            />
            <SettingButtonGroup
              label={
                keyboardMode === 'native' ? 'Ribbon Size' : 'Keyboard Size'
              }
              value={keyboardSize}
              options={['small', 'medium', 'large'] as const}
              onChange={setKeyboardSize}
            />
            <SettingButtonGroup
              label={
                keyboardMode === 'native'
                  ? 'Ribbon Spacing'
                  : 'Keyboard Spacing'
              }
              value={keyboardSpacing}
              options={['tight', 'normal', 'roomy'] as const}
              onChange={setKeyboardSpacing}
            />
          </>
        )}

        <AgentToolsSettings />
      </SettingsPanel>
    </div>
  )
}

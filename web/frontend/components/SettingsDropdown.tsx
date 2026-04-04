'use client'

import { useCallback, useMemo, useRef } from 'react'
import {
  APP_THEME_OPTIONS,
  type AppThemePreference,
} from '@/lib/app-theme'
import { useAppTheme } from '@/lib/hooks/use-app-theme'
import {
  TERMINAL_CURSOR_STYLES,
  TERMINAL_FONT_SIZES,
  TERMINAL_FONTS,
  TERMINAL_SCROLLBACK_OPTIONS,
  TERMINAL_THEMES,
  type TerminalCursorStyle,
  type TerminalFontId,
  type TerminalFontSize,
  type TerminalScrollback,
  type TerminalThemeId,
} from '@/lib/hooks/use-terminal-settings'
import { useClickOutside } from '@/lib/hooks/use-click-outside'
import { SettingsButton } from './settings/SettingsButton'
import { SettingsPanel } from './settings/SettingsPanel'
import { SettingSelect } from './settings/SettingSelect'
import { SettingButtonGroup } from './settings/SettingButtonGroup'
import { AgentToolsSettings } from './settings/AgentToolsSettings'
import { SettingCheckbox } from './settings/SettingCheckbox'
import type { KeyboardSizePreset } from './keyboard/types'

export interface SettingsDropdownProps {
  fontId: TerminalFontId
  fontSize: TerminalFontSize
  scrollback: TerminalScrollback
  cursorStyle: TerminalCursorStyle
  cursorBlink: boolean
  themeId: TerminalThemeId
  setFontId: (id: TerminalFontId) => void
  setFontSize: (size: TerminalFontSize) => void
  setScrollback: (scrollback: TerminalScrollback) => void
  setCursorStyle: (style: TerminalCursorStyle) => void
  setCursorBlink: (blink: boolean) => void
  setThemeId: (id: TerminalThemeId) => void
  showSettings: boolean
  setShowSettings: (show: boolean) => void
  keyboardSize?: KeyboardSizePreset
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
  keyboardSize,
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
  const fontOptions = TERMINAL_FONTS.map((font) => ({
    value: font.id,
    label: font.name,
  }))

  const fontSizeOptions = TERMINAL_FONT_SIZES.map((size) => ({
    value: size,
    label: `${size}px`,
  }))

  const themeOptions = Object.entries(TERMINAL_THEMES).map(([id, { name }]) => ({
    value: id,
    label: name,
  }))

  const appThemeOptions = APP_THEME_OPTIONS.map((option) => ({
    value: option.value,
    label: option.label,
  }))

  const scrollbackOptions = TERMINAL_SCROLLBACK_OPTIONS.map((opt) => ({
    value: opt.value,
    label: opt.label,
  }))

  const showKeyboardSettings = isMobile && keyboardSize !== undefined && setKeyboardSize

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
          onChange={(val) => setFontId(val as TerminalFontId)}
          options={fontOptions}
        />

        <SettingSelect
          label="Font Size"
          value={fontSize}
          onChange={(val) => setFontSize(val as TerminalFontSize)}
          options={fontSizeOptions}
        />

        <SettingSelect
          label="App Theme"
          value={themePreference}
          onChange={(val) => setThemePreference(val as AppThemePreference)}
          options={appThemeOptions}
        />

        <SettingSelect
          label="Terminal Theme"
          value={themeId}
          onChange={(val) => setThemeId(val as TerminalThemeId)}
          options={themeOptions}
        />

        <SettingButtonGroup
          label="Cursor Style"
          value={cursorStyle}
          options={TERMINAL_CURSOR_STYLES}
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
            onChange={(val) => setScrollback(val as TerminalScrollback)}
            options={scrollbackOptions}
          />
        </div>

        {showKeyboardSettings && (
          <SettingButtonGroup
            label="Keyboard Size"
            value={keyboardSize}
            options={['small', 'medium', 'large'] as const}
            onChange={setKeyboardSize}
          />
        )}

        <AgentToolsSettings />
      </SettingsPanel>
    </div>
  )
}

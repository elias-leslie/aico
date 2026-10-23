'use client'

import { useCallback, useMemo, useRef } from 'react'
import {
  A_TERM_FONT_SIZES,
  type ATermFontSize,
} from '@/lib/hooks/use-a-term-settings'
import { useClickOutside } from '@/lib/hooks/use-click-outside'
import { AgentToolsSettings } from './settings/AgentToolsSettings'
import { MemoryPolicySettings } from './settings/MemoryPolicySettings'
import { SettingSelect } from './settings/SettingSelect'
import { SettingsButton } from './settings/SettingsButton'
import { SettingsPanel } from './settings/SettingsPanel'

export interface SettingsDropdownProps {
  fontSize: ATermFontSize
  setFontSize: (size: ATermFontSize) => void
  showSettings: boolean
  setShowSettings: (show: boolean) => void
  renderTrigger?: boolean
}

export function SettingsDropdown({
  fontSize,
  setFontSize,
  showSettings,
  setShowSettings,
  renderTrigger = true,
}: SettingsDropdownProps) {
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
  const fontSizeOptions = A_TERM_FONT_SIZES.map((size) => ({
    value: size,
    label: `${size}px`,
  }))

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
          label="Font Size"
          value={fontSize}
          onChange={(val) => setFontSize(val as ATermFontSize)}
          options={fontSizeOptions}
        />

        <AgentToolsSettings />

        <MemoryPolicySettings />
      </SettingsPanel>
    </div>
  )
}

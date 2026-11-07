import { BookOpen, KeyRound, Smartphone, Undo2, UserRound } from 'lucide-react'
import type { ComponentType } from 'react'

export interface SettingsPlace {
  label: string
  href: string
  /** What the page is for, in a few words. */
  hint: string
  icon: ComponentType<{ className?: string; strokeWidth?: number }>
}

/** The setup places, touched a few times a year: the Settings menu, the phone's Settings page and Full's side list all list these, in this order. */
export const SETTINGS_PLACES: readonly SettingsPlace[] = [
  { label: 'Logins', href: '/logins', hint: 'agent sign-ins', icon: UserRound },
  {
    label: 'Grants',
    href: '/grants',
    hint: 'access requests and history',
    icon: KeyRound,
  },
  {
    label: 'Recovery',
    href: '/recovery',
    hint: 'bring back stopped sessions',
    icon: Undo2,
  },
  {
    label: 'Context',
    href: '/agents',
    hint: 'what agents are told',
    icon: BookOpen,
  },
  {
    label: 'Phone app',
    href: '/app',
    hint: 'install and pair',
    icon: Smartphone,
  },
]

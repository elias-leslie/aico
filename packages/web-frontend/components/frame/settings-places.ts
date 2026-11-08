import {
  Bell,
  BookOpen,
  KeyRound,
  Smartphone,
  Undo2,
  UserRound,
} from 'lucide-react'
import type { ComponentType } from 'react'

export interface SettingsPlace {
  label: string
  href: string
  /** What the page is for, in a few words. */
  hint: string
  icon: ComponentType<{ className?: string; strokeWidth?: number }>
}

/** The setup places, touched a few times a year: the Settings menu, the phone's Settings page and the Settings dialog's own list all show these, in this order. */
export const SETTINGS_PLACES: readonly SettingsPlace[] = [
  {
    label: 'Notifications',
    href: '/notifications',
    hint: 'what reaches your phone and desktop',
    icon: Bell,
  },
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

/** The setup place a path opens (`/logins`, `/logins/`), or undefined for any other page. Settings opens as a dialog over the session, not as a page on the left side. */
export function settingsPlaceAt(pathname: string): SettingsPlace | undefined {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  return SETTINGS_PLACES.find((place) => place.href === path)
}

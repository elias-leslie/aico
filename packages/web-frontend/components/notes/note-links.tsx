'use client'

import { createContext, useContext } from 'react'
import { type NoteLinks, noteLinks } from '@/lib/api/notes'

const NoteLinksContext = createContext<NoteLinks>(noteLinks('/notes'))

/** Where Notes' links go: its own page, unless a host (the Workbench) says otherwise. */
export const NoteLinksProvider = NoteLinksContext.Provider
export const useNoteLinks = () => useContext(NoteLinksContext)

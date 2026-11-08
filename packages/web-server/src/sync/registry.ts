// What syncs: the tables of notes.db and the view state in web.db. Adding a
// table here (with the sync columns in its migration) is all a new synced
// table takes. A synced table has no foreign keys; the app keeps the links.

import type { SyncTable } from './engine'

export const NOTES_SYNC_TABLES: readonly SyncTable[] = [
  { name: 'captures', keys: ['id'], unique: ['client_id'], blob: 'hash', dropDuplicate: true },
  { name: 'notes', keys: ['id'], text: ['title', 'body'], unique: ['source'] },
  { name: 'note_items', keys: ['id'], text: ['text'] },
  { name: 'note_labels', keys: ['id'] },
  { name: 'attachments', keys: ['id'], blob: 'hash' },
  { name: 'note_revisions', keys: ['id'] },
]

// web.db tables already have an `updated_at` (project_settings, as text), so
// their clock is `sync_at`.
export const WEB_SYNC_TABLES: readonly SyncTable[] = [
  { name: 'panes', keys: ['id'], clock: 'sync_at' },
  { name: 'session_links', keys: ['session_id'], clock: 'sync_at' },
  { name: 'project_settings', keys: ['project_id'], clock: 'sync_at' },
  { name: 'session_seen', keys: ['session_id'], merge: { max: 'seen_at' } },
  { name: 'notice_choices', keys: ['choice'], clock: 'sync_at' },
]

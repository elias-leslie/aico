// context.db: what agents are told and launched with. This package owns the file
// (package.json aico.db); others ask through its functions or the `aico` CLI.
//
// - memories: the current text of each memory, its scope, tier and counters, with
//   an FTS5 index over summary, tags and content; memory_revisions keeps every
//   version written from here on (older Agent Hub revisions stay in its archive).
// - prompts and prompt_revisions: the same for reusable prompt text.
// - roles: the jobs agents launch as (with their per-tool launch rows) and the
//   role names kept from Agent Hub's agent rows; role_prompts links prompts to them.
// - launch_tools, launch_providers, launch_deny: the rest of the launch policy.
// - context_budgets, project_permissions, settings.

import { join } from 'node:path'
import { type Database, openDatabase } from '@aico/store'

export type { Database }

const MIGRATIONS = [
  `CREATE TABLE memories (
     id TEXT PRIMARY KEY,
     scope TEXT NOT NULL CHECK (scope IN ('global', 'project', 'agent')),
     scope_id TEXT NOT NULL DEFAULT '',
     tier TEXT NOT NULL CHECK (tier IN ('mandate', 'guardrail', 'reference', 'archive')),
     summary TEXT NOT NULL DEFAULT '',
     content TEXT NOT NULL,
     tags TEXT NOT NULL DEFAULT '[]',
     triggers TEXT NOT NULL DEFAULT '[]',
     applicability TEXT NOT NULL DEFAULT '{}',
     pinned INTEGER NOT NULL DEFAULT 0,
     render_mode TEXT,
     loaded_count INTEGER NOT NULL DEFAULT 0,
     helpful_count INTEGER NOT NULL DEFAULT 0,
     harmful_count INTEGER NOT NULL DEFAULT 0,
     version INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   ) STRICT;
   CREATE INDEX memories_scope ON memories (scope, scope_id);
   CREATE TABLE memory_revisions (
     memory_id TEXT NOT NULL,
     version INTEGER NOT NULL,
     doc TEXT NOT NULL,
     reason TEXT NOT NULL,
     at TEXT NOT NULL,
     PRIMARY KEY (memory_id, version)
   ) STRICT;
   CREATE VIRTUAL TABLE memories_fts USING fts5(
     summary, tags, content, content = 'memories', content_rowid = 'rowid',
     tokenize = 'porter unicode61'
   );
   CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
     INSERT INTO memories_fts (rowid, summary, tags, content)
     VALUES (new.rowid, new.summary, new.tags, new.content);
   END;
   CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
     INSERT INTO memories_fts (memories_fts, rowid, summary, tags, content)
     VALUES ('delete', old.rowid, old.summary, old.tags, old.content);
   END;
   CREATE TRIGGER memories_fts_update AFTER UPDATE ON memories BEGIN
     INSERT INTO memories_fts (memories_fts, rowid, summary, tags, content)
     VALUES ('delete', old.rowid, old.summary, old.tags, old.content);
     INSERT INTO memories_fts (rowid, summary, tags, content)
     VALUES (new.rowid, new.summary, new.tags, new.content);
   END;
   CREATE TABLE prompts (
     id INTEGER PRIMARY KEY,
     slug TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     content TEXT NOT NULL,
     kind TEXT NOT NULL,
     is_global INTEGER NOT NULL DEFAULT 0,
     boot_eligible INTEGER NOT NULL DEFAULT 0,
     context_policy TEXT,
     version INTEGER NOT NULL DEFAULT 1,
     updated_at TEXT NOT NULL
   ) STRICT;
   CREATE TABLE prompt_revisions (
     prompt_id INTEGER NOT NULL,
     version INTEGER NOT NULL,
     content TEXT NOT NULL,
     reason TEXT NOT NULL,
     at TEXT NOT NULL,
     PRIMARY KEY (prompt_id, version)
   ) STRICT;
   CREATE TABLE roles (
     name TEXT PRIMARY KEY,
     label TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     work_roles TEXT NOT NULL DEFAULT '[]',
     context TEXT,
     subagent TEXT,
     tools TEXT NOT NULL DEFAULT '{}',
     position INTEGER NOT NULL,
     updated_at TEXT NOT NULL
   ) STRICT;
   CREATE TABLE role_prompts (
     role TEXT NOT NULL REFERENCES roles (name) ON DELETE CASCADE,
     prompt_id INTEGER NOT NULL REFERENCES prompts (id) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     PRIMARY KEY (role, prompt_id)
   ) STRICT;
   CREATE TABLE launch_tools (
     name TEXT PRIMARY KEY,
     label TEXT NOT NULL,
     usage_provider TEXT,
     note TEXT,
     default_row TEXT,
     position INTEGER NOT NULL
   ) STRICT;
   CREATE TABLE launch_providers (
     name TEXT PRIMARY KEY,
     label TEXT NOT NULL,
     tools TEXT NOT NULL DEFAULT '[]',
     catalog_providers TEXT NOT NULL DEFAULT '[]',
     name_tokens TEXT NOT NULL DEFAULT '[]',
     why TEXT NOT NULL DEFAULT ''
   ) STRICT;
   CREATE TABLE launch_deny (
     position INTEGER PRIMARY KEY,
     jobs TEXT,
     work_roles TEXT,
     projects TEXT,
     provider TEXT NOT NULL,
     reason TEXT NOT NULL,
     source TEXT NOT NULL
   ) STRICT;
   CREATE TABLE context_budgets (
     harness TEXT NOT NULL,
     role TEXT NOT NULL,
     warn_tokens INTEGER NOT NULL,
     jump_pct INTEGER,
     note TEXT,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (harness, role)
   ) STRICT;
   CREATE TABLE project_permissions (
     id INTEGER PRIMARY KEY,
     project_id TEXT NOT NULL,
     root_path TEXT,
     updated_at TEXT,
     created_at TEXT,
     daily_cost_budget_usd REAL,
     monthly_cost_budget_usd REAL,
     budget_alert_threshold REAL
   ) STRICT;
   CREATE TABLE settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   ) STRICT;`,
]

/** The context DB file in a data directory. */
export function contextDbPath(dataDir: string): string {
  return join(dataDir, 'context.db')
}

/** Opens (creating and migrating) context.db; `':memory:'` for tests. */
export function openContext(path: string): Database {
  const db = openDatabase(path, MIGRATIONS)
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

/** A settings value (JSON), or undefined. */
export function getSetting<T>(db: Database, key: string): T | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row ? (JSON.parse(row.value) as T) : undefined
}

export function putSetting(db: Database, key: string, value: unknown): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  ).run(key, JSON.stringify(value))
}

/** JSON text from a column, or `fallback` when it is null. */
export function json<T>(text: unknown, fallback: T): T {
  return typeof text === 'string' ? (JSON.parse(text) as T) : fallback
}

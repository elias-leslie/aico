// context.db: what agents are told and launched with. This package owns the file
// (package.json aico.db); others ask through its functions or the `aico` CLI.
//
// - memories: the current text of each memory, its scope, tier and counters, with
//   an FTS5 index over summary, tags and content; memory_revisions keeps every
//   version written from here on (older revisions stay in the Agent Hub archive).
// - prompts and prompt_revisions: the same for reusable prompt text.
// - roles: the jobs agents launch as (with their per-tool launch rows) and the
//   named roles; role_prompts links prompts to them.
// - launch_tools, launch_providers, launch_deny: the rest of the launch policy.
// - context_budgets, project_permissions, settings.
// - deliveries and delivery_items: what each context delivery loaded into a
//   session, item by item with its size (deliver.ts), for the context cost view.

import { statSync } from 'node:fs'
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
  // Context delivery inventory (deliver.ts): one row per delivery that reached a
  // session, one item row per prompt, memory or computed block it held or cut.
  `CREATE TABLE deliveries (
     id INTEGER PRIMARY KEY,
     at TEXT NOT NULL,
     tool TEXT NOT NULL,
     project TEXT,
     session TEXT,
     role TEXT,
     channel TEXT NOT NULL,
     hash TEXT NOT NULL,
     bytes INTEGER NOT NULL,
     budget INTEGER NOT NULL,
     over INTEGER NOT NULL DEFAULT 0,
     missing TEXT NOT NULL DEFAULT '[]'
   ) STRICT;
   CREATE INDEX deliveries_at ON deliveries (at);
   CREATE TABLE delivery_items (
     delivery_id INTEGER NOT NULL REFERENCES deliveries (id) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     section TEXT NOT NULL,
     kind TEXT NOT NULL,
     item TEXT NOT NULL,
     bytes INTEGER NOT NULL,
     cut INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (delivery_id, position)
   ) STRICT;`,
  `ALTER TABLE delivery_items ADD COLUMN title TEXT;
   ALTER TABLE delivery_items ADD COLUMN item_type TEXT;
   ALTER TABLE delivery_items ADD COLUMN content_hash TEXT;
   CREATE TABLE context_observations (
     delivery_id INTEGER PRIMARY KEY REFERENCES deliveries(id) ON DELETE CASCADE,
     observed_at TEXT NOT NULL,
     complete INTEGER NOT NULL,
     source TEXT NOT NULL
   ) STRICT;
   CREATE TABLE context_uses (
     delivery_id INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
     item TEXT NOT NULL,
     at TEXT NOT NULL,
     evidence TEXT NOT NULL,
     PRIMARY KEY(delivery_id, item)
   ) STRICT;
   CREATE TABLE context_local_edits (
     kind TEXT NOT NULL,
     item TEXT NOT NULL,
     PRIMARY KEY(kind, item)
   ) STRICT;`,
  // Version 3 may already have been opened by the source CLI before rollout.
  // Keep this later review fix in a new migration for those live files too.
  `CREATE TABLE IF NOT EXISTS role_context_overrides (
     role TEXT PRIMARY KEY REFERENCES roles(name) ON DELETE CASCADE,
     mode TEXT NOT NULL CHECK (mode IN ('default', 'blank-slate'))
   ) STRICT;`,
  // The session's context fill (its latest model call's prompt tokens) as last observed.
  (db: Database) => {
    const has = db
      .prepare(
        "SELECT 1 FROM pragma_table_info('context_observations') WHERE name = 'context_tokens'",
      )
      .get()
    if (!has) db.exec('ALTER TABLE context_observations ADD COLUMN context_tokens INTEGER')
  },
  // Agent Hub is retired: its import (and the local-edit marks that guarded edits from
  // it) is gone, and its chat launch row is now the row for Aico's own agent.
  `DROP TABLE IF EXISTS context_local_edits;
   UPDATE launch_tools SET name = 'aico-agent', label = 'Aico agent',
     default_row = json_set(default_row, '$.why', 'Aico''s own agent (aico agent run); pass --model.')
     WHERE name = 'agent-hub';
   UPDATE settings SET value = replace(replace(replace(value,
       'the Agent Hub work roles (session_roles.json)', 'the work roles'),
       'full = Agent Hub delivery in the project', 'full = Aico''s context delivery in the project'),
       'Agent Hub agent sessions with a denied work role', 'Aico agent sessions with a denied work role')
     WHERE key = 'launch';`,
  // Owner 2026-11-08: routine agent work runs on the Antigravity subscription. Aico launches it
  // under the limits in native/hook/data/leash.json.
  `UPDATE launch_tools SET
     note = 'Owner 2026-11-08: routine maintenance and small fixes. Runs under Aico''s limits (no tmux, kill, root, deploys, sessions, credentials or changes outside its project), so never coordinators, hunting, or hook, guard, root, secrets or deletion code. Check its work before relying on it.',
     default_row = '{"model":"gemini-3.8-flash-high","effort":null,"alternates":[{"model":"gemini-4-argon-high","effort":null,"when":"Flash got lost, or the job takes more thought than a small well-scoped fix"}],"why":"Owner 2026-11-08: routine agent work uses the Antigravity subscription. Flash did small fixes and a service diagnosis correctly in trials."}'
     WHERE name = 'antigravity';`,
  // Trial 2026-11-08, same small change: Argon took 33 model calls and stayed in scope; Flash
  // took about 190, built three mappings and committed changes to unrelated code to pass a check.
  `UPDATE launch_tools SET
     default_row = '{"model":"gemini-4-argon-high","effort":null,"alternates":[{"model":"gemini-3.8-flash-high","effort":null,"when":"A diagnosis, or a one-line fix"}],"why":"Owner 2026-11-08: routine agent work uses the Antigravity subscription. In trials Argon made a small change in scope; Flash wandered and changed unrelated code to pass a check."}'
     WHERE name = 'antigravity';`,
  // Antigravity's limits refuse st aico, so it can't coordinate; hunting stays where it was
  // before Antigravity became launchable.
  `INSERT OR IGNORE INTO launch_providers (name, label, tools, why)
     VALUES ('antigravity', 'Antigravity', '["antigravity"]', 'Sessions run under Aico''s limits for weak agents.');
   INSERT INTO launch_deny (position, jobs, provider, reason, source)
     SELECT (SELECT COALESCE(MAX(position), 0) + 1 FROM launch_deny), '["coordinator","hunting","recon"]', 'antigravity',
       'Antigravity runs under limits that stop it starting or managing sessions, and it is not for hunting or recon.',
       'Usage-burn lane 13, 2026-11-08'
     WHERE NOT EXISTS (SELECT 1 FROM launch_deny WHERE provider = 'antigravity');`,
  // The route reads "(when ...)": a capital A read as a stray letter.
  `UPDATE launch_tools SET
     default_row = replace(default_row, '"when":"A diagnosis, or', '"when":"a diagnosis, or')
     WHERE name = 'antigravity';`,
]

/** The context DB file in a data directory. */
export function contextDbPath(dataDir: string): string {
  return join(dataDir, 'context.db')
}

/** Changes whenever context.db is written: a cache key for what is derived from it. */
export function contextSignature(dataDir: string): string {
  const file = contextDbPath(dataDir)
  return [file, `${file}-wal`]
    .map((path) => {
      try {
        const stat = statSync(path)
        return `${stat.mtimeMs}:${stat.size}`
      } catch {
        return '-'
      }
    })
    .join('|')
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

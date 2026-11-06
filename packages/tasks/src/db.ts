// tasks.db: the projects registry. This package owns the file (package.json aico.db); others ask it
// through this package. The task system's tables (tasks, subtasks, claims, task log) were dropped by
// the second migration; per-project plans live in ROADMAP.md at each repo root. Times are epoch milliseconds.

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { type Database, type Migration, openDatabase } from '@aico/store'

export type { Database }

const MIGRATIONS: Migration[] = [
  `CREATE TABLE projects (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     root_path TEXT,
     category TEXT,
     base_url TEXT,
     public_url TEXT,
     health_endpoint TEXT,
     frontend_port INTEGER,
     backend_port INTEGER,
     sidebar_rank INTEGER,
     backend_dir TEXT,
     browser_scripts_dir TEXT,
     data_dir TEXT,
     agent_configs TEXT NOT NULL DEFAULT '{}',
     test_config TEXT NOT NULL DEFAULT '{}',
     created_at INTEGER NOT NULL,
     retired_at INTEGER,
     retired_reason TEXT
   ) STRICT;
   CREATE TABLE project_events (
     id INTEGER PRIMARY KEY,
     project_id TEXT NOT NULL,
     action TEXT NOT NULL CHECK (action IN ('registered', 'retired', 'reactivated')),
     owner_email TEXT,
     reason TEXT,
     recorded_at INTEGER NOT NULL
   ) STRICT;
   CREATE INDEX project_events_project ON project_events (project_id, id);
   CREATE TABLE tasks (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     parent_task_id TEXT,
     title TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL CHECK (status IN
       ('pending', 'running', 'paused', 'completed', 'failed', 'abandoned')),
     task_type TEXT NOT NULL DEFAULT 'task',
     priority INTEGER NOT NULL DEFAULT 2,
     labels TEXT NOT NULL DEFAULT '[]',
     complexity TEXT,
     acceptance TEXT NOT NULL DEFAULT '[]',
     plan TEXT,
     summary TEXT,
     outcome TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     started_at INTEGER,
     completed_at INTEGER,
     imported_from TEXT
   ) STRICT;
   CREATE INDEX tasks_project_status ON tasks (project_id, status);
   CREATE TABLE subtasks (
     task_id TEXT NOT NULL,
     ref TEXT NOT NULL,
     phase TEXT,
     description TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed')),
     summary TEXT,
     position INTEGER NOT NULL,
     completed_at INTEGER,
     PRIMARY KEY (task_id, ref)
   ) STRICT;
   CREATE TABLE task_blockers (
     task_id TEXT NOT NULL,
     blocked_by TEXT NOT NULL,
     PRIMARY KEY (task_id, blocked_by)
   ) STRICT;
   -- One open claim (released_at NULL) per task, or per subtask ('' is the task itself); a
   -- released claim stays as history.
   CREATE TABLE claims (
     id INTEGER PRIMARY KEY,
     task_id TEXT NOT NULL,
     subtask TEXT NOT NULL DEFAULT '',
     owner TEXT NOT NULL,
     session_id TEXT,
     claimed_at INTEGER NOT NULL,
     released_at INTEGER,
     release_reason TEXT
   ) STRICT;
   CREATE UNIQUE INDEX claims_one_owner ON claims (task_id, subtask) WHERE released_at IS NULL;
   CREATE TABLE task_log (
     id INTEGER PRIMARY KEY,
     task_id TEXT NOT NULL,
     at INTEGER NOT NULL,
     message TEXT NOT NULL
   ) STRICT;
   CREATE INDEX task_log_task ON task_log (task_id, id);
   -- session_id is the session history id when the claim knew it (claude-code:UUID), else the
   -- Tether session id; tether_session is the Tether session id when there was one.
   CREATE TABLE task_sessions (
     task_id TEXT NOT NULL,
     session_id TEXT NOT NULL,
     tether_session TEXT,
     linked_at INTEGER NOT NULL,
     PRIMARY KEY (task_id, session_id)
   ) STRICT;
   CREATE INDEX task_sessions_session ON task_sessions (session_id)`,
  `DROP TABLE task_sessions;
   DROP TABLE task_log;
   DROP TABLE claims;
   DROP TABLE task_blockers;
   DROP TABLE subtasks;
   DROP TABLE tasks`,
]

/** The tasks DB file in a data directory. */
export function tasksDbPath(dataDir: string): string {
  return join(dataDir, 'tasks.db')
}

/** Opens (creating when missing) and migrates `path`; `':memory:'` for tests. */
export function openTasksDb(path: string): Database {
  return openDatabase(path, MIGRATIONS)
}

/** AICO_TASKS_DB, else tasks.db in AICO_DATA_DIR or ~/.local/state/aico (where the other Aico DBs live). */
export function tasksDbPathFromEnv(env: NodeJS.ProcessEnv): string {
  if (env.AICO_TASKS_DB?.trim()) return env.AICO_TASKS_DB.trim()
  const dataDir = resolve(
    env.AICO_DATA_DIR?.trim() ||
      join(env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state'), 'aico'),
  )
  return tasksDbPath(dataDir)
}

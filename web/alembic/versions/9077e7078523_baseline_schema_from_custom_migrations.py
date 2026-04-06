"""baseline schema from custom migrations

Defines the full a_term schema as of the initial Alembic adoption.
Uses IF NOT EXISTS / IF EXISTS guards so it is safe to run against
databases where the tables were already created manually.

Tables:
  - a_term_sessions
  - a_term_project_settings
  - a_term_panes

Revision ID: 9077e7078523
Revises:
Create Date: 2026-02-08 11:59:24.138872

"""
from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "9077e7078523"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# ---------------------------------------------------------------------------
# Table names
# ---------------------------------------------------------------------------
TBL_SESSIONS = "a_term_sessions"
TBL_PROJECT_SETTINGS = "a_term_project_settings"
TBL_PANES = "a_term_panes"

# ---------------------------------------------------------------------------
# Index names
# ---------------------------------------------------------------------------
IDX_SESSIONS_ALIVE = "idx_a_term_sessions_alive"
IDX_SESSIONS_PROJECT = "idx_a_term_sessions_project"
IDX_TPS_ENABLED = "idx_tps_enabled"
IDX_PANES_PROJECT_ID = "idx_a_term_panes_project_id"
IDX_PANES_ORDER = "idx_a_term_panes_order"

# ---------------------------------------------------------------------------
# Constraint names
# ---------------------------------------------------------------------------
CHK_PANE_PROJECT = "chk_project_pane_id"

# ---------------------------------------------------------------------------
# Allowed enum values
# ---------------------------------------------------------------------------
MODE_VALUES = "'shell', 'claude'"
CLAUDE_STATE_VALUES = "'not_started', 'starting', 'running', 'stopped', 'error'"
PANE_TYPE_VALUES = "'project', 'adhoc'"


# ---------------------------------------------------------------------------
# upgrade helpers
# ---------------------------------------------------------------------------

def _create_sessions_table() -> None:
    """Create a_term_sessions table and its indexes."""
    op.execute(f"""
        CREATE TABLE IF NOT EXISTS {TBL_SESSIONS} (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name            VARCHAR(255) NOT NULL,
            user_id         VARCHAR(255),
            project_id      VARCHAR(64),
            working_dir     TEXT,
            display_order   INTEGER DEFAULT 0,
            mode            VARCHAR(16) DEFAULT 'shell'
                            CHECK (mode IN ({MODE_VALUES})),
            session_number  INTEGER DEFAULT 1,
            is_alive        BOOLEAN DEFAULT true,
            created_at      TIMESTAMPTZ DEFAULT NOW(),
            last_accessed_at TIMESTAMPTZ DEFAULT NOW(),
            last_claude_session VARCHAR(255),
            claude_state    VARCHAR(16) DEFAULT 'not_started'
                            CHECK (claude_state IN (
                                {CLAUDE_STATE_VALUES}
                            ))
        );
    """)

    op.execute(f"""
        CREATE INDEX IF NOT EXISTS {IDX_SESSIONS_ALIVE}
            ON {TBL_SESSIONS}(is_alive) WHERE is_alive = true;
    """)

    op.execute(f"""
        CREATE INDEX IF NOT EXISTS {IDX_SESSIONS_PROJECT}
            ON {TBL_SESSIONS}(project_id) WHERE project_id IS NOT NULL;
    """)


def _create_project_settings_table() -> None:
    """Create a_term_project_settings table, its index, and comment."""
    op.execute(f"""
        CREATE TABLE IF NOT EXISTS {TBL_PROJECT_SETTINGS} (
            project_id   VARCHAR(64) PRIMARY KEY,
            enabled      BOOLEAN NOT NULL DEFAULT false,
            active_mode  VARCHAR(16) NOT NULL DEFAULT 'shell'
                         CHECK (active_mode IN ({MODE_VALUES})),
            display_order INTEGER NOT NULL DEFAULT 0,
            created_at   TIMESTAMPTZ DEFAULT NOW(),
            updated_at   TIMESTAMPTZ DEFAULT NOW()
        );
    """)

    op.execute(f"""
        CREATE INDEX IF NOT EXISTS {IDX_TPS_ENABLED}
            ON {TBL_PROJECT_SETTINGS}(enabled) WHERE enabled = true;
    """)

    op.execute(f"""
        COMMENT ON TABLE {TBL_PROJECT_SETTINGS}
            IS 'A-Term settings per SummitFlow project';
    """)


def _create_panes_table() -> None:
    """Create a_term_panes table, its indexes, and comment."""
    op.execute(f"""
        CREATE TABLE IF NOT EXISTS {TBL_PANES} (
            id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            pane_type    VARCHAR(10) NOT NULL
                         CHECK (pane_type IN ({PANE_TYPE_VALUES})),
            project_id   VARCHAR(64),
            pane_order   INTEGER NOT NULL DEFAULT 0,
            pane_name    VARCHAR(255) NOT NULL,
            active_mode  VARCHAR(16) NOT NULL DEFAULT 'shell'
                         CHECK (active_mode IN ({MODE_VALUES})),
            created_at   TIMESTAMPTZ DEFAULT NOW(),
            CONSTRAINT {CHK_PANE_PROJECT} CHECK (
                (pane_type = 'adhoc'   AND project_id IS NULL) OR
                (pane_type = 'project' AND project_id IS NOT NULL)
            )
        );
    """)

    op.execute(f"""
        CREATE INDEX IF NOT EXISTS {IDX_PANES_PROJECT_ID}
            ON {TBL_PANES}(project_id) WHERE project_id IS NOT NULL;
    """)

    op.execute(f"""
        CREATE INDEX IF NOT EXISTS {IDX_PANES_ORDER}
            ON {TBL_PANES}(pane_order);
    """)

    op.execute(f"""
        COMMENT ON TABLE {TBL_PANES}
            IS 'A-Term panes - containers for 1-2 sessions (shell/claude)';
    """)


# ---------------------------------------------------------------------------
# downgrade helpers
# ---------------------------------------------------------------------------

def _drop_panes_table() -> None:
    """Drop a_term_panes indexes and table."""
    op.execute(f"DROP INDEX IF EXISTS {IDX_PANES_ORDER};")
    op.execute(f"DROP INDEX IF EXISTS {IDX_PANES_PROJECT_ID};")
    op.execute(f"DROP TABLE IF EXISTS {TBL_PANES};")


def _drop_project_settings_table() -> None:
    """Drop a_term_project_settings index and table."""
    op.execute(f"DROP INDEX IF EXISTS {IDX_TPS_ENABLED};")
    op.execute(f"DROP TABLE IF EXISTS {TBL_PROJECT_SETTINGS};")


def _drop_sessions_table() -> None:
    """Drop a_term_sessions indexes and table."""
    op.execute(f"DROP INDEX IF EXISTS {IDX_SESSIONS_PROJECT};")
    op.execute(f"DROP INDEX IF EXISTS {IDX_SESSIONS_ALIVE};")
    op.execute(f"DROP TABLE IF EXISTS {TBL_SESSIONS};")


# ---------------------------------------------------------------------------
# Alembic entry points
# ---------------------------------------------------------------------------

def upgrade() -> None:
    """Create all a_term tables, indexes, and constraints."""
    _create_sessions_table()
    _create_project_settings_table()
    _create_panes_table()


def downgrade() -> None:
    """Drop all a_term tables in reverse dependency order."""
    # Drop indexes explicitly first (they go away with the tables, but
    # being explicit makes partial rollback clearer).
    _drop_panes_table()
    _drop_project_settings_table()
    _drop_sessions_table()

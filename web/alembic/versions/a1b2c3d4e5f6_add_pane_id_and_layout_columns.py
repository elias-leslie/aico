"""add pane_id and layout columns

Syncs Alembic with production schema:
- a_term_sessions: add pane_id FK to a_term_panes with ON DELETE SET NULL
- a_term_panes: add width_percent, height_percent, grid_row, grid_col

These columns were added manually before Alembic adoption.
Uses IF NOT EXISTS / IF EXISTS guards for idempotent re-runs.

Revision ID: a1b2c3d4e5f6
Revises: 9077e7078523
Create Date: 2026-02-26 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a1b2c3d4e5f6"
down_revision: str | Sequence[str] | None = "9077e7078523"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add pane_id FK and layout columns."""
    # --- a_term_sessions.pane_id ---
    op.execute("""
        ALTER TABLE a_term_sessions
        ADD COLUMN IF NOT EXISTS pane_id UUID;
    """)

    # Add FK with ON DELETE SET NULL (deleting a pane shouldn't cascade-delete sessions;
    # the app layer handles cleanup, and SET NULL preserves session data for recovery)
    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.table_constraints
                WHERE constraint_name = 'a_term_sessions_pane_id_fkey'
                  AND table_name = 'a_term_sessions'
            ) THEN
                ALTER TABLE a_term_sessions
                ADD CONSTRAINT a_term_sessions_pane_id_fkey
                FOREIGN KEY (pane_id) REFERENCES a_term_panes(id)
                ON DELETE SET NULL;
            END IF;
        END $$;
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_a_term_sessions_pane_id
        ON a_term_sessions(pane_id) WHERE pane_id IS NOT NULL;
    """)

    # --- a_term_panes layout columns ---
    op.execute("""
        ALTER TABLE a_term_panes
        ADD COLUMN IF NOT EXISTS width_percent  DOUBLE PRECISION DEFAULT 100.0,
        ADD COLUMN IF NOT EXISTS height_percent DOUBLE PRECISION DEFAULT 100.0,
        ADD COLUMN IF NOT EXISTS grid_row       INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS grid_col       INTEGER DEFAULT 0;
    """)


def downgrade() -> None:
    """Remove pane_id FK and layout columns."""
    op.execute("DROP INDEX IF EXISTS idx_a_term_sessions_pane_id;")

    op.execute("""
        ALTER TABLE a_term_sessions
        DROP CONSTRAINT IF EXISTS a_term_sessions_pane_id_fkey;
    """)

    op.execute("""
        ALTER TABLE a_term_sessions
        DROP COLUMN IF EXISTS pane_id;
    """)

    op.execute("""
        ALTER TABLE a_term_panes
        DROP COLUMN IF EXISTS width_percent,
        DROP COLUMN IF EXISTS height_percent,
        DROP COLUMN IF EXISTS grid_row,
        DROP COLUMN IF EXISTS grid_col;
    """)

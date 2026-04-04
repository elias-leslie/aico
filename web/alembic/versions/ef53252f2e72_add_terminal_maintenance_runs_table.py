"""add terminal maintenance runs table

Revision ID: ef53252f2e72
Revises: f3b12a7c9d4e
Create Date: 2026-03-11 10:55:03.870524

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "ef53252f2e72"
down_revision: str | Sequence[str] | None = "f3b12a7c9d4e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create durable maintenance run history."""
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS terminal_maintenance_runs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            reason VARCHAR(32) NOT NULL,
            status VARCHAR(16) NOT NULL CHECK (status IN ('running', 'success', 'skipped', 'failed')),
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            completed_at TIMESTAMPTZ,
            duration_ms DOUBLE PRECISION,
            reconciliation_purged INTEGER NOT NULL DEFAULT 0,
            reconciliation_orphans_killed INTEGER NOT NULL DEFAULT 0,
            upload_scanned_files INTEGER NOT NULL DEFAULT 0,
            upload_deleted_files INTEGER NOT NULL DEFAULT 0,
            upload_pruned_directories INTEGER NOT NULL DEFAULT 0,
            upload_errors INTEGER NOT NULL DEFAULT 0,
            orphaned_project_settings_deleted INTEGER NOT NULL DEFAULT 0,
            project_count INTEGER NOT NULL DEFAULT 0,
            default_agent_tool_slug VARCHAR(50),
            error TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_terminal_maintenance_runs_started_at
        ON terminal_maintenance_runs(started_at DESC);
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_terminal_maintenance_runs_status_started_at
        ON terminal_maintenance_runs(status, started_at DESC);
        """
    )


def downgrade() -> None:
    """Drop terminal maintenance run history."""
    op.execute("DROP INDEX IF EXISTS idx_terminal_maintenance_runs_status_started_at;")
    op.execute("DROP INDEX IF EXISTS idx_terminal_maintenance_runs_started_at;")
    op.execute("DROP TABLE IF EXISTS terminal_maintenance_runs;")

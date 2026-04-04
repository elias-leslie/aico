"""add CHECK constraints for state machines

Revision ID: 88a6d1a8fba4
Revises: b7d3e8f1a2c4
Create Date: 2026-03-22 14:39:35.941295

"""
from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '88a6d1a8fba4'
down_revision: str | Sequence[str] | None = 'b7d3e8f1a2c4'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_check_constraint(
        "ck_terminal_sessions_claude_state",
        "terminal_sessions",
        "claude_state IN ('not_started', 'starting', 'running', 'stopped', 'error')",
    )
    op.create_check_constraint(
        "ck_terminal_panes_pane_type",
        "terminal_panes",
        "pane_type IN ('project', 'adhoc')",
    )
    op.create_check_constraint(
        "ck_maintenance_runs_status",
        "terminal_maintenance_runs",
        "status IN ('running', 'success', 'skipped', 'failed')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_maintenance_runs_status", "terminal_maintenance_runs")
    op.drop_constraint("ck_terminal_panes_pane_type", "terminal_panes")
    op.drop_constraint("ck_terminal_sessions_claude_state", "terminal_sessions")

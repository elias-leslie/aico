"""harden maintenance indexes and agent-tool default enforcement

Revision ID: f3b12a7c9d4e
Revises: a0cb935635d0
Create Date: 2026-03-11 10:35:00.000000

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f3b12a7c9d4e"
down_revision: str | Sequence[str] | None = "a0cb935635d0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add indexes aligned to maintenance queries and enforce one default tool."""
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_aterm_sessions_project_mode_alive_created
        ON aterm_sessions(project_id, mode, is_alive, created_at DESC)
        WHERE project_id IS NOT NULL;
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_aterm_sessions_dead_last_accessed
        ON aterm_sessions(last_accessed_at)
        WHERE is_alive = false;
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_aterm_sessions_display_order_created
        ON aterm_sessions(display_order, created_at);
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_aterm_project_settings_display_order
        ON aterm_project_settings(display_order, project_id);
        """
    )
    op.execute(
        """
        DROP INDEX IF EXISTS idx_agent_tools_slug;
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_tools_single_default
        ON agent_tools(is_default)
        WHERE is_default = true;
        """
    )


def downgrade() -> None:
    """Remove maintenance indexes and restore the redundant slug index."""
    op.execute("DROP INDEX IF EXISTS uq_agent_tools_single_default;")
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_agent_tools_slug
        ON agent_tools(slug);
        """
    )
    op.execute("DROP INDEX IF EXISTS idx_aterm_project_settings_display_order;")
    op.execute("DROP INDEX IF EXISTS idx_aterm_sessions_display_order_created;")
    op.execute("DROP INDEX IF EXISTS idx_aterm_sessions_dead_last_accessed;")
    op.execute("DROP INDEX IF EXISTS idx_aterm_sessions_project_mode_alive_created;")

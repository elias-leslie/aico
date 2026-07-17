"""add Antigravity agent tool

Revision ID: b4c7d9e1f203
Revises: 54af2b7c91de
Create Date: 2026-07-17 17:05:00.000000

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b4c7d9e1f203"
down_revision: str | Sequence[str] | None = "54af2b7c91de"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Seed Google Antigravity CLI with its explicit auto-approval mode."""
    op.execute(
        """
        INSERT INTO agent_tools (
            name,
            slug,
            command,
            process_name,
            description,
            is_default,
            display_order,
            color,
            enabled
        )
        VALUES (
            'Antigravity',
            'agy',
            'agy --dangerously-skip-permissions',
            'agy',
            'Google Antigravity terminal coding agent',
            false,
            3,
            '#4F8DF7',
            true
        )
        ON CONFLICT (slug) DO UPDATE
        SET
            name = EXCLUDED.name,
            command = EXCLUDED.command,
            process_name = EXCLUDED.process_name,
            description = EXCLUDED.description,
            display_order = EXCLUDED.display_order,
            color = EXCLUDED.color,
            enabled = true,
            updated_at = NOW();
        """
    )


def downgrade() -> None:
    """Remove the Antigravity seed row."""
    op.execute("DELETE FROM agent_tools WHERE slug = 'agy';")

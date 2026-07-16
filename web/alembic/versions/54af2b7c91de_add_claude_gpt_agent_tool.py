"""add Claude GPT agent tool

Revision ID: 54af2b7c91de
Revises: 9b7d6c2a4e1f
Create Date: 2026-07-16 16:30:00.000000

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "54af2b7c91de"
down_revision: str | Sequence[str] | None = "9b7d6c2a4e1f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Seed Claude Code backed by GPT-5.6 through claude-code-proxy."""
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
            'Claude GPT',
            'claude-gpt',
            'claude-gpt --dangerously-skip-permissions',
            'claude',
            'Claude Code powered by GPT-5.6 through the local Codex proxy',
            false,
            1,
            '#10A37F',
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
    """Remove the Claude GPT agent tool."""
    op.execute("DELETE FROM agent_tools WHERE slug = 'claude-gpt';")

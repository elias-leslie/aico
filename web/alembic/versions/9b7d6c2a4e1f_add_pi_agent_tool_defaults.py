"""add pi agent tool defaults

Revision ID: 9b7d6c2a4e1f
Revises: 62d8f8c5f2b1
Create Date: 2026-04-29 16:10:00.000000

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "9b7d6c2a4e1f"
down_revision: str | Sequence[str] | None = "62d8f8c5f2b1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Seed Pi as an enabled agent tool."""
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
            'Pi',
            'pi',
            'pi',
            'pi-coding-agent',
            'Pi coding agent',
            false,
            5,
            '#EC4899',
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
    """Remove Pi seed row."""
    op.execute("DELETE FROM agent_tools WHERE slug = 'pi';")

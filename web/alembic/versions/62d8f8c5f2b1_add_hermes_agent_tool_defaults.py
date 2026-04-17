"""add hermes agent tool defaults

Revision ID: 62d8f8c5f2b1
Revises: 0eb6530a7ab7
Create Date: 2026-04-16 14:40:00.000000

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "62d8f8c5f2b1"
down_revision: str | Sequence[str] | None = "0eb6530a7ab7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Seed Hermes and normalize built-in Codex command defaults."""
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
            'Hermes',
            'hermes',
            'hermes',
            'hermes',
            'Nous Hermes multi-channel coding agent',
            false,
            4,
            '#F59E0B',
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
            enabled = true;
        """
    )
    op.execute(
        """
        UPDATE agent_tools
        SET command = 'codex --yolo',
            updated_at = NOW()
        WHERE slug = 'codex'
          AND process_name = 'codex'
          AND command = 'codex';
        """
    )


def downgrade() -> None:
    """Remove Hermes seed row and restore legacy built-in Codex default."""
    op.execute("DELETE FROM agent_tools WHERE slug = 'hermes';")
    op.execute(
        """
        UPDATE agent_tools
        SET command = 'codex',
            updated_at = NOW()
        WHERE slug = 'codex'
          AND process_name = 'codex'
          AND command = 'codex --yolo';
        """
    )

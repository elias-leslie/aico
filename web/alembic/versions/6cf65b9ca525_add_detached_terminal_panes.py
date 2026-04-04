"""add detached terminal panes

Revision ID: 6cf65b9ca525
Revises: ef53252f2e72
Create Date: 2026-03-18 19:58:51.841207

"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '6cf65b9ca525'
down_revision: str | Sequence[str] | None = 'ef53252f2e72'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "terminal_panes",
        sa.Column(
            "is_detached",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.create_index(
        "idx_terminal_panes_detached_order",
        "terminal_panes",
        ["is_detached", "pane_order"],
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("idx_terminal_panes_detached_order", table_name="terminal_panes")
    op.drop_column("terminal_panes", "is_detached")

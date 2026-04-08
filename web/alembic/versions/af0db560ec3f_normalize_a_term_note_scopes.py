"""normalize a-term note scopes

Revision ID: af0db560ec3f
Revises: 5cdb3c9dc987
Create Date: 2026-04-06 18:10:34.186481

"""
from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = 'af0db560ec3f'
down_revision: str | Sequence[str] | None = '5cdb3c9dc987'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Normalize legacy A-Term note scope identifiers to canonical names."""
    op.execute(
        """
        UPDATE a_term_notes
        SET project_scope = 'a-term'
        WHERE lower(project_scope) = 'terminal'
        """
    )


def downgrade() -> None:
    """Data normalization is intentionally not reversed."""

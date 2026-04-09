"""add local projects registry table

Revision ID: 0eb6530a7ab7
Revises: af0db560ec3f
Create Date: 2026-04-09 21:05:22.607399

"""
from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '0eb6530a7ab7'
down_revision: str | Sequence[str] | None = 'af0db560ec3f'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the standalone local projects registry table when absent."""
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS projects (
            id              TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            base_url        TEXT NOT NULL DEFAULT '',
            health_endpoint TEXT DEFAULT '/health',
            created_at      TIMESTAMPTZ DEFAULT NOW(),
            frontend_port   INTEGER DEFAULT 3002,
            backend_port    INTEGER DEFAULT 8002,
            root_path       TEXT,
            category        TEXT NOT NULL DEFAULT 'dev'
        );
        """
    )


def downgrade() -> None:
    """Drop the standalone local projects registry table."""
    op.execute("DROP TABLE IF EXISTS projects;")

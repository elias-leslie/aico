"""add_a_term_notes_tables

Revision ID: 5cdb3c9dc987
Revises: 5c128471688d
Create Date: 2026-04-06 16:41:21.976586

"""
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "5cdb3c9dc987"
down_revision: str | Sequence[str] | None = "5c128471688d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "a_term_notes",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("project_scope", sa.Text(), nullable=False, server_default="global"),
        sa.Column("type", sa.String(length=10), nullable=False, server_default="note"),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "tags",
            postgresql.ARRAY(sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::text[]"),
        ),
        sa.Column("pinned", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column(
            "metadata",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
        sa.CheckConstraint("type IN ('note', 'prompt')", name="ck_a_term_notes_type"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_a_term_notes_project_scope",
        "a_term_notes",
        ["project_scope"],
        unique=False,
    )
    op.create_index("idx_a_term_notes_type", "a_term_notes", ["type"], unique=False)
    op.create_index(
        "idx_a_term_notes_pinned",
        "a_term_notes",
        ["pinned"],
        unique=False,
        postgresql_where=sa.text("pinned = true"),
    )
    op.create_index(
        "idx_a_term_notes_created",
        "a_term_notes",
        [sa.text("created_at DESC")],
        unique=False,
    )
    op.create_index(
        "idx_a_term_notes_tags",
        "a_term_notes",
        ["tags"],
        unique=False,
        postgresql_using="gin",
    )

    op.create_table(
        "a_term_note_versions",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("note_id", sa.Text(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "tags",
            postgresql.ARRAY(sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::text[]"),
        ),
        sa.Column("change_source", sa.String(length=30), nullable=False, server_default="manual_edit"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
        sa.ForeignKeyConstraint(["note_id"], ["a_term_notes.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_a_term_note_versions_note",
        "a_term_note_versions",
        ["note_id", "version"],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("idx_a_term_note_versions_note", table_name="a_term_note_versions")
    op.drop_table("a_term_note_versions")
    op.drop_index("idx_a_term_notes_tags", table_name="a_term_notes", postgresql_using="gin")
    op.drop_index("idx_a_term_notes_created", table_name="a_term_notes")
    op.drop_index("idx_a_term_notes_pinned", table_name="a_term_notes")
    op.drop_index("idx_a_term_notes_type", table_name="a_term_notes")
    op.drop_index("idx_a_term_notes_project_scope", table_name="a_term_notes")
    op.drop_table("a_term_notes")

"""rename legacy schema to aterm

Revision ID: 363fd0ed6429
Revises: 88a6d1a8fba4
Create Date: 2026-04-05 13:59:00.313914

"""
from collections.abc import Sequence

from alembic import op


# revision identifiers, used by Alembic.
revision: str = "363fd0ed6429"
down_revision: str | Sequence[str] | None = "88a6d1a8fba4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


TABLE_RENAMES = [
    ("terminal_sessions", "aterm_sessions"),
    ("terminal_project_settings", "aterm_project_settings"),
    ("terminal_panes", "aterm_panes"),
    ("terminal_session_recordings", "aterm_session_recordings"),
    ("terminal_maintenance_runs", "aterm_maintenance_runs"),
]

INDEX_RENAMES = [
    ("idx_terminal_sessions_alive", "idx_aterm_sessions_alive"),
    ("idx_terminal_sessions_project", "idx_aterm_sessions_project"),
    ("idx_terminal_sessions_pane_id", "idx_aterm_sessions_pane_id"),
    (
        "idx_terminal_sessions_project_mode_alive_created",
        "idx_aterm_sessions_project_mode_alive_created",
    ),
    ("idx_terminal_sessions_dead_last_accessed", "idx_aterm_sessions_dead_last_accessed"),
    ("idx_terminal_sessions_display_order_created", "idx_aterm_sessions_display_order_created"),
    ("idx_terminal_sessions_user", "idx_aterm_sessions_user"),
    ("idx_terminal_panes_project_id", "idx_aterm_panes_project_id"),
    ("idx_terminal_panes_order", "idx_aterm_panes_order"),
    ("idx_terminal_panes_detached_order", "idx_aterm_panes_detached_order"),
    ("idx_terminal_project_settings_display_order", "idx_aterm_project_settings_display_order"),
    ("idx_terminal_maintenance_runs_started_at", "idx_aterm_maintenance_runs_started_at"),
    (
        "idx_terminal_maintenance_runs_status_started_at",
        "idx_aterm_maintenance_runs_status_started_at",
    ),
    ("idx_session_recordings_session_id", "idx_aterm_session_recordings_session_id"),
]

SEQUENCE_RENAMES = [
    ("terminal_session_recordings_id_seq", "aterm_session_recordings_id_seq"),
]

CONSTRAINT_RENAMES = {
    "aterm_sessions": [
        ("terminal_sessions_pkey", "aterm_sessions_pkey"),
        ("terminal_sessions_pane_id_fkey", "aterm_sessions_pane_id_fkey"),
        ("terminal_sessions_mode_check", "aterm_sessions_mode_check"),
        ("terminal_sessions_claude_state_check", "ck_aterm_sessions_claude_state"),
    ],
    "aterm_panes": [
        ("terminal_panes_pkey", "aterm_panes_pkey"),
        ("terminal_panes_active_mode_check", "aterm_panes_active_mode_check"),
        ("terminal_panes_pane_type_check", "ck_aterm_panes_pane_type"),
    ],
    "aterm_project_settings": [
        ("terminal_project_settings_pkey", "aterm_project_settings_pkey"),
        ("terminal_project_settings_active_mode_check", "aterm_project_settings_active_mode_check"),
    ],
    "aterm_session_recordings": [
        ("terminal_session_recordings_pkey", "aterm_session_recordings_pkey"),
        (
            "terminal_session_recordings_session_id_fkey",
            "aterm_session_recordings_session_id_fkey",
        ),
    ],
    "aterm_maintenance_runs": [
        ("terminal_maintenance_runs_pkey", "aterm_maintenance_runs_pkey"),
        ("terminal_maintenance_runs_status_check", "ck_aterm_maintenance_runs_status"),
    ],
}

TABLE_COMMENTS = {
    "aterm_project_settings": "A-Term settings per SummitFlow project",
    "aterm_panes": "A-Term panes - containers for 1-2 sessions (shell/claude)",
}


def _rename_table(old_name: str, new_name: str) -> None:
    op.execute(
        f"""
        DO $$
        BEGIN
            IF to_regclass('public.{old_name}') IS NOT NULL
               AND to_regclass('public.{new_name}') IS NULL THEN
                EXECUTE 'ALTER TABLE {old_name} RENAME TO {new_name}';
            END IF;
        END $$;
        """
    )


def _rename_index(old_name: str, new_name: str) -> None:
    op.execute(
        f"""
        DO $$
        BEGIN
            IF to_regclass('public.{old_name}') IS NOT NULL
               AND to_regclass('public.{new_name}') IS NULL THEN
                EXECUTE 'ALTER INDEX {old_name} RENAME TO {new_name}';
            END IF;
        END $$;
        """
    )


def _rename_sequence(old_name: str, new_name: str) -> None:
    op.execute(
        f"""
        DO $$
        BEGIN
            IF to_regclass('public.{old_name}') IS NOT NULL
               AND to_regclass('public.{new_name}') IS NULL THEN
                EXECUTE 'ALTER SEQUENCE {old_name} RENAME TO {new_name}';
            END IF;
        END $$;
        """
    )


def _rename_constraint(table_name: str, old_name: str, new_name: str) -> None:
    op.execute(
        f"""
        DO $$
        BEGIN
            IF to_regclass('public.{table_name}') IS NOT NULL
               AND EXISTS (
                    SELECT 1
                    FROM pg_constraint
                    WHERE conname = '{old_name}'
                      AND conrelid = to_regclass('public.{table_name}')
               )
               AND NOT EXISTS (
                    SELECT 1
                    FROM pg_constraint
                    WHERE conname = '{new_name}'
                      AND conrelid = to_regclass('public.{table_name}')
               ) THEN
                EXECUTE 'ALTER TABLE {table_name} RENAME CONSTRAINT {old_name} TO {new_name}';
            END IF;
        END $$;
        """
    )


def _set_table_comments() -> None:
    for table_name, comment in TABLE_COMMENTS.items():
        op.execute(f"COMMENT ON TABLE {table_name} IS '{comment}';")


def _set_recordings_sequence_default() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF to_regclass('public.aterm_session_recordings') IS NOT NULL
               AND to_regclass('public.aterm_session_recordings_id_seq') IS NOT NULL THEN
                ALTER TABLE aterm_session_recordings
                ALTER COLUMN id SET DEFAULT nextval('aterm_session_recordings_id_seq'::regclass);
                ALTER SEQUENCE aterm_session_recordings_id_seq
                OWNED BY aterm_session_recordings.id;
            END IF;
        END $$;
        """
    )


def upgrade() -> None:
    """Rename legacy schema objects to aterm-prefixed names."""
    for old_name, new_name in TABLE_RENAMES:
        _rename_table(old_name, new_name)

    for old_name, new_name in INDEX_RENAMES:
        _rename_index(old_name, new_name)

    for old_name, new_name in SEQUENCE_RENAMES:
        _rename_sequence(old_name, new_name)

    for table_name, renames in CONSTRAINT_RENAMES.items():
        for old_name, new_name in renames:
            _rename_constraint(table_name, old_name, new_name)

    _set_recordings_sequence_default()
    _set_table_comments()


def downgrade() -> None:
    """Rename aterm-prefixed schema objects back to legacy names."""
    for table_name, renames in CONSTRAINT_RENAMES.items():
        for old_name, new_name in reversed(renames):
            _rename_constraint(table_name, new_name, old_name)

    for old_name, new_name in reversed(SEQUENCE_RENAMES):
        _rename_sequence(new_name, old_name)

    for old_name, new_name in reversed(INDEX_RENAMES):
        _rename_index(new_name, old_name)

    for old_name, new_name in reversed(TABLE_RENAMES):
        _rename_table(new_name, old_name)

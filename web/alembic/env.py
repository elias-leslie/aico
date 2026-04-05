"""Alembic migration environment configuration for A-Term.

A-Term uses raw SQL queries (psycopg) without SQLAlchemy models,
so we don't use autogenerate. Migrations are written manually.

A-Term shares the summitflow database, so we use a separate
version table (aterm_alembic_version) to avoid conflicts.
"""

from logging.config import fileConfig

from sqlalchemy import engine_from_config, pool, text

from alembic import context
from aterm.config import DATABASE_URL as _APP_DB_URL

assert _APP_DB_URL, "DATABASE_URL env var required (set in repo .env.local, .env, or environment)"

config = context.config

# A-Term uses psycopg v3 (not psycopg2), so use the +psycopg dialect
_db_url = _APP_DB_URL.replace("postgresql://", "postgresql+psycopg://", 1)
config.set_main_option("sqlalchemy.url", _db_url)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = None

VERSION_TABLE = "aterm_alembic_version"
LEGACY_VERSION_TABLES = ("terminal_alembic_version",)


def _table_exists(connection, table_name: str) -> bool:
    return bool(
        connection.execute(
            text("SELECT to_regclass(:table_name) IS NOT NULL"),
            {"table_name": f"public.{table_name}"},
        ).scalar()
    )


def _ensure_canonical_version_table(connection) -> None:
    if _table_exists(connection, VERSION_TABLE):
        return

    legacy_table = next(
        (table_name for table_name in LEGACY_VERSION_TABLES if _table_exists(connection, table_name)),
        None,
    )
    if legacy_table is None:
        return

    connection.execute(text(f'ALTER TABLE "{legacy_table}" RENAME TO "{VERSION_TABLE}"'))
    connection.execute(
        text(
            f"""
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1
                    FROM pg_constraint
                    WHERE conname = '{legacy_table}_pkc'
                ) THEN
                    ALTER TABLE "{VERSION_TABLE}"
                    RENAME CONSTRAINT "{legacy_table}_pkc" TO "{VERSION_TABLE}_pkc";
                ELSIF EXISTS (
                    SELECT 1
                    FROM pg_constraint
                    WHERE conname = '{legacy_table}_pkey'
                ) THEN
                    ALTER TABLE "{VERSION_TABLE}"
                    RENAME CONSTRAINT "{legacy_table}_pkey" TO "{VERSION_TABLE}_pkey";
                END IF;
            END $$;
            """
        )
    )


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode."""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        version_table=VERSION_TABLE,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode."""
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        _ensure_canonical_version_table(connection)
        # SQLAlchemy 2.x starts an implicit transaction for the preflight rename checks.
        # Commit that work before Alembic begins its managed migration transaction so the
        # version-table rename and subsequent schema migration do not roll back together.
        connection.commit()
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            version_table=VERSION_TABLE,
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()

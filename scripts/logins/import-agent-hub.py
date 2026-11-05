#!/usr/bin/env python3
"""One-way, value-opaque import. Run with Agent Hub's Python/key custody; originals stay intact."""
import argparse
import asyncio
import json
import logging
import os
import re
import socket
import stat
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def private(path: Path, value: bytes) -> None:
    fd, temp = tempfile.mkstemp(prefix='.login-import-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(value)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


async def main(args) -> None:
    # Use the existing application's configured DB and decryptor. No key, URL or value is printed.
    sys.path.insert(0, str(args.checkout / 'backend'))
    logging.disable(logging.CRITICAL)
    from app.db import async_session
    from app.models import Credential
    from app.storage.credentials import decrypt_value
    from sqlalchemy import select

    folder = args.destination
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = folder.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('private folder required')
    index_path = folder / 'index.json'
    lock = folder / '.index-lock'
    lock.mkdir(mode=0o700)
    added, skipped = [], []
    try:
        index: dict[str, Any] = json.loads(index_path.read_bytes()) if index_path.exists() else {'version': 1, 'entries': [], 'assignments': {}, 'audit': []}
        async with async_session() as db:
            rows = (await db.execute(select(Credential).order_by(Credential.id))).scalars().all()
            duplicates = {}
            for row in rows:
                key = (row.provider, row.credential_type)
                duplicates[key] = duplicates.get(key, 0) + 1
            for row in rows:
                provider, kind = row.provider, row.credential_type
                identity = f'{provider}/{kind}'
                if re.search(r'(^|[-_])(test|selftest|fixture|revoked)([-_]|$)', provider, re.IGNORECASE):
                    skipped.append({'name': identity, 'reason': 'test or revoked provider'})
                    continue
                value = decrypt_value(row.value_encrypted)
                if not value.strip():
                    skipped.append({'name': identity, 'reason': 'empty'})
                    continue
                tool = None
                lab = None
                if provider.startswith('_lab_'):
                    target = provider[5:]
                    payload = json.loads(value)
                    expiry = payload.get('expires_at')
                    if expiry and datetime.fromisoformat(expiry) <= datetime.now(UTC):
                        skipped.append({'name': identity, 'reason': 'expired'})
                        continue
                    if payload.get('reference') != f'secret://lab/{target}/{kind}' or not payload.get('values'):
                        raise ValueError('lab identity mismatch')
                    name = f'{provider}--{kind}'
                    category = 'lab login'
                    lab = {'target': target, 'actor': kind, 'kind': payload['kind'], 'expires_at': expiry, 'fields': sorted(payload['values'])}
                elif provider.startswith('_host_tool_'):
                    slug = provider[len('_host_tool_'):]
                    name = f'host-tool-{slug}-{kind}'
                    category = 'tool login'
                    known = {('claude-code', 'oauth-token'): {'envVar': 'CLAUDE_CODE_OAUTH_TOKEN'}, ('pi', 'opencode-go'): {'envVar': 'OPENCODE_API_KEY'}, ('st', 'summitflow-agent-token'): {'authFile': '.config/agent-tokens/summitflow'}}
                    if (slug, kind) not in known:
                        raise ValueError('unmapped tool destination')
                    tool = {'tool': slug, 'name': kind, 'file': name, **known[(slug, kind)]}
                else:
                    name = 'opencode-go' if provider == 'opencode-go' and kind == 'api_key' else f'{provider}-{kind}'
                    if duplicates[(provider, kind)] > 1:
                        name += f'-{row.id}'
                    category = 'password' if 'password' in kind else 'API key'
                if not re.fullmatch(r'[a-z0-9_][a-z0-9_.-]{0,179}', name) or name == 'index.json':
                    raise ValueError('invalid destination name')
                previous = next((item for item in index['entries'] if item['name'] == name), {})
                destination = folder / name
                if destination.exists() and (destination.is_symlink() or destination.stat().st_mode & 0o077):
                    raise ValueError('private destination required')
                if not destination.exists() or destination.read_bytes() != value.encode():
                    private(destination, value.encode())
                entry = {**previous, 'name': name, 'file': name, 'kind': category, 'notes': previous.get('notes', ''), 'machines': previous.get('machines', [socket.gethostname().split('.')[0].lower()]), 'roles': previous.get('roles', ['*']), 'created': row.created_at.isoformat(), 'rotated': row.updated_at.isoformat() if row.updated_at != row.created_at else None, 'lastUsed': previous.get('lastUsed'), 'source': 'Agent Hub', 'provider': provider}
                if tool:
                    entry['tool'] = tool
                if lab:
                    entry['lab'] = lab
                index['entries'] = [item for item in index['entries'] if item['name'] != name] + [entry]
                added.append(name)
            private(index_path, json.dumps(index, indent=2).encode())
        report = {'imported': added, 'skipped': skipped, 'source_rows': len(rows), 'source_preserved': True}
        args.report.write_text(json.dumps(report, indent=2) + '\n')
        print(f'Imported {len(added)} login rows; skipped {len(skipped)}. Names-only report saved.')
    finally:
        lock.rmdir()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--checkout', type=Path, required=True)
    parser.add_argument('--destination', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    try:
        asyncio.run(main(parser.parse_args()))
    except Exception:  # noqa: BLE001 — secret-bearing library errors must stay out of output
        # Exception arguments from libraries can contain connection or payload data.
        print('Login import failed; no source data was changed.', file=sys.stderr)
        sys.exit(1)

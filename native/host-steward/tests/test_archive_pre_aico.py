"""A failed file copy must remain recoverable without losing archived files."""
import importlib.util
import json
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[3] / 'scripts/archive-pre-aico.py'
spec = importlib.util.spec_from_file_location('archive_pre_aico', SCRIPT)
assert spec is not None and spec.loader is not None
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)


def partial_capture(tmp_path):
    source = tmp_path / 'source'
    source.mkdir()
    (source / 'first').write_text('already copied')
    (source / 'second').write_text('not copied yet')
    root = tmp_path / 'archive'
    (root / 'tree').mkdir(parents=True)
    (root / 'tree/first').write_text('already copied')
    (root / 'nightshift').mkdir()
    (root / 'nightshift/pve-anchor-heads').write_text('captured anchor')
    (root / 'capture.json').write_text(json.dumps({'databases': {}, 'sqlite': {}}))
    cfg = {'destination': str(root), 'databases': {}, 'sqlite': {},
           'trees': {'tree': str(source)}, 'files': {}, 'agentHubRoot': str(tmp_path / 'hub')}
    return cfg, root


def test_resume_completes_a_partial_tree_without_replacing_existing_files(tmp_path):
    cfg, root = partial_capture(tmp_path)
    before = (root / 'tree/first').stat().st_ino
    archive.finish_capture(cfg)
    assert (root / 'tree/second').read_text() == 'not copied yet'
    assert (root / 'tree/first').stat().st_ino == before
    assert json.loads((root / 'capture.json').read_text())['finishedAt']


def test_resume_refuses_a_conflicting_existing_file(tmp_path):
    cfg, root = partial_capture(tmp_path)
    (root / 'tree/first').write_text('different archived content')
    with pytest.raises(RuntimeError, match='differs'):
        archive.finish_capture(cfg)
    assert (root / 'tree/first').read_text() == 'different archived content'
    assert 'finishedAt' not in json.loads((root / 'capture.json').read_text())

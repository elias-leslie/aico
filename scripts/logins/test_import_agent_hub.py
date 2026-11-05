import importlib.util
from pathlib import Path


def test_normalizes_legacy_tool_alias_without_removing_values_or_grants():
    spec = importlib.util.spec_from_file_location('login_import', Path(__file__).with_name('import-agent-hub.py'))
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    alias = {'name': 'opencode-go', 'file': 'opencode-go', 'kind': 'API key', 'machines': ['worker'], 'roles': ['research'], 'deniedRoles': ['hunting'], 'tool': {'tool': 'pi', 'name': 'opencode-go', 'file': 'opencode-go'}}
    canonical = {'name': 'host-tool-pi-opencode-go', 'file': 'host-tool-pi-opencode-go', 'kind': 'tool login', 'provider': '_host_tool_pi', 'machines': ['full'], 'roles': ['implementation'], 'tool': {'tool': 'pi', 'name': 'opencode-go', 'file': 'host-tool-pi-opencode-go'}}
    index = {'entries': [alias, canonical], 'audit': []}
    assert module.normalize_tool_aliases(index) == ['opencode-go']
    assert 'tool' not in alias
    assert alias['file'] == 'opencode-go'
    assert canonical['machines'] == ['full', 'worker']
    assert canonical['deniedRoles'] == ['hunting']
    assert len(index['entries']) == 2
    assert module.normalize_tool_aliases(index) == []

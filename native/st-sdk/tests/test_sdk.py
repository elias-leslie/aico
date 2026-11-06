"""Public compatibility and Aico registry seams; no live service or credentials."""

from __future__ import annotations

import hashlib
import importlib
import json
import subprocess
import sys
import tomllib
from pathlib import Path

import httpx
import pytest
import typer

from st_sdk import config, credentials, state
from st_sdk.client import STClient
from st_sdk.http import APIError
from st_sdk.runtime import clear_context, describe_app, initialize_context, run_app

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def clean_context(monkeypatch):
    clear_context()
    config.set_project_override(None)
    monkeypatch.setattr(config, '_default_api_base', None)
    monkeypatch.setattr(config, '_default_agent_hub_url', None)
    for name in ('ST_EXTENSION_CONTEXT', 'AICO_API_BASE', 'AICO_WEB_URL', 'ST_API_BASE',
                 'ST_PROJECT_ID', 'AICO_PROJECT_ID', 'AICO_CLIENT_ID', 'SUMMITFLOW_CLIENT_ID',
                 'CONSULT_CLIENT_ID', 'INTERNAL_SERVICE_SECRET'):
        monkeypatch.delenv(name, raising=False)
    yield
    clear_context()
    config.set_project_override(None)


def context():
    return {'contract_version': 1, 'project_id': 'chosen', 'project_root': '/chosen',
            'cwd': '/caller', 'api_base': 'http://aico.test/api', 'agent_hub_url': 'http://aico.test',
            'output': {'human': True, 'compact': False, 'progress_only': False}}


def test_every_previous_public_module_and_root_export_imports():
    import st_sdk

    expected = {'APIError', 'BaseHTTPClient', 'Config', 'OutputContext', 'STClient', 'UsageSpec',
                'describe_app', 'get_agent_hub_url', 'get_api_base', 'get_config',
                'get_config_optional', 'initialize_context', 'run_app', 'usage'}
    assert set(st_sdk.__all__) == expected
    for name in expected:
        assert callable(getattr(st_sdk, name))
    for name in ('client', 'config', 'context', 'credentials', 'details', 'execution_context',
                 'fleet', 'http', 'identity', 'native_deployment', 'output', 'project_client',
                 'runtime', 'state', 'usage'):
        importlib.import_module(f'st_sdk.{name}')
    assert callable(st_sdk.usage)


def test_admission_and_tools_run_need_only_the_standard_library(tmp_path):
    (tmp_path / 'app.py').write_text("sentinel = 'foreign-owner'\n")
    script = f"import sys; sys.path.insert(0, {str(ROOT)!r}); import st_sdk.admission; assert not any(x.startswith('app.') for x in sys.modules)"
    result = subprocess.run([sys.executable, '-S', '-c', script], cwd=tmp_path,
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    result = subprocess.run([sys.executable, '-S', str(ROOT / 'tools_run.py'), '--help'],
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_context_installs_before_callback_without_registry_or_chdir(monkeypatch, tmp_path):
    payload = context()
    monkeypatch.setenv('ST_EXTENSION_CONTEXT', json.dumps(payload))
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(config, 'run_json', lambda *args: pytest.fail('registry should be unnecessary'))
    app = typer.Typer()
    observed = []

    @app.command()
    def inspect(ctx: typer.Context):
        observed.append((config.get_config(), ctx.obj.human, state.is_human(), Path.cwd()))

    with pytest.raises(SystemExit) as exc:
        run_app(app, 'owner', [])
    assert exc.value.code == 0
    assert observed == [(config.Config(payload['api_base'], 'chosen', '/chosen', 'context'),
                         True, True, tmp_path)]


@pytest.mark.parametrize('change', [
    {'contract_version': True}, {'contract_version': 2}, {'extra': 1}, {'cwd': 'relative'},
    {'project_root': 'relative'}, {'project_id': ''}, {'api_base': ''},
    {'output': {'human': 1, 'compact': False, 'progress_only': False}},
    {'output': {'human': True}},
])
def test_invalid_context_is_rejected_before_installing(change):
    payload = context() | change
    with pytest.raises(ValueError):
        initialize_context({'ST_EXTENSION_CONTEXT': json.dumps(payload)})
    assert config._runtime_config is None


def test_registry_uses_local_json_cli_and_longest_root(monkeypatch, tmp_path):
    nested = tmp_path / 'nested'
    nested.mkdir()
    calls = []
    projects = [{'id': 'outer', 'root_path': str(tmp_path)},
                {'id': 'inner', 'root_path': str(nested)}]

    def registry(*args):
        calls.append(args)
        return projects if args[1] == 'list' else {'id': args[2], 'root_path': str(nested)}

    monkeypatch.setattr(config, 'run_json', registry)
    monkeypatch.setattr(config, '_detect_project_from_local_metadata', lambda cwd: (None, None))
    monkeypatch.chdir(nested)
    monkeypatch.setenv('AICO_API_BASE', 'http://aico.test/api')
    assert config.get_config().project_id == 'inner'
    config.set_project_override('selected')
    assert config.get_config().project_root == str(nested)
    assert config.get_available_projects() == ['outer', 'inner']
    assert calls == [('projects', 'list', '--json'),
                     ('projects', 'show', 'selected', '--json'), ('projects', 'list', '--json')]


def test_api_default_is_aico_registry_identity_and_has_no_retired_fallback(monkeypatch, tmp_path):
    (tmp_path / 'project.identity.json').write_text(json.dumps({'runtime': {'backend_port': 4321}}))
    monkeypatch.setattr(config, 'get_project_root_path', lambda project: str(tmp_path) if project == 'aico' else None)
    assert config.get_api_base() == 'http://127.0.0.1:4321/api'
    assert config.get_agent_hub_url() == 'http://127.0.0.1:4321'
    monkeypatch.setattr(config, 'get_project_root_path', lambda project: None)
    assert config.get_api_base() == ''
    assert config.get_agent_hub_url() == ''


def test_static_help_and_usage_do_not_resolve_project(monkeypatch):
    from st_sdk.usage import usage

    monkeypatch.setattr(config, 'run_json', lambda *args: pytest.fail('static help queried registry'))
    config.set_project_override('selected')
    app = typer.Typer(help='Owner commands')

    @app.command()
    @usage(surface='st.owner.work', cmd='st owner work')
    def work(count: int = typer.Option(2, '--count')):
        pytest.fail('static help executed callback')

    description = describe_app(app, 'owner')
    assert '--count' in description['help']['']
    assert description['usage'][0]['surface'] == 'st.owner.work'


def test_explicit_http_client_preserves_request_and_error_contract_without_secrets(monkeypatch):
    from st_sdk.identity import token_headers

    monkeypatch.setenv('SUMMITFLOW_OWNER_TOKEN_FILE', '/must-not-read')
    monkeypatch.setattr(Path, 'read_text', lambda *a, **k: pytest.fail('implicit file read'))
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(201, json={'id': 'new-task'})

    with STClient(base_url='http://owner.test/api', project_id='chosen',
                  transport=httpx.MockTransport(handler)) as client:
        assert client.request('POST', '/things', json={'title': 'Promoted'}) == {'id': 'new-task'}
    assert str(seen[0].url) == 'http://owner.test/api/projects/chosen/things'
    assert not any('token' in key.lower() or key.lower() == 'authorization' for key in seen[0].headers)
    assert token_headers() == {}
    with pytest.raises(APIError) as exc:
        client._handle_response(httpx.Response(400, json={'detail': {'message': 'bad'}}))
    assert exc.value.status_code == 400 and exc.value.detail == {'message': 'bad'}


def test_project_api_registry_reads_metadata_without_service_api(monkeypatch, tmp_path):
    from st_sdk import project_client
    (tmp_path / 'project.identity.json').write_text(json.dumps({'runtime': {'backend_port': 4567}}))
    monkeypatch.setattr(project_client, 'get_project_root_path', lambda project: str(tmp_path))
    api = project_client.ProjectApi('owner', 'SDK_TEST_API_URL', 'http://fallback.test')
    assert project_client.resolve_api_url(api, cwd=tmp_path.parent) == project_client.ResolvedURL(
        'http://localhost:4567', 'registry')


def test_credential_compatibility_prefers_explicit_environment(monkeypatch, tmp_path):
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    with pytest.raises(typer.Exit):
        credentials.load_credentials()
    with pytest.raises(typer.Exit):
        credentials.load_internal_service_secret()
    monkeypatch.setenv('AICO_CLIENT_ID', 'fixture-client')
    monkeypatch.setenv('INTERNAL_SERVICE_SECRET', 'fixture-secret')
    assert credentials.load_credentials() == ('fixture-client', 'st-cli')
    assert credentials.load_internal_service_secret() == 'fixture-secret'


def test_release_manifest_tracks_all_wheel_module_and_policy_bytes():
    digest = hashlib.sha256()
    for path in sorted((ROOT / 'st_sdk').rglob('*')):
        if path.suffix in ('.py', '.json') and '__pycache__' not in path.parts:
            digest.update(path.relative_to(ROOT).as_posix().encode() + b'\0' + path.read_bytes() + b'\0')
    version = tomllib.loads((ROOT / 'pyproject.toml').read_text())['project']['version']
    rows = [line.split() for line in (ROOT / 'releases.txt').read_text().splitlines()
            if line.strip() and not line.startswith('#')]
    assert len({row[0] for row in rows}) == len(rows)
    assert rows[-1] == [version, digest.hexdigest()]


def test_standalone_owners_keep_approved_legacy_identity_source(monkeypatch, tmp_path):
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    (tmp_path / '.env.local').write_text(
        'SUMMITFLOW_CLIENT_ID=fixture-client\n'
        'SUMMITFLOW_REQUEST_SOURCE=fixture-source\n'
        'INTERNAL_SERVICE_SECRET=fixture-private\n'
    )
    assert credentials.load_credentials() == ('fixture-client', 'fixture-source')
    assert credentials.load_internal_service_secret() == 'fixture-private'


def test_cwd_project_beats_inherited_env_and_flag_beats_both(monkeypatch, tmp_path):
    project_b, elsewhere = tmp_path / 'b', tmp_path / 'elsewhere'
    project_b.mkdir()
    elsewhere.mkdir()
    monkeypatch.setattr(config, 'run_json', lambda *args: (
        [{'id': 'b', 'root_path': str(project_b)}] if args[1] == 'list' else {'id': args[2], 'root_path': '/x'}))
    monkeypatch.setattr(config, '_detect_project_from_local_metadata', lambda cwd: (None, None))
    monkeypatch.setenv('AICO_PROJECT_ID', 'a')
    monkeypatch.setenv('ST_PROJECT_ID', 'a')
    monkeypatch.chdir(project_b)
    assert (config.get_config().project_id, config.get_config().source) == ('b', 'cwd')
    config.get_config.cache_clear()
    monkeypatch.chdir(elsewhere)
    assert (config.get_config().project_id, config.get_config().source) == ('a', 'env')
    config.set_project_override('c')
    monkeypatch.chdir(project_b)
    assert (config.get_config().project_id, config.get_config().source) == ('c', 'flag')

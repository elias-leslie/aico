"""Project service lifecycle commands."""

from __future__ import annotations

import contextlib
import json
import time
from collections.abc import Callable, Mapping
from contextlib import suppress
from dataclasses import replace
from enum import StrEnum
from pathlib import Path
from typing import Annotated, Any

import typer

from ..lib import service_deploy_client, service_heal, service_ops, service_release
from ..lib.confirm_token import confirm_gate
from st_sdk.usage import usage
from st_sdk.state import is_compact
from st_sdk.output import output_error

app = typer.Typer(
    help=(
        "Project service lifecycle through st. Use rebuild/restart instead of "
        "raw systemctl or docker commands so build, migrations, unit sync, "
        "health checks, and seed sync stay together."
    )
)


class RebuildScope(StrEnum):
    full = "full"
    backend = "backend"
    frontend = "frontend"
    worker = "worker"


def _load(project: str, *, status_only: bool = False) -> service_ops.ProjectServices:
    try:
        return service_ops.load_status_project(project) if status_only else service_ops.load_project(project)
    except service_ops.ServiceError as exc:
        output_error(str(exc))
        raise typer.Exit(1) from None


def _require_local_build(services: service_ops.ProjectServices) -> None:
    if services.deployment:
        output_error(f"{services.project_id} runs on {services.deployment.label}; local rebuild/install is unavailable. "
                     "Update its native remote deployment using the recorded cutover procedure.")
        raise typer.Exit(1)


def _deploy_via_socket(services: service_ops.ProjectServices, user: str, verb: str, sha: str | None) -> int:
    """Hand the verb to the project's deploy gate and stream its answer."""
    try:
        return service_deploy_client.send(user, services.project_id, sha or service_deploy_client.main_sha(services.root), verb)
    except OSError as exc:
        output_error(f"deploy gate for {services.project_id} ({user}) unavailable: {exc}")
        return 1


def _restore_previous_units(
    project: service_ops.ProjectServices,
    release: service_release.PreparedRelease,
    manual: tuple[str, ...] = (),
) -> bool:
    """Keep the next restart recoverable after candidate activation fails."""
    try:
        previous_root = service_release.previous_source_root(release)
        if previous_root is None:
            service_release.mark_phase(
                release,
                "rollback",
                status="unavailable",
                database="not_rolled_back",
            )
            return False
        previous = service_ops.project_at_source(project, previous_root)
        restored = service_ops.sync_systemd_units(previous, manual=manual) == 0
        service_release.mark_phase(
            release,
            "rollback",
            status="units_restored" if restored else "units_restore_failed",
            previous_source_root=str(previous_root),
            database="not_rolled_back; migration downgrade is unsupported",
            running_services="not_restarted_automatically",
        )
        return restored
    except (service_ops.ServiceError, service_release.ReleaseError):
        service_release.mark_phase(
            release,
            "rollback",
            status="units_restore_failed",
            database="not_rolled_back; migration downgrade is unsupported",
            running_services="requires_manual_recovery",
        )
        return False






@app.command()
def status(
    project_arg: Annotated[
        str | None,
        typer.Argument(help="Project id. Omit to show all projects."),
    ] = None,
    project_option: Annotated[
        str | None,
        typer.Option("--project", "-P", help="Project id. Alias for PROJECT."),
    ] = None,
) -> None:
    """Show managed service states and the live release's source commit."""
    if project_arg and project_option and project_arg != project_option:
        output_error("Pass project either as PROJECT or --project/-P, not both.")
        raise typer.Exit(1)
    project = project_option or project_arg
    projects = [project] if project else service_ops.project_ids()
    errors = 0
    for project_id in projects:
        services = _load(project_id, status_only=True)
        if not services.deployment and (user := service_deploy_client.delegated_user(services.runtime_user)):
            errors += _deploy_via_socket(services, user, "status", None) != 0
            continue
        states = service_ops.observed_service_states(services)
        parts = []
        for svc in services.all_services:
            state = states[svc]
            errors += state != "active" and not (svc in services.optional_workers and state == "inactive")
            if paired := service_ops.activated_service(svc):
                # The activated service is idle between activations; only failure is an error.
                paired_state = states[paired]
                errors += paired_state == "failed"
                state = f"{state}({paired}:{paired_state})"
            parts.append(f"{svc}:{state}")
        if services.manual_workers and not services.deployment:
            parts.append("manual: " + " ".join(f"{svc}:{service_ops.service_state(svc)}"
                                               for svc in services.manual_workers))
        if not services.deployment and (release := service_release.current_release_commit(project_id)):
            parts.append(f"release={release[:12]}")
        location = f" [{services.deployment.label}]" if services.deployment else ""
        print(f"{services.project_id:<15}{location} {' '.join(parts) or 'no managed services'}")
    raise typer.Exit(1 if errors else 0)


def _acceptance_line(source: Mapping[str, Any] | None, *, supplied: bool) -> str:
    """Say how acceptance was satisfied: a supplied receipt, a reused one, or a fresh run."""
    source = source if isinstance(source, Mapping) else {}
    how = "supplied" if supplied else "reused" if source.get("reused") else "fresh"
    lookup = source.get("reuse_lookup_ms")
    detail = f" lookup_ms={lookup:.0f}" if how == "reused" and isinstance(lookup, (int, float)) else ""
    return f"[service] acceptance={how} id={str(source.get('acceptance_id') or '?')[:12]}{detail}"


ReleaseStep = tuple[str, Callable[[], int]]


def _selected_workers(
    services: service_ops.ProjectServices,
    *,
    backend: bool,
    include_all_workers: bool,
    requested_workers: tuple[str, ...],
) -> tuple[str, ...]:
    """Capture worker restart intent before any lifecycle mutation.

    Backend and worker scopes share one environment, so all running consumers
    must receive the update.
    """
    if not backend:
        return ()
    active_optional = tuple(
        name for name in services.optional_workers if service_ops.service_state(name) == "active"
    )
    return tuple(dict.fromkeys((
        *services.default_workers,
        *(services.optional_workers if include_all_workers else active_optional),
        *requested_workers,
    )))


def _timed_phase(release: service_release.PreparedRelease, name: str, run: Callable[[], int]) -> int:
    """Run one phase and record it as succeeded only when it returns 0."""
    started = time.monotonic()
    result = run()
    service_release.mark_phase(
        release,
        name,
        status="succeeded" if result == 0 else "failed",
        duration_seconds=time.monotonic() - started,
    )
    return result


def _release_steps(
    services: service_ops.ProjectServices,
    release: service_release.PreparedRelease,
    *,
    backend: bool,
    development_root: Path,
    manual: tuple[str, ...] = (),
) -> list[ReleaseStep]:
    """List the pre-restart release steps; frontend and manual scopes record migrations as not applicable."""
    steps: list[ReleaseStep] = [("infrastructure", lambda: service_ops.ensure_infra(services))]
    steps.append(("backend_dependencies", lambda: service_ops.sync_backend(services)))
    steps.append(("frontend_build", lambda: service_ops.build_frontend(services)))
    if backend:
        steps.append(("migrations", lambda: service_ops.run_migrations(services)))
    else:
        service_release.mark_phase(
            release,
            "migrations",
            status="not_applicable",
            reason="manual_worker_scope" if manual else "frontend_restart_scope",
        )
    steps.append(("systemd_units", lambda: service_ops.sync_systemd_units(services, manual=manual)))
    if backend and services.release_install:
        steps.append(("release_install", lambda: service_ops.run_release_install(
            services, development_root=development_root, source_commit=release.source.source_commit)))
    return steps


def _run_release_steps(
    steps: list[ReleaseStep],
    release: service_release.PreparedRelease,
    development_services: service_ops.ProjectServices,
    manual: tuple[str, ...] = (),
) -> None:
    """Run each step in order; the first failure fails the release before any restart."""
    for name, step in steps:
        if _timed_phase(release, name, step) != 0:
            if name == "systemd_units":
                _restore_previous_units(development_services, release, manual)
            service_release.fail_release(release, name)
            print(
                f"[service] rebuild stopped: {name.replace('_', ' ')} failed; "
                "services were not restarted"
            )
            raise typer.Exit(1)


def _restart_services(
    services: service_ops.ProjectServices,
    release: service_release.PreparedRelease,
    workers: tuple[str, ...],
    *,
    restart_backend: bool,
    frontend: bool,
) -> int:
    """Restart backend, workers, then frontend; return the restart error count.

    The caller decides ``restart_backend`` and marks the backend restart as
    attempted before calling, so its rollback handlers see it even when the
    guard or a restart raises here.
    """
    errors = 0
    restarted: list[str] = []
    restart_started = time.monotonic()
    if restart_backend and services.backend_service:
        errors += service_ops.restart_service(
            services.backend_service, port=services.backend_port, project=services
        ) != 0
        restarted.append(services.backend_service)
    for name in workers:
        errors += service_ops.restart_service(name, project=services) != 0
        restarted.append(name)
    if frontend and services.frontend_service:
        errors += service_ops.restart_service(
            services.frontend_service, port=services.frontend_port, project=services
        ) != 0
        restarted.append(services.frontend_service)
    service_release.mark_phase(
        release,
        "restart",
        status="succeeded" if errors == 0 else "failed",
        services=restarted,
        duration_seconds=time.monotonic() - restart_started,
    )
    return errors


def _verify_and_seed(
    services: service_ops.ProjectServices,
    release: service_release.PreparedRelease,
    workers: tuple[str, ...],
    errors: int,
    *,
    backend: bool,
    frontend: bool,
) -> int:
    """Check selected services and workers, then sync seeds when nothing failed.

    A manual-worker rebuild (neither component) checks only its workers.
    """
    selected = replace(services, backend_service=services.backend_service if backend else "",
                       frontend_service=services.frontend_service if frontend else "")
    if backend or frontend:
        errors += _timed_phase(release, "health", lambda: service_ops.verify_health(selected))
    worker_errors = 0
    for name in workers:
        state = service_ops.service_state(name)
        print(f"[service] worker {name}: {state}")
        worker_errors += state != "active"
    errors += worker_errors
    if not (backend or frontend):
        # The active-worker check is a manual rebuild's health evidence; it syncs no seeds.
        service_release.mark_phase(release, "health", status="failed" if worker_errors else "succeeded",
                                   reason="manual_worker_scope")
        service_release.mark_phase(release, "seeds", status="not_applicable", reason="manual_worker_scope")
    elif errors == 0:
        errors += _timed_phase(release, "seeds", lambda: service_ops.sync_seeds(services)) != 0
    return errors


@app.command()
@usage(
    surface="st.service.rebuild",
    cmd="st service rebuild <project> --detach",
    when=(
        "deployed code/config/worker behavior changed (managed build+migrate+restart); "
        "never raw pnpm/npm/uv build or systemctl restart"
    ),
    precautions=(
        "explicit project, not cwd; resolve blockers its preflight reports",
        "no ask needed: deploys committed HEAD only; preflight refuses when unsafe",
        "full scope for shared or uncertain changes; worker scope includes backend consumers",
        "required and active optional workers restart automatically; --include-all-workers also starts inactive optional workers",
    ),
    examples=(
        "st service rebuild aico --detach",
    ),
    task_types=("devops", "config", "frontend", "backend"),
    tier="mandate",
)
def rebuild(
    project: Annotated[str | None, typer.Argument(help="Project id to rebuild")] = None,
    detach: Annotated[bool, typer.Option("--detach", help="Queue rebuild in background")] = False,
    include_all_workers: Annotated[
        bool,
        typer.Option("--include-all-workers", help="Start or restart all declared optional workers, including inactive ones"),
    ] = False,
    scope: Annotated[
        RebuildScope,
        typer.Option("--scope", help="Restart/migration scope; release build uses full accepted source. Worker includes backend consumers; use full for shared changes."),
    ] = RebuildScope.full,
    worker: Annotated[
        list[str] | None,
        typer.Option("--worker", help="Also restart this declared worker, including inactive optional workers. "
                     "A manual worker is rebuilt alone: only its unit is rendered and restarted. Repeatable."),
    ] = None,
    acceptance: Annotated[
        Path | None,
        typer.Option(
            "--acceptance",
            help="Full successful local-acceptance receipt. Omit to accept the current clean HEAD locally.",
        ),
    ] = None,
    with_ack: Annotated[
        str | None,
        typer.Option("--with-ack", help="Request id the repo's holder acked yes"),
    ] = None,
    rollback: Annotated[
        bool,
        typer.Option("--rollback", help="Deploy an accepted commit that does not contain the live release"),
    ] = False,
    source_repo: Annotated[
        Path | None,
        typer.Option("--source-repo", help="Bare mirror to read git state from instead of the checkout (used by the deploy gate); needs --sha"),
    ] = None,
    sha: Annotated[
        str | None,
        typer.Option("--sha", help="Full commit id to deploy: with --source-repo it is read from the mirror; for a runtime_user project it replaces the checkout's main"),
    ] = None,
) -> None:
    """Build, migrate, restart, and health-check a project from its committed local HEAD (st commit first; no push needed)."""
    try:
        project = service_ops.rebuild_project(project)
    except service_ops.ServiceError as exc:
        output_error(str(exc))
        raise typer.Exit(1) from None
    if project == service_ops.native_owner_project():
        raise typer.Exit(3)
    services = _load(project)
    _require_local_build(services)
    from ..lib import coord

    if source_repo is not None:
        if detach:
            output_error("--source-repo cannot be combined with --detach.")
            raise typer.Exit(1)
        try:
            services = service_ops.use_source_repo(services, source_repo, sha or "")
        except service_ops.ServiceError as exc:
            output_error(str(exc))
            raise typer.Exit(1) from None
        print("[service] installing the pinned source's tools for acceptance")
        if service_ops.install_clone_dependencies(services) != 0:
            output_error("Could not install dependencies in the pinned source.")
            raise typer.Exit(1)
    elif user := service_deploy_client.delegated_user(services.runtime_user):
        if acceptance or with_ack:
            output_error("--acceptance and --with-ack are not available through the deploy gate.")
            raise typer.Exit(1)
        raise typer.Exit(_deploy_via_socket(services, user, "rollback" if rollback else "deploy", sha))
    elif sha:
        output_error("--sha needs --source-repo or a project with a runtime user.")
        raise typer.Exit(1)
    try:
        if source_repo is None:  # a pinned mirror has no working tree for other agents to hold
            coord.guard(services.root, "rebuild", with_ack=with_ack)
    except coord.CoordBlocked as exc:
        output_error(str(exc))
        raise typer.Exit(2) from None
    declared = {service_ops.canonical_unit(name): name
                for name in (*services.workers(include_all=True), *services.manual_workers)}
    requested_workers = tuple(declared.get(service_ops.canonical_unit(name), name) for name in worker or ())
    unknown = set(requested_workers) - set(declared.values())
    if unknown or (scope == RebuildScope.frontend and (requested_workers or include_all_workers)):
        output_error("Unknown worker or frontend-only scope combined with worker selection.")
        raise typer.Exit(1)
    manual = tuple(name for name in requested_workers if name in services.manual_workers)
    if manual and (len(manual) != len(requested_workers) or include_all_workers
                   or scope != RebuildScope.full):
        output_error("A manual worker rebuilds alone: drop other workers, --scope, --include-all-workers "
                     ".")
        raise typer.Exit(1)
    overlapping_components = (
        services.backend_service and services.frontend_service
        and (services.backend_dir.is_relative_to(services.frontend_dir)
             or services.frontend_dir.is_relative_to(services.backend_dir))
    )
    if scope != RebuildScope.full and overlapping_components:
        print("[service] shared component directory; using full rebuild")
        scope = RebuildScope.full
    if scope == RebuildScope.frontend and services.page_on_backend and not manual:
        # No frontend unit: the backend unit serves the built page, so a frontend
        # deploy must restart it, and with new backend code its migrations run first.
        print(f"[service] {services.backend_service} serves the frontend; using backend scope")
        scope = RebuildScope.backend
    # Manual-worker rebuilds restart nothing else, so the backend-restart gates do not apply.
    backend = scope != RebuildScope.frontend and not manual
    frontend = scope in (RebuildScope.full, RebuildScope.frontend) and not manual
    if detach:
        try:
            with coord.acked(with_ack):
                accepted_source = service_ops.resolve_accepted_source(services, acceptance, rollback=rollback)
            print(_acceptance_line(accepted_source, supplied=acceptance is not None))
            raise typer.Exit(
                service_ops.queue_detached(
                    project,
                    include_all_workers,
                    scope=scope.value,
                    workers=requested_workers,
                    accepted_source=accepted_source,
                    with_ack=with_ack,
                    rollback=rollback,
                    
                )
            )
        except (service_ops.ServiceError, service_release.ReleaseError) as exc:
            output_error(str(exc))
            raise typer.Exit(1) from None
    if manual:
        print("[service] manual worker rebuild: restarting only " + " ".join(manual))
    elif scope != RebuildScope.full:
        print(
            "[service] stable releases build the full accepted source; "
            f"restart scope remains {scope.value}"
        )
    workers = manual or _selected_workers(
        services, backend=backend, include_all_workers=include_all_workers, requested_workers=requested_workers
    )
    scope_label = "manual" if manual else scope.value
    start_time = time.time()
    release: service_release.PreparedRelease | None = None
    development_services = services
    development_root = services.git_root
    try:
        with service_release.deployment_lock(services.project_id):
            with coord.acked(with_ack):
                release, services = service_ops.prepare_accepted_release(services, acceptance, rollback=rollback)
            print(_acceptance_line(vars(release.source), supplied=acceptance is not None))
            # A manual worker (Tether) restarts only when --worker names it, in every scope: restarting
            # it cuts into live agent sessions, and its source may be another lane's pending change
            # (2026-10-31 a routine aico rebuild put Neri's Tether change live). Say so when it changed.
            stale = () if manual else service_ops.changed_manual_workers(
                services, release.release_root.parent, release.source.source_commit,
                repo=development_services.git_root)
            for unit in stale:
                print(f"[service] {unit} changed since its running release and was left running; deploy it with: "
                      f"st service rebuild {services.project_id} --worker {unit.removesuffix('.service')}")
            service_release.mark_phase(
                release,
                "deployment_scope",
                status="selected",
                scope=scope_label,
                release_scope="full",
                workers=list(workers),
            )
            print(
                f"Rebuilding {services.project_id} (scope: {scope_label}, "
                f"source: {release.source.source_commit}, build: {release.build_id})"
            )
            _run_release_steps(
                _release_steps(services, release, backend=backend, development_root=development_root, manual=manual),
                release,
                development_services,
                manual,
            )
            skipped = [name for name in services.optional_workers if name not in workers]
            if skipped and not manual:
                print("[service] leaving optional workers unchanged: " + " ".join(skipped))
            if unchanged := [name for name in services.manual_workers if not manual and name not in stale]:
                print("[service] leaving manual workers unchanged (stopped, or no change since their release): "
                      + " ".join(unchanged))
            restart_backend = bool(backend and services.backend_service)
            errors = _restart_services(
                services,
                release,
                workers,
                restart_backend=restart_backend,
                frontend=frontend,
            )
            errors = _verify_and_seed(services, release, workers, errors, backend=backend, frontend=frontend)
            if errors:
                _restore_previous_units(development_services, release, manual)
                service_release.fail_release(
                    release,
                    "restart_health",
                    migrations=(
                        "applied; automatic database rollback is unsupported"
                        if backend
                        else "not_applicable"
                    ),
                )
                print(f"[service] rebuild completed with {errors} error(s)")
                raise typer.Exit(1)
            service_references = service_ops.release_references_for_services(
                release.release_root.parent
            )
            # Running processes, not unit files: a scoped deploy re-renders a unit
            # its process keeps serving from an older release.
            manual_references = service_ops.process_release_references(
                services, release.release_root.parent
            )
            service_references = (None if service_references is None or manual_references is None
                                  else service_references | manual_references)
            service_release.complete_release(
                release, service_references=service_references
            )
            result = service_release.publish_deployment_result(
                release, project_root=development_root
            )
            print(
                f"[service] deployment_receipt={result['artifact']} "
                f"deployment_id={result['deployment_id']}"
            )
            print(f"[service] rebuild complete ({int(time.time() - start_time)}s)")
    except (service_ops.ServiceError, service_release.ReleaseError) as exc:
        if release is not None:
            with suppress(service_release.ReleaseError):
                service_release.fail_release(release, "deployment")
        output_error(str(exc))
        raise typer.Exit(1) from None
    except BaseException as exc:
        # Any other failure (e.g. a dependency vanishing mid-deploy) must not
        # strand an activated collector and its .pending receipt marker.
        if release is not None and not isinstance(exc, typer.Exit):
            with suppress(Exception):
                service_release.fail_release(release, "deployment")
        raise
    raise typer.Exit(0)


def _in_place_units(
    services: service_ops.ProjectServices, scope: RebuildScope, *, include_all_workers: bool,
    requested_workers: tuple[str, ...],
) -> list[str]:
    """The units a restart of ``scope`` covers, never a manual worker unless named."""
    backend = scope != RebuildScope.frontend or services.page_on_backend
    units = [services.backend_service] if backend and services.backend_service else []
    units += _selected_workers(services, backend=scope != RebuildScope.frontend,
                               include_all_workers=include_all_workers, requested_workers=requested_workers)
    if scope in (RebuildScope.full, RebuildScope.frontend) and services.frontend_service:
        units.append(services.frontend_service)
    return list(dict.fromkeys(units))


def _restart_in_place(
    project: str, scope: RebuildScope, *, include_all_workers: bool, requested_workers: tuple[str, ...],
) -> int | None:
    """Restart onto the release ``current`` already holds when it is the checkout's HEAD.

    Returns None when a build is needed (HEAD moved, no release yet, a manual
    worker, a remote or delegated runtime, or a backend whose migrations the
    current release did not run), so the caller rebuilds instead.
    """
    services = _load(project)
    if services.runtime_user or services.deployment or any(
            name in services.manual_workers for name in requested_workers):
        return None
    current = service_release.current_build(services.project_id)
    commit = service_release.current_release_commit(services.project_id)
    head = service_ops.capture(["git", "rev-parse", "HEAD"], cwd=services.git_root).stdout.strip()
    if current is None or not commit or commit != head:
        if current is not None:
            print(f"[service] HEAD {head[:12] or '?'} is not the live release ({(commit or '?')[:12]}); rebuilding")
        return None
    units = _in_place_units(services, scope, include_all_workers=include_all_workers,
                            requested_workers=requested_workers)
    receipt = service_release.build_receipt(services.project_id, current)
    if services.backend_service in units and not service_heal.migrations_cover(services, receipt):
        print("[service] the live release's deploy did not run migrations; rebuilding")
        return None
    print(f"[service] restarting {services.project_id} onto its live release {current[:12]} (no build): "
          + " ".join(units))
    try:
        with service_release.deployment_lock(services.project_id):
            errors = service_heal.restart_onto_current(services, units, reason="restart")
    except (service_ops.ServiceError, service_release.ReleaseError) as exc:
        output_error(str(exc))
        return 1
    print(f"[service] restart {'complete' if errors == 0 else f'finished with {errors} error(s)'}")
    return 1 if errors else 0


@app.command()
def restart(
    project: Annotated[str, typer.Argument(help="Project id to restart/rebuild")],
    detach: Annotated[bool, typer.Option("--detach", help="Queue a rebuild in background when one is needed")] = False,
    include_all_workers: Annotated[
        bool,
        typer.Option("--include-all-workers", help="Start or restart all declared optional workers, including inactive ones"),
    ] = False,
    scope: Annotated[RebuildScope, typer.Option("--scope", help="Same explicit component scope as rebuild.")] = RebuildScope.full,
    worker: Annotated[list[str] | None, typer.Option("--worker", help="Declared worker to restart; repeatable.")] = None,
    acceptance: Annotated[
        Path | None,
        typer.Option("--acceptance", help="Full successful local-acceptance receipt."),
    ] = None,
    with_ack: Annotated[
        str | None,
        typer.Option("--with-ack", help="Request id the repo's holder acked yes"),
    ] = None,
) -> None:
    """Restart a managed project onto its live release; rebuild only when HEAD is not live yet.

    A restart never builds when the live release is HEAD (so it never waits in
    heavy-work admission) and never restarts a manual worker such as Tether
    unless --worker names it.
    """
    if acceptance is None:
        services = _load(project)
        declared = {service_ops.canonical_unit(name): name for name in (
            *services.workers(include_all=True), *services.manual_workers)}
        requested = tuple(declared.get(service_ops.canonical_unit(name), name) for name in worker or ())
        if set(requested) <= set(declared.values()):
            code = _restart_in_place(project, scope, include_all_workers=include_all_workers,
                                     requested_workers=requested)
            if code is not None:
                raise typer.Exit(code)
    rebuild(
        project,
        detach=detach,
        include_all_workers=include_all_workers,
        scope=scope,
        worker=worker,
        acceptance=acceptance,
        with_ack=with_ack,
    )


@app.command()
def heal(
    projects: Annotated[list[str] | None, typer.Argument(help="Project ids; omit for every managed project")] = None,
    dry_run: Annotated[bool, typer.Option("--dry-run", help="Report problems, restart nothing")] = False,
    cooldown_minutes: Annotated[
        int, typer.Option("--cooldown-minutes", help="A unit that breaks again this soon after a heal is not restarted again")
    ] = 30,
    as_json: Annotated[bool, typer.Option("--json", help="One JSON object per project")] = False,
) -> None:
    """Restart units users would see broken onto the live release (no build); exit 1 when one stays broken.

    Finds a unit running from a removed release, a unit the live deploy covered
    that still runs an older one, and a page that fails while /health passes.
    Never restarts a manual worker (Tether); a project mid-deploy is skipped.
    """
    results = [service_heal.heal_project(project_id, cooldown_seconds=cooldown_minutes * 60, dry_run=dry_run)
               for project_id in (projects or service_ops.project_ids())]
    for result in results:
        if as_json:
            print(json.dumps(result))
            continue
        line = f"{result['project']}: {result['status']}"
        if result.get("restarted"):
            line += " (restarted " + " ".join(result["restarted"]) + ")"
        if result.get("detail"):
            line += f": {result['detail']}"
        print(line)
        for problem in result.get("problems") or ():
            print(f"  {problem['unit']}: {problem['detail']}")
    raise typer.Exit(1 if any(r["status"] in {"failed", "needs_attention"} for r in results) else 0)


def _job_result(job_id: str) -> dict:
    try:
        return service_ops.detached_result(job_id)
    except service_ops.ServiceError as exc:
        output_error(str(exc))
        raise typer.Exit(1) from None


def _compact_job(record: dict) -> dict:
    """Keep the job record readable: the embedded acceptance receipt stays on disk."""
    compact = dict(record)
    source = compact.get("source")
    if isinstance(source, dict) and "checks" in source:
        compact["source"] = {key: value for key, value in source.items() if key != "checks"}
    log_path = record.get("log_path")
    if record.get("state") == "failed" and log_path:
        with contextlib.suppress(OSError):
            compact["log_tail"] = Path(log_path).read_text(errors="replace").splitlines()[-8:]
    return compact


def _print_job(record: dict) -> None:
    """One summary line (plus a failure log tail); st --no-compact prints the full JSON record."""
    compact = _compact_job(record)
    if not is_compact():
        print(json.dumps(compact))
        return
    source = compact.get("source")
    source = source if isinstance(source, dict) else {}
    deployment = compact.get("deployment")
    deployment = deployment if isinstance(deployment, dict) else {}
    fields = [
        f"JOB:{compact.get('job_id')}", str(compact.get("project", "")), str(compact.get("state")),
        f"exit={compact.get('exit_code')}",
    ]
    if source.get("source_commit"):
        fields.append(f"commit={str(source['source_commit'])[:12]}")
    if deployment.get("state"):
        fields.append(f"deploy={deployment['state']}")
    if compact.get("state") == "failed" and compact.get("log_path"):
        fields.append(f"log={compact['log_path']}")
    print("|".join(fields))
    for line in compact.get("log_tail", []):
        print(f"  {line}")


def _job_exit_code(record: dict) -> int:
    if record["state"] in {"succeeded", "failed"}:
        return record["exit_code"]
    return 1


@app.command("result")
def job_result(job_id: Annotated[str, typer.Argument(help="Job id returned by --detach")]) -> None:
    """Read a durable detached rebuild result, including interrupted/unknown state."""
    if job_id.startswith("aico-"):
        raise typer.Exit(3)
    record = _job_result(job_id)
    _print_job(record)
    raise typer.Exit(_job_exit_code(record))


@app.command("wait")
def wait_for_job(
    job_id: Annotated[str, typer.Argument(help="Job id returned by --detach")],
    timeout: Annotated[float, typer.Option("--timeout", min=0, help="Maximum seconds to await completion")] = 300,
) -> None:
    """Wait for a detached rebuild and return its actual exit code."""
    if job_id.startswith("aico-"):
        raise typer.Exit(3)
    deadline = time.monotonic() + timeout
    while True:
        record = _job_result(job_id)
        if record["state"] not in {"queued", "running"} or time.monotonic() >= deadline:
            _print_job(record)
            raise typer.Exit(_job_exit_code(record))
        time.sleep(min(1, max(0, deadline - time.monotonic())))


@app.command("_run-job", hidden=True)
def run_job(job_id: str) -> None:
    """Internal systemd runner; terminal result survives transient-unit collection."""
    try:
        raise typer.Exit(service_ops.run_detached_job(job_id))
    except service_ops.ServiceError as exc:
        output_error(str(exc))
        raise typer.Exit(1) from None


@app.command()
def start(
    project: Annotated[str, typer.Argument(help="Project id to start")] = ...,
) -> None:
    """Start a managed project's service set."""
    raise typer.Exit(service_ops.start_services(_load(project)))


@app.command("stop-unit")
def stop_unit(
    project: Annotated[str, typer.Argument(help="Project id that created the unit")],
    unit: Annotated[str, typer.Argument(help="Transient <project>-*.service or .scope unit")],
) -> None:
    """Stop one transient user unit a project created (e.g. a leftover smoke-test unit).

    Refuses persistent units, managed services and names outside the project prefix.
    """
    services = _load(project)
    _require_local_build(services)
    code, state = service_ops.stop_transient_unit(services, unit)
    typer.echo(f"STOP-UNIT:{project}|unit={unit}|state={state}")
    raise typer.Exit(code)


@app.command()
def stop(
    project: Annotated[str, typer.Argument(help="Project id to stop")] = ...,
    confirm: Annotated[str | None, typer.Option("--confirm", help="Confirm token from preview run")] = None,
) -> None:
    """Stop a managed project's service set. Two-pass confirmation required."""
    services = _load(project)
    if not services.deployment and (user := service_deploy_client.delegated_user(services.runtime_user)):
        raise typer.Exit(_deploy_via_socket(services, user, "stop", None))
    confirm_gate(
        f"service-stop-{services.project_id}",
        confirm,
        [
            f"STOP SERVICES: {services.project_id}",
            f"This interrupts services on {services.deployment.label if services.deployment else 'this workstation'}.",
            "Services: " + ", ".join(services.all_services),
        ],
        f"st service stop {services.project_id}",
    )
    raise typer.Exit(service_ops.stop_services(services))

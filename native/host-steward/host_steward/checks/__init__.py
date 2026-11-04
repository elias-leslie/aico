"""The host checks, in run order. Each module has ID and run(ctx) -> list[Signal]; its settings are the
[checks.<ID>] table in data/checks.toml."""

from host_steward.checks import (
    backups,
    disk_tests,
    ecc,
    floor,
    gates,
    guests,
    journal,
    memory,
    ominull_lock,
    perf,
    probes,
    pve,
    registry,
    router,
    security,
    storage,
    sudo,
    thermal,
    trends,
    tripwire,
    usage,
    workstation,
)

CHECKS = {
    module.ID: module
    for module in (
        workstation,
        storage,
        perf,
        pve,
        guests,
        ecc,
        thermal,
        disk_tests,
        backups,
        journal,
        sudo,
        tripwire,
        security,
        memory,
        probes,
        gates,
        floor,
        usage,
        ominull_lock,
        router,
        registry,
        trends,
    )
}

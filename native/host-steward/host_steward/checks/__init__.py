"""The host checks, in run order. Each module has ID and run(ctx) -> list[Signal]; its settings are the
[checks.<ID>] table in data/checks.toml."""

from host_steward.checks import (
    backups,
    ecc,
    gates,
    journal,
    ominull_lock,
    perf,
    pve,
    router,
    storage,
    thermal,
    workstation,
)

CHECKS = {
    module.ID: module
    for module in (
        workstation,
        storage,
        perf,
        pve,
        ecc,
        thermal,
        backups,
        journal,
        gates,
        ominull_lock,
        router,
    )
}

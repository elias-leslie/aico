"""The host-steward commands that are not the check pass: controllers, collectors, timer jobs, declarations.

A job is a module with NAME, HELP, add_args(parser) and main(args, data, post) -> int, where data is
core.load_data() and post(rows) posts Status rows (aico_status.report). A job that changes the host reads its
switch with core.acting(data, NAME-or-piece) and, while it is off, prints and records what it would have done and
changes nothing. Register a module by adding it to JOBS.
"""

from types import ModuleType

from host_steward.jobs import (
    collect_usage,
    declare,
    housekeeping,
    lab_use,
    memctl,
    nvme_test,
    scrub,
    security_ack,
    space_guard,
)

JOBS: dict[str, ModuleType] = {
    module.NAME: module
    for module in (
        collect_usage,
        declare,
        housekeeping,
        lab_use,
        memctl,
        nvme_test,
        scrub,
        security_ack,
        space_guard,
    )
}

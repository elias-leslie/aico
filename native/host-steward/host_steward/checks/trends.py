"""Trends: the slow changes the point-in-time checks cannot see, one verdict per metric family.

The pve, storage and ecc checks record their readings into the history store
(history.py) as they run; this check, run after them, evaluates the specs in the data file ([[checks.trends.specs]])
over the daily values and says each one as a signal (code = the finding code, so the tier classes and the
caps apply).

A worsening verdict speaks at the spec's severity (failed when a rule's limit is within critical_days), then the
tier step (assets.tier_state) raises it for the host's asset: the PVE thin pool, SMART and ECC trends are data
signals, so they are failed on the PVE host (it holds data). A spec with nothing recorded for its host yet is skipped;
a trend that is not worsening is a note only when it is improving or the spec is a digest.
"""

from __future__ import annotations

from typing import Any

from host_steward import assets, history, trend
from host_steward.core import Ctx, Signal

ID = "trends"


def specs_of(cfg: dict[str, Any]) -> list[trend.Spec]:
    return [trend.spec_from(raw) for raw in cfg.get("specs", [])]


def signal_for(
    spec: trend.Spec,
    ev: dict[str, Any],
    names: dict[str, str],
    reg: assets.Registry,
    iso: dict[str, bool],
    classes: list[list[str]],
) -> Signal:
    state = trend.state_of(spec, ev)
    fields = {
        "line": trend.line(spec, ev, names),
        "detail": trend.line(spec, ev, names),
        "verdict": ev["verdict"],
    }
    note = spec.digest_always or (state == "ok" and ev["verdict"] in ("worsening", "improving"))
    sig = Signal(spec.code, state, fields, note=note)
    asset = reg.by_role(spec.host)
    if asset is None:
        return sig
    return assets.tier_signal(
        sig, assets.finding_class(spec.code, classes), asset, iso.get(asset.id, False)
    )


def run(ctx: Ctx) -> list[Signal]:
    store = history.store_for(ctx.cache)
    data = assets.load_file()
    reg, iso = assets.registry_for_run(
        assets.load_state(), data.get("tiers", {}).get("tag_tiers", {}), data
    )
    classes = data.get("tiers", {}).get("classes", [])
    names = dict(ctx.cfg.get("names", {}))
    out: list[Signal] = []
    for spec in specs_of(ctx.cfg):
        if not any(store.series(rule.metric, spec.host) for rule in spec.rules):
            continue  # nothing recorded for this host yet (its check is off or has not run)
        out.append(signal_for(spec, trend.evaluate(store, spec, ctx.now), names, reg, iso, classes))
    if not out:
        out.append(Signal("trends.none", "ok", {}))
    return out

// Where the inbox popover goes: pure, so tests run it outside the shell (tests/test_shell_extension.py).

/**
 * Top-left of the popover's visible frame: centred under the icon (or over it, when the panel is at the bottom),
 * kept inside the monitor's work area with `gap` to spare.
 *
 * @param {{x: number, y: number, w: number, h: number}} icon the icon, stage coordinates
 * @param {{w: number, h: number}} size the window's frame size
 * @param {{x: number, y: number, w: number, h: number}} monitor the icon's monitor
 * @param {{x: number, y: number, w: number, h: number}} work that monitor's work area (the panels left out)
 * @param {number} gap space between the panel and the popover, and from the work area's edges
 * @returns {[number, number]}
 */
export function spot(icon, size, monitor, work, gap) {
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
    const x = clamp(Math.round(icon.x + icon.w / 2 - size.w / 2), work.x + gap, work.x + work.w - gap - size.w);
    const top = icon.y + icon.h / 2 < monitor.y + monitor.h / 2;
    const y = top
        ? Math.max(icon.y + icon.h, work.y) + gap
        : Math.min(icon.y, work.y + work.h) - gap - size.h;
    return [x, clamp(y, work.y, work.y + work.h - size.h)];
}

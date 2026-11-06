// Aico's icon in the top bar, with no dbusmenu menu: a left click drops the Aico inbox from it as a
// popover, a right click shows the tray menu's rows natively. The inbox and everything in it is the Aico tray
// app (native/tray/src/shell.rs, dev.summitflow.NightshiftTray on the session bus: the bus names and this extension's
// id keep their first names, since GNOME Shell on Wayland loads a renamed extension only after the next login), so a crash there never takes GNOME
// Shell down; this file only shows the icon, its count and tooltip, asks the app to open the inbox, places that window
// under the icon, and closes it on a click elsewhere or when focus goes elsewhere (Escape is the app's own). While enabled it holds
// dev.summitflow.NightshiftTray.Shell, which tells the app to hide its StatusNotifierItem: one icon, and the other
// comes back as soon as this extension is disabled or gone.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {spot} from './logic.js';

const BUS = 'dev.summitflow.NightshiftTray';
const PATH = '/dev/summitflow/NightshiftTray';
const SHELL_NAME = 'dev.summitflow.NightshiftTray.Shell';
const GAP = 6;
const TIP_DELAY_MS = 500;
const ADOPT_WINDOW_US = 10 * 1000 * 1000; // the inbox's window shows well within this after the app says it started
const REOPEN_GUARD_US = 400 * 1000; // the click on the icon that took focus from the popover closed it: no reopen
const NOT_RUNNING = "Aico tray isn't running";

const TrayProxy = Gio.DBusProxy.makeProxyWrapper(`<node><interface name="${BUS}">
<property name="Icon" type="s" access="read"/><property name="Label" type="s" access="read"/>
<property name="Attention" type="b" access="read"/><property name="ToolTip" type="s" access="read"/>
<method name="Open"/>
<method name="Menu"><arg name="rows" type="a(isb)" direction="out"/></method>
<method name="MenuClick"><arg name="id" type="i" direction="in"/></method>
<signal name="PanelOpened"><arg name="pid" type="u"/></signal>
</interface></node>`);

const now = () => GLib.get_monotonic_time();

const Indicator = GObject.registerClass(
class NightshiftIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'Aico');
        this._clickGesture?.set_enabled(false); // clicks are ours (vfunc_button_press_event), not a menu toggle
        this._ext = ext;
        this._tipText = NOT_RUNNING;
        this._tipId = 0;
        this._tip = null;
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({style_class: 'system-status-icon'});
        this._label = new St.Label({style_class: 'nightshift-count', y_align: Clutter.ActorAlign.CENTER, visible: false});
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);
        this.menu.actor.add_style_class_name('nightshift-menu');
        this.connect('notify::hover', () => this._syncTip());
        this.connect('destroy', () => {
            this._gone = true;
            if (this._tipId)
                GLib.source_remove(this._tipId);
            this._tipId = 0;
            this._tip?.destroy();
            this._tip = null;
        });
        this.menu.connect('open-state-changed', () => this._syncTip());
    }

    show_state({up, icon, label, attention, tip}) {
        const file = icon || `${GLib.get_home_dir()}/.local/lib/aico/icons/aico-tray.png`;
        if (GLib.file_test(file, GLib.FileTest.EXISTS))
            this._icon.gicon = new Gio.FileIcon({file: Gio.File.new_for_path(file)});
        else
            this._icon.icon_name = 'weather-clear-night-symbolic';
        this.opacity = up ? 255 : 128;
        this._label.text = label;
        this._label.visible = label !== '';
        if (attention)
            this._label.add_style_class_name('nightshift-attn');
        else
            this._label.remove_style_class_name('nightshift-attn');
        this._tipText = tip;
        if (this._tip?.visible)
            this._showTip();
    }

    vfunc_button_press_event(event) {
        this._hideTip();
        const button = event.get_button();
        if (button === Clutter.BUTTON_SECONDARY) {
            this._toggleMenu();
            return Clutter.EVENT_STOP;
        }
        if (button === Clutter.BUTTON_PRIMARY || button === Clutter.BUTTON_MIDDLE) {
            this.menu.close();
            this._ext.toggle();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_event(event) {
        if (event.type() === Clutter.EventType.TOUCH_BEGIN) {
            this._ext.toggle();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // The tray menu's rows, read when it opens so their times are current.
    _toggleMenu() {
        if (this.menu.isOpen) {
            this.menu.close();
            return;
        }
        this._ext.menuRows(rows => {
            if (this._gone) // disabled (the screen locked) before the app answered
                return;
            this.menu.removeAll();
            if (!rows) {
                const item = new PopupMenu.PopupMenuItem(NOT_RUNNING);
                item.setSensitive(false);
                this.menu.addMenuItem(item);
            }
            for (const [id, text, enabled] of rows ?? []) {
                if (!text) {
                    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                    continue;
                }
                const item = new PopupMenu.PopupMenuItem(text);
                item.label.clutter_text.ellipsize = 0; // Pango.EllipsizeMode.NONE: a long health line wraps
                item.label.clutter_text.line_wrap = true;
                if (enabled)
                    item.connect('activate', () => this._ext.menuClick(id));
                else
                    item.setSensitive(false);
                this.menu.addMenuItem(item);
            }
            this.menu.open();
        });
    }

    _syncTip() {
        if (this._tipId) {
            GLib.source_remove(this._tipId);
            this._tipId = 0;
        }
        if (!this.hover || this.menu.isOpen || this._ext.popoverOpen()) {
            this._hideTip();
            return;
        }
        this._tipId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TIP_DELAY_MS, () => {
            this._tipId = 0;
            this._showTip();
            return GLib.SOURCE_REMOVE;
        });
    }

    _showTip() {
        if (!this._tip) {
            this._tip = new St.Label({style_class: 'nightshift-tip'});
            Main.uiGroup.add_child(this._tip);
        }
        this._tip.text = this._tipText;
        this._tip.show();
        const [x, y] = this.get_transformed_position();
        const [w, h] = this.get_transformed_size();
        const m = Main.layoutManager.findMonitorForActor(this);
        if (!m)
            return;
        const [tw, th] = [this._tip.width, this._tip.height];
        const tx = Math.max(m.x + GAP, Math.min(x + w / 2 - tw / 2, m.x + m.width - tw - GAP));
        const ty = y + h / 2 < m.y + m.height / 2 ? y + h + GAP : y - th - GAP;
        this._tip.set_position(Math.round(tx), Math.round(ty));
    }

    _hideTip() {
        this._tip?.hide();
    }
});

export default class NightshiftTrayExtension extends Extension {
    enable() {
        this._pop = null; // the inbox window dropped from the icon
        this._popIds = [];
        this._stageId = 0;
        this._popFocused = false;
        this._want = 0; // the pid the app said the inbox started as
        this._wantUntil = 0;
        this._closedAt = 0;
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
        this._cancel = new Gio.Cancellable();
        this._proxy = new TrayProxy(Gio.DBus.session, BUS, PATH, (proxy, error) => {
            if (error && !error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`aico-tray: ${error.message}`);
            else if (!error && proxy === this._proxy)
                this._sync();
        }, this._cancel, Gio.DBusProxyFlags.DO_NOT_AUTO_START);
        this._proxyIds = [
            this._proxy.connect('g-properties-changed', () => this._sync()),
            this._proxy.connect('notify::g-name-owner', () => this._sync()),
        ];
        this._signalId = this._proxy.connectSignal('PanelOpened', (_p, _sender, [pid]) => this._expect(pid));
        this._displayIds = [
            global.display.connect('window-created', (_d, win) => this._adoptIfOurs(win)),
            global.display.connect('notify::focus-window', () => this._onFocus()),
        ];
        this._nameId = Gio.bus_own_name(Gio.BusType.SESSION, SHELL_NAME, Gio.BusNameOwnerFlags.NONE, null, null, null);
        this._sync();
    }

    disable() {
        Gio.bus_unown_name(this._nameId);
        this._nameId = 0;
        this._cancel.cancel();
        for (const id of this._displayIds)
            global.display.disconnect(id);
        this._displayIds = [];
        // the screen locked (or the extension was turned off): the inbox goes too, nothing would close it later
        this._close();
        for (const id of this._proxyIds)
            this._proxy.disconnect(id);
        this._proxy.disconnectSignal(this._signalId);
        this._proxy = null;
        this._indicator.destroy();
        this._indicator = null;
    }

    _up() {
        return Boolean(this._proxy?.g_name_owner);
    }

    _sync() {
        const p = this._proxy;
        if (!this._indicator || !p)
            return;
        const up = this._up();
        this._indicator.show_state({
            up,
            icon: up ? p.Icon ?? '' : '',
            label: up ? p.Label ?? '' : '',
            attention: up && Boolean(p.Attention),
            tip: up ? p.ToolTip || 'Aico' : NOT_RUNNING,
        });
    }

    popoverOpen() {
        return this._pop !== null;
    }

    // A click on the icon: close the inbox when it is up, else ask the app for it (it answers with PanelOpened).
    toggle() {
        if (this._pop) {
            this._close();
            return;
        }
        if (now() - this._closedAt < REOPEN_GUARD_US || !this._up())
            return;
        this._proxy.OpenRemote((_r, error) => {
            if (error)
                console.warn(`aico-tray: Open: ${error.message}`);
        });
    }

    menuRows(done) {
        if (!this._up()) {
            done(null);
            return;
        }
        this._proxy.MenuRemote((res, error) => {
            if (error)
                console.warn(`aico-tray: Menu: ${error.message}`);
            done(error ? null : res[0]);
        });
    }

    menuClick(id) {
        this._proxy?.MenuClickRemote(id, (_r, error) => {
            if (error)
                console.warn(`aico-tray: MenuClick: ${error.message}`);
        });
    }

    _expect(pid) {
        this._want = pid;
        this._wantUntil = now() + ADOPT_WINDOW_US;
        for (const actor of global.get_window_actors())
            this._adoptIfOurs(actor.meta_window, true);
    }

    _adoptIfOurs(win, shown = false) {
        if (!this._want || this._pop || now() > this._wantUntil)
            return;
        if (win.get_pid() !== this._want || win.get_window_type() !== Meta.WindowType.NORMAL)
            return;
        this._want = 0;
        this._pop = win;
        this._popFocused = false;
        win.make_above();
        this._place();
        this._popIds = [
            win.connect('size-changed', () => this._place()),
            win.connect('shown', () => {
                this._place();
                Main.activateWindow(win);
            }),
            win.connect('unmanaged', () => this._forget()),
        ];
        // a click on the desktop or the shell moves no focus: the stage sees it (clicks in windows go to them)
        this._stageId = global.stage.connect('captured-event', (_a, event) => this._onStageEvent(event));
        if (Main.overview.visible)
            Main.overview.hide(); // the overview hides the inbox (it lists no skip-taskbar window)
        if (shown)
            Main.activateWindow(win);
        this._indicator?._syncTip();
    }

    // Under the icon (over it when the panel is at the bottom), inside the work area.
    _place() {
        const win = this._pop;
        const ind = this._indicator;
        if (!win || !ind)
            return;
        const idx = Main.layoutManager.findIndexForActor(ind);
        const m = Main.layoutManager.monitors[idx];
        if (!m)
            return;
        const wa = Main.layoutManager.getWorkAreaForMonitor(idx);
        const f = win.get_frame_rect();
        const [ix, iy] = ind.get_transformed_position();
        const [iw, ih] = ind.get_transformed_size();
        const [x, y] = spot({x: ix, y: iy, w: iw, h: ih}, {w: f.width, h: f.height},
            {x: m.x, y: m.y, w: m.width, h: m.height}, {x: wa.x, y: wa.y, w: wa.width, h: wa.height}, GAP);
        if (f.x !== x || f.y !== y)
            win.move_frame(true, x, y);
    }

    // Focus went from the inbox to something else (a click outside it, Alt+Tab): it closes, like a popover.
    _onFocus() {
        const win = this._pop;
        if (!win)
            return;
        if (global.display.focus_window === win) {
            this._popFocused = true;
            return;
        }
        if (this._popFocused)
            this._close();
    }

    _onStageEvent(event) {
        const type = event.type();
        if (this._pop && (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN)) {
            const [x, y] = event.get_coords();
            const inside = (r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
            const f = this._pop.get_frame_rect();
            const [ix, iy] = this._indicator.get_transformed_position();
            const [iw, ih] = this._indicator.get_transformed_size();
            // the icon's own press toggles it (Indicator), a press in the inbox is the inbox's
            if (!inside({x: f.x, y: f.y, w: f.width, h: f.height}) && !inside({x: ix, y: iy, w: iw, h: ih}))
                this._close();
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _close() {
        const win = this._pop;
        this._forget();
        this._closedAt = now();
        win?.delete(global.get_current_time());
    }

    _forget() {
        if (this._pop) {
            for (const id of this._popIds)
                this._pop.disconnect(id);
        }
        if (this._stageId)
            global.stage.disconnect(this._stageId);
        this._stageId = 0;
        this._pop = null;
        this._popIds = [];
        this._popFocused = false;
    }
}

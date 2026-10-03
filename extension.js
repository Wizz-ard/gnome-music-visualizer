import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup?version=3.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import Cairo from 'gi://cairo';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

Gio._promisify(Gio.File.prototype, 'load_bytes_async', 'load_bytes_finish');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const TAU = 2 * Math.PI;

const LAYOUTS = {
    standard: {width: 340, art: 72, viz: 90},
    horizontal: {width: 540, art: 104, viz: 56},
    compact: {width: 400, art: 44, viz: 0},
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d !== 0) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h /= 6;
        if (h < 0) h += 1;
    }
    return [h, max === 0 ? 0 : d / max, max];
}

function hsvToRgb(h, s, v) {
    const i = Math.floor(h * 6), f = h * 6 - i;
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
    }
}

function roundRect(cr, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

function ellipse(cr, cx, cy, rx, ry) {
    cr.save();
    cr.translate(cx, cy);
    cr.scale(rx, ry);
    cr.arc(0, 0, 1, 0, TAU);
    cr.restore();
}

/* ------------------------------------------------------------------ */
/* MPRIS client                                                        */
/* ------------------------------------------------------------------ */

class MprisClient {
    constructor(onChange, settings) {
        this._onChange = onChange;
        this._settings = settings;
        this._players = new Map(); // bus name -> proxy (null while connecting)
        this._cancellable = new Gio.Cancellable();
        this._subId = 0;
    }

    start() {
        this._subId = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _sig, params) => {
                const [name, oldOwner, newOwner] = params.deepUnpack();
                if (!name.startsWith(MPRIS_PREFIX))
                    return;
                if (newOwner)
                    this._addPlayer(name);
                else if (oldOwner)
                    this._removePlayer(name);
            });

        Gio.DBus.session.call(
            'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'ListNames', null, new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (conn, res) => {
                try {
                    const [names] = conn.call_finish(res).deepUnpack();
                    names.filter(n => n.startsWith(MPRIS_PREFIX)).forEach(n => this._addPlayer(n));
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.error(`musicviz: ListNames failed: ${e}`);
                }
            });
    }

    stop() {
        this._cancellable.cancel();
        if (this._subId) {
            Gio.DBus.session.signal_unsubscribe(this._subId);
            this._subId = 0;
        }
        this._players.clear();
    }

    _addPlayer(name) {
        if (this._players.has(name))
            return;
        this._players.set(name, null);
        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null,
            name, MPRIS_PATH, MPRIS_PLAYER_IFACE, this._cancellable,
            (_o, res) => {
                try {
                    const proxy = Gio.DBusProxy.new_for_bus_finish(res);
                    if (!this._players.has(name))
                        return;
                    proxy.connect('g-properties-changed', () => this._onChange());
                    this._players.set(name, proxy);
                    this._onChange();
                } catch (e) {
                    this._players.delete(name);
                }
            });
    }

    _removePlayer(name) {
        this._players.delete(name);
        this._onChange();
    }

    _status(proxy) {
        return proxy.get_cached_property('PlaybackStatus')?.unpack() ?? 'Stopped';
    }

    /** Comma-separated setting -> lower-case list of substrings. */
    _patterns(key) {
        const raw = this._settings?.get_string(key) ?? '';
        return raw.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    }

    /** Pick which player to show: ignore list first, then preference, then playing state. */
    getState() {
        const ignored = this._patterns('ignored-players');
        const preferred = this._patterns('preferred-player');
        const strict = this._settings?.get_boolean('prefer-strict') ?? false;

        let best = null, bestScore = Infinity;
        for (const [name, proxy] of this._players) {
            if (!proxy)
                continue;
            const short = name.slice(MPRIS_PREFIX.length).toLowerCase();
            if (ignored.some(p => short.includes(p)))
                continue;
            const playing = this._status(proxy) === 'Playing';
            if (!playing && !proxy.get_cached_property('Metadata'))
                continue;
            const prefIdx = preferred.findIndex(p => short.includes(p));
            const isPref = prefIdx >= 0;
            // lower score wins; ties keep the first player found
            let score = (playing ? 0 : 2) + (isPref ? 0 : 1) + (isPref ? prefIdx * 0.1 : 0);
            if (strict && isPref)
                score = (playing ? -2 : -1) + prefIdx * 0.1;
            if (score < bestScore) {
                best = proxy;
                bestScore = score;
            }
        }
        if (!best)
            return null;

        const meta = best.get_cached_property('Metadata')?.recursiveUnpack() ?? {};
        const artist = meta['xesam:artist'];
        return {
            title: meta['xesam:title'] || 'Unknown title',
            artist: Array.isArray(artist) ? artist.join(', ') : (artist || ''),
            artUrl: meta['mpris:artUrl'] || '',
            length: Number(meta['mpris:length'] ?? 0),
            trackId: String(meta['mpris:trackid'] ?? ''),
            playing: this._status(best) === 'Playing',
            shuffle: best.get_cached_property('Shuffle')?.unpack() ?? null,
            loop: best.get_cached_property('LoopStatus')?.unpack() ?? null,
            volume: best.get_cached_property('Volume')?.unpack() ?? null,
            proxy: best,
        };
    }

    /** Ask the current player to bring its window to the front. */
    raise() {
        const st = this.getState();
        if (!st)
            return;
        Gio.DBus.session.call(
            st.proxy.get_name(), MPRIS_PATH, 'org.mpris.MediaPlayer2', 'Raise',
            null, null, Gio.DBusCallFlags.NONE, -1, null, this._logCb('Raise'));
    }

    _logCb(what) {
        return (src, res) => {
            try {
                src.call_finish(res);
            } catch (e) {
                console.warn(`musicviz: ${what} failed: ${e.message}`);
            }
        };
    }

    _call(method, params = null) {
        const st = this.getState();
        st?.proxy.call(method, params, Gio.DBusCallFlags.NONE, -1, null, this._logCb(method));
    }

    playPause() { this._call('PlayPause'); }
    next() { this._call('Next'); }
    previous() { this._call('Previous'); }

    setProp(st, prop, variant) {
        Gio.DBus.session.call(
            st.proxy.get_name(), MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Set',
            new GLib.Variant('(ssv)', [MPRIS_PLAYER_IFACE, prop, variant]),
            null, Gio.DBusCallFlags.NONE, -1, null, this._logCb(`set ${prop}`));
    }

    toggleShuffle(st) {
        if (st.shuffle !== null)
            this.setProp(st, 'Shuffle', GLib.Variant.new_boolean(!st.shuffle));
    }

    cycleLoop(st) {
        if (st.loop === null)
            return;
        const next = {None: 'Playlist', Playlist: 'Track', Track: 'None'}[st.loop] ?? 'None';
        this.setProp(st, 'LoopStatus', GLib.Variant.new_string(next));
    }

    setVolume(st, v) {
        this.setProp(st, 'Volume', GLib.Variant.new_double(v));
    }

    seek(st, posUs, curUs) {
        const cb = this._logCb('seek');
        const noTrack = !st.trackId || st.trackId.endsWith('/NoTrack');
        if (!noTrack) {
            try {
                st.proxy.call('SetPosition',
                    new GLib.Variant('(ox)', [st.trackId, Math.round(posUs)]),
                    Gio.DBusCallFlags.NONE, -1, null, cb);
                return;
            } catch (e) {
                // trackId wasn't a valid object path: fall back to relative Seek
            }
        }
        st.proxy.call('Seek', new GLib.Variant('(x)', [Math.round(posUs - curUs)]),
            Gio.DBusCallFlags.NONE, -1, null, cb);
    }

    /** Position is not a notifying property; cb(positionMicroseconds). */
    fetchPosition(proxy, cb) {
        Gio.DBus.session.call(
            proxy.get_name(), MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [MPRIS_PLAYER_IFACE, 'Position']),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, 1000, this._cancellable,
            (conn, res) => {
                try {
                    const [v] = conn.call_finish(res).recursiveUnpack();
                    cb(Number(v));
                } catch (e) {
                    // not supported / cancelled
                }
            });
    }
}

/* ------------------------------------------------------------------ */
/* Audio data source (cava, with simulated fallback)                   */
/* ------------------------------------------------------------------ */

class AudioSource {
    constructor(settings) {
        this._settings = settings;
        this.values = [];
        this._targets = [];
        this._proc = null;
        this._reader = null;
        this._cancellable = null;
        this._started = false;
        this._gotRealData = false;
        this.playing = false;
        this.beat = 0;          // 1 on a detected beat, decays to 0
        this._bassAvg = 0;
        this._lastBeat = 0;
        this._resize();
        this.applySettings();
    }

    applySettings() {
        this._sens = this._settings.get_double('sensitivity');
        const s = this._settings.get_double('smoothing');
        this._attack = Math.max(0.15, 1 - s * 0.8);
        this._release = Math.max(0.04, 0.6 * (1 - s));
    }

    _resize() {
        const n = this._settings.get_int('bar-count');
        if (this.values.length !== n) {
            this.values = new Array(n).fill(0);
            this._targets = new Array(n).fill(0);
        }
    }

    start() {
        if (this._started)
            return;
        this._started = true;
        this._resize();
        if (this._settings.get_boolean('use-cava'))
            this._startCava();
    }

    stop() {
        this._started = false;
        this._stopCava();
    }

    restart() {
        const was = this._started;
        this._stopCava();
        this._resize();
        if (was && this._settings.get_boolean('use-cava'))
            this._startCava();
    }

    _startCava() {
        const n = this._settings.get_int('bar-count');
        try {
            const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'musicviz']);
            GLib.mkdir_with_parents(dir, 0o755);
            const conf = GLib.build_filenamev([dir, 'cava.conf']);
            GLib.file_set_contents(conf, [
                '[general]', `bars = ${n}`, 'framerate = 30',
                '[input]', 'method = pulse', 'source = auto',
                '[output]', 'method = raw', 'raw_target = /dev/stdout',
                'data_format = ascii', 'ascii_max_range = 100',
                'bar_delimiter = 59', 'frame_delimiter = 10', '',
            ].join('\n'));

            this._proc = Gio.Subprocess.new(
                ['cava', '-p', conf],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            this._cancellable = new Gio.Cancellable();
            this._reader = Gio.DataInputStream.new(this._proc.get_stdout_pipe());
            this._readLine();
        } catch (e) {
            console.warn(`musicviz: cava unavailable, using simulated visualizer (${e.message})`);
            this._proc = null;
        }
    }

    _readLine() {
        if (!this._reader)
            return;
        this._reader.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (stream, res) => {
            try {
                const [line] = stream.read_line_finish_utf8(res);
                if (line === null)
                    return;
                const parts = line.split(';').filter(p => p !== '').map(p => Number(p) / 100);
                if (parts.length === this._targets.length) {
                    this._targets = parts;
                    this._gotRealData = true;
                }
                this._readLine();
            } catch (e) {
                // cancelled or closed
            }
        });
    }

    _stopCava() {
        this._cancellable?.cancel();
        this._cancellable = null;
        this._reader = null;
        try { this._proc?.force_exit(); } catch (e) { /* ignore */ }
        this._proc = null;
        this._gotRealData = false;
    }

    tick(timeSec) {
        const n = this.values.length;
        const bassBars = Math.max(1, Math.round(n * 0.2));
        let bass = 0;
        let active = false;
        for (let i = 0; i < n; i++) {
            let target;
            if (!this.playing) {
                target = 0;
            } else if (this._gotRealData) {
                target = this._targets[i] ?? 0;
            } else {
                const a = Math.abs(Math.sin(timeSec * (1.6 + (i % 5) * 0.37) + i * 0.6));
                const b = Math.abs(Math.sin(timeSec * 0.9 + i * 0.25));
                target = 0.15 + 0.6 * a * (0.5 + 0.5 * b) + Math.random() * 0.15;
            }
            target = Math.min(1, target * this._sens);
            if (i < bassBars)
                bass += target;
            const cur = this.values[i];
            const next = target > cur
                ? cur + (target - cur) * this._attack
                : cur + (target - cur) * this._release;
            this.values[i] = next < 0.004 && target === 0 ? 0 : next;
            if (this.values[i] > 0)
                active = true;
        }

        // simple beat detector: bass energy jumping above its running average
        if (!this.playing) {
            this.beat = 0;
            this._bassAvg = 0;
        } else {
            bass /= bassBars;
            if (bass > this._bassAvg * 1.3 + 0.08 && timeSec - this._lastBeat > 0.2) {
                this.beat = 1;
                this._lastBeat = timeSec;
            } else {
                this.beat *= 0.8;
                if (this.beat < 0.02)
                    this.beat = 0;
            }
            this._bassAvg = this._bassAvg * 0.92 + bass * 0.08;
        }
        return active;
    }
}

/* ------------------------------------------------------------------ */
/* Desktop widget                                                      */
/* ------------------------------------------------------------------ */

const MusicVizWidget = GObject.registerClass(
class MusicVizWidget extends St.BoxLayout {
    _init(ext, settings) {
        super._init({vertical: true, style_class: 'musicviz-card', reactive: true});
        this._ext = ext;
        this._settings = settings;
        this._cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'musicviz']);
        GLib.mkdir_with_parents(this._cacheDir, 0o755);

        // colours: current (animated) and target
        this._bg = [40, 40, 48];
        this._bgT = [40, 40, 48];
        this._accent = [0.4, 0.8, 1.0];
        this._accentT = [0.4, 0.8, 1.0];
        // second colour (gradient end): from the album art, or a default
        this._bg2 = [18, 18, 22];
        this._bg2T = [18, 18, 22];
        this._accent2 = [0.72, 0.52, 1.0];
        this._accent2T = [0.72, 0.52, 1.0];
        this._lastClick = null;
        this._showViz = true;
        this._textReserve = 0;
        this._favs = this._loadFavs();

        this._lastArtUrl = null;
        this._tickId = 0;
        this._posTimerId = 0;
        this._seekTimerId = 0;
        this._startTime = GLib.get_monotonic_time() / 1e6;
        this._session = new Soup.Session();
        this._cancellable = new Gio.Cancellable();

        this._playing = false;
        this._lengthUs = 0;
        this._posUs = 0;
        this._posStamp = GLib.get_monotonic_time();
        this._trackKey = '';
        this._progDirty = true;
        this._t = 0;
        this._pausedAt = 0;
        this._jumpT = -10;
        this._seekFrac = null;
        this._progGrab = null;
        this._grab = null;
        this._dragOrigin = null;
        this._flashText = null;
        this._flashUntil = 0;
        this._artistText = '';
        this._volTarget = null;
        this._volTargetUntil = 0;
        this._lastState = null;
        this._settingsIds = [];
        this._marquees = [];

        this._buildContents();
        this._buildContextMenu();
        this._connectInput();

        this._audio = new AudioSource(this._settings);
        this._mpris = new MprisClient(() => this._refresh(), this._settings);
        this._mpris.start();

        const on = (keys, fn) => keys.forEach(k =>
            this._settingsIds.push(this._settings.connect(`changed::${k}`, fn)));
        on(['opacity', 'gradient-colors'], () => {
            this._applyStyle();
            this._progDirty = true;
        });
        on(['preferred-player', 'ignored-players', 'prefer-strict'], () => this._refresh());
        on(['show-like'], () => this._updateExtraButtons(this._lastState));
        on(['custom-size', 'widget-width', 'widget-height'], () => {
            this._applySize();
            this.clampToStage();
        });
        on(['dynamic-color'], () => this._onArtChanged());
        on(['visualizer-style', 'bar-gap', 'rounded-bars'], () => this._viz.queue_repaint());
        on(['bar-count', 'use-cava'], () => this._audio.restart());
        on(['sensitivity', 'smoothing'], () => this._audio.applySettings());
        on(['widget-visible'], () => this._syncVisibility());
        on(['widget-scale'], () => this._applyScale());
        on(['layout', 'show-art', 'show-time', 'show-visualizer'], () => this._applyLayout());
        on(['character', 'character-size'], () => this._applyCharacter());
        on(['blur-enabled', 'blur-strength'], () => this._applyBlur());

        this._syncVisibility();
        this._applyLayout();
        this._applyCharacter();
        this._applyBlur();
        this._startAnimation();
        this._posTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            if (this.visible && this._playing)
                this._pollPosition();
            return GLib.SOURCE_CONTINUE;
        });
        this._refresh();
    }

    /* ---------------- construction ---------------- */

    _marqueeBox(styleClass) {
        const label = new St.Label({text: '', style_class: styleClass});
        label.clutter_text.ellipsize = 0; // Pango.EllipsizeMode.NONE
        const box = new St.Widget({clip_to_allocation: true});
        box.add_child(label);
        const m = {label, box, boxW: 200, startT: 0};
        this._marquees.push(m);
        return m;
    }

    _buildContents() {
        this._art = new St.Icon({
            icon_name: 'audio-x-generic-symbolic', icon_size: 72, style_class: 'musicviz-art',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._titleM = this._marqueeBox('musicviz-title');
        this._artistM = this._marqueeBox('musicviz-artist');
        this._titleM.label.text = 'Nothing playing';
        this._textBox = new St.BoxLayout({
            vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        });
        this._textBox.add_child(this._titleM.box);
        this._textBox.add_child(this._artistM.box);

        this._viz = new St.DrawingArea({height: 90, x_expand: true});
        this._viz.connect('repaint', area => this._draw(area));

        this._prog = new St.DrawingArea({height: 34, x_expand: true, reactive: true});
        this._prog._mvInteractive = true;
        this._prog.connect('repaint', area => this._drawProgress(area));
        this._connectProgressInput();

        this._timeRow = new St.BoxLayout({x_expand: true});
        this._elapsedLabel = new St.Label({text: '0:00', style_class: 'musicviz-time', x_expand: true});
        this._totalLabel = new St.Label({text: '0:00', style_class: 'musicviz-time'});
        this._timeRow.add_child(this._elapsedLabel);
        this._timeRow.add_child(this._totalLabel);

        const mkBtn = (icon, cb, cls = '', size = 18) => {
            const btn = new St.Button({
                style_class: `musicviz-btn ${cls}`.trim(),
                child: new St.Icon({icon_name: icon, icon_size: size}),
                can_focus: true, reactive: true,
            });
            btn.connect('clicked', cb);
            return btn;
        };
        this._shuffleBtn = mkBtn('media-playlist-shuffle-symbolic', () => {
            const st = this._mpris.getState();
            if (st) this._mpris.toggleShuffle(st);
        }, 'musicviz-btn-small', 14);
        this._prevBtn = mkBtn('media-skip-backward-symbolic', () => this._mpris.previous());
        this._playBtn = mkBtn('media-playback-start-symbolic', () => this._mpris.playPause(),
            'musicviz-btn-main', 22);
        this._nextBtn = mkBtn('media-skip-forward-symbolic', () => this._mpris.next());
        this._repeatBtn = mkBtn('media-playlist-repeat-symbolic', () => {
            const st = this._mpris.getState();
            if (st) this._mpris.cycleLoop(st);
        }, 'musicviz-btn-small', 14);

        this._likeBtn = mkBtn('emblem-favorite-symbolic', () => this._toggleLike(),
            'musicviz-btn-small', 14);
        this._likeBtn.child.gicon =
            Gio.ThemedIcon.new_from_names(['emblem-favorite-symbolic', 'starred-symbolic']);

        this._controls = new St.BoxLayout({
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 12px;',
        });
        [this._shuffleBtn, this._prevBtn, this._playBtn, this._nextBtn, this._repeatBtn,
            this._likeBtn]
            .forEach(b => this._controls.add_child(b));

        this._layoutBoxes = [];
        this._applyStyle();
    }

    _applyLayout() {
        const layout = LAYOUTS[this._settings.get_string('layout')]
            ? this._settings.get_string('layout') : 'standard';
        const L = LAYOUTS[layout];
        const showArt = this._settings.get_boolean('show-art');
        const showTime = this._settings.get_boolean('show-time');
        const showViz = this._settings.get_boolean('show-visualizer') && L.viz > 0;

        // detach everything and drop the old container boxes
        for (const a of [this._art, this._textBox, this._viz, this._prog, this._timeRow, this._controls])
            a.get_parent()?.remove_child(a);
        this._layoutBoxes.forEach(b => b.destroy());
        this._layoutBoxes = [];

        this._art.icon_size = L.art;
        this._viz.height = Math.max(L.viz, 1);
        this._showViz = showViz;

        if (layout === 'horizontal') {
            this.vertical = false;
            if (showArt)
                this.add_child(this._art);
            const side = new St.BoxLayout({vertical: true, x_expand: true, style: 'spacing: 8px;'});
            this._layoutBoxes.push(side);
            side.add_child(this._textBox);
            if (showViz)
                side.add_child(this._viz);
            side.add_child(this._prog);
            if (showTime)
                side.add_child(this._timeRow);
            side.add_child(this._controls);
            this.add_child(side);
            this._textReserve = showArt ? L.art + 12 : 0;
        } else if (layout === 'compact') {
            this.vertical = true;
            const row = new St.BoxLayout({style: 'spacing: 12px;'});
            this._layoutBoxes.push(row);
            if (showArt)
                row.add_child(this._art);
            row.add_child(this._textBox);
            row.add_child(this._controls);
            this.add_child(row);
            this.add_child(this._prog);
            if (showTime)
                this.add_child(this._timeRow);
            this._textReserve = (showArt ? L.art + 12 : 0) + 150 + 12;
        } else {
            this.vertical = true;
            const header = new St.BoxLayout({style: 'spacing: 12px;'});
            this._layoutBoxes.push(header);
            if (showArt)
                header.add_child(this._art);
            header.add_child(this._textBox);
            this.add_child(header);
            if (showViz)
                this.add_child(this._viz);
            this.add_child(this._prog);
            if (showTime)
                this.add_child(this._timeRow);
            this.add_child(this._controls);
            this._textReserve = showArt ? L.art + 12 : 0;
        }

        this._applySize();
        this._compact = layout === 'compact';
        this._updateExtraButtons(this._lastState);
        this._applyStyle();
        this.clampToStage();
    }

    /**
     * Card width/height. Automatic = the layout's default width. Custom = the
     * user's width/height; extra height goes to the visualizer.
     * wOverride/hOverride are used for live Ctrl+drag resizing.
     */
    _applySize(wOverride = null, hOverride = null) {
        const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
        const layout = LAYOUTS[this._settings.get_string('layout')]
            ? this._settings.get_string('layout') : 'standard';
        const L = LAYOUTS[layout];
        const custom = this._settings.get_boolean('custom-size') || wOverride !== null;

        let width = L.width, height = 0;
        if (custom) {
            width = clamp(wOverride ?? this._settings.get_int('widget-width'), 220, 900);
            height = clamp(hOverride ?? this._settings.get_int('widget-height'), 120, 900);
        }
        this.width = width;

        const textW = Math.max(80, width - 32 - this._textReserve); // 32 = card padding
        for (const m of [this._titleM, this._artistM]) {
            m.boxW = textW;
            m.box.width = textW;
            m.startT = this._t;
        }

        if (custom && this._showViz) {
            // measure everything except the visualizer, give the rest to it
            this._viz.height = 1;
            const natural = this.get_preferred_height(width)[1];
            this._viz.height = Math.max(24, Math.round(height - (natural - 1)));
        } else {
            this._viz.height = Math.max(L.viz, 1);
        }
        this._progDirty = true;
    }

    _applyCharacter() {
        const ch = this._settings.get_string('character');
        const sz = this._settings.get_double('character-size');
        this._prog.height = ch === 'none' ? 18 : Math.round(24 * sz + 14);
        this._progDirty = true;
    }

    _applyBlur() {
        this.remove_effect_by_name('musicviz-blur');
        const sigma = this._settings.get_int('blur-strength');
        if (!this._settings.get_boolean('blur-enabled') || sigma <= 0)
            return;
        try {
            const fx = new Shell.BlurEffect({mode: Shell.BlurMode.BACKGROUND, brightness: 1.0});
            if ('sigma' in fx)
                fx.sigma = sigma;
            else if ('radius' in fx)
                fx.radius = sigma * 2;
            this.add_effect_with_name('musicviz-blur', fx);
        } catch (e) {
            console.warn(`musicviz: blur unavailable: ${e.message}`);
        }
    }

    _syncVisibility() {
        this.visible = this._settings.get_boolean('widget-visible');
    }

    /* ---------------- context menu ---------------- */

    _buildContextMenu() {
        this._menuAnchor = new St.Widget({width: 1, height: 1, opacity: 0});
        Main.uiGroup.add_child(this._menuAnchor);
        this._menu = new PopupMenu.PopupMenu(this._menuAnchor, 0.0, St.Side.TOP);
        Main.uiGroup.add_child(this._menu.actor ?? this._menu);
        (this._menu.actor ?? this._menu).hide();
        this._menuManager = new PopupMenu.PopupMenuManager(this);
        this._menuManager.addMenu(this._menu);

        this._addRadio('Layout', 'layout',
            [['standard', 'Standard'], ['horizontal', 'Horizontal'], ['compact', 'Compact']]);
        this._addRadio('Visualizer style', 'visualizer-style',
            [['bars', 'Bars'], ['mirror', 'Mirrored bars'], ['wave', 'Wave'], ['dots', 'Dots']]);
        this._addRadio('Character', 'character',
            [['cat', 'Cat'], ['dog', 'Dog'], ['rocket', 'Rocket'], ['note', 'Music note'], ['none', 'None']]);

        const lock = new PopupMenu.PopupSwitchMenuItem('Lock position',
            this._settings.get_boolean('locked'));
        lock.connect('toggled', (_i, state) => this._settings.set_boolean('locked', state));
        this._settingsIds.push(this._settings.connect('changed::locked', () =>
            lock.setToggleState(this._settings.get_boolean('locked'))));
        this._menu.addMenuItem(lock);

        const reset = new PopupMenu.PopupMenuItem('Reset position');
        reset.connect('activate', () => this.resetPosition());
        this._menu.addMenuItem(reset);

        const resetSize = new PopupMenu.PopupMenuItem('Reset size');
        resetSize.connect('activate', () => this._settings.set_boolean('custom-size', false));
        this._menu.addMenuItem(resetSize);

        const favItem = new PopupMenu.PopupMenuItem('Open favourites list');
        favItem.connect('activate', () => this._openFavs());
        this._menu.addMenuItem(favItem);

        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const prefs = new PopupMenu.PopupMenuItem('Settings…');
        prefs.connect('activate', () => this._ext.openPreferences());
        this._menu.addMenuItem(prefs);
    }

    _addRadio(title, key, options) {
        const sub = new PopupMenu.PopupSubMenuMenuItem(title);
        const items = new Map();
        const sync = () => {
            const cur = this._settings.get_string(key);
            for (const [v, it] of items)
                it.setOrnament(v === cur ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
        };
        for (const [value, label] of options) {
            const it = new PopupMenu.PopupMenuItem(label);
            it.connect('activate', () => this._settings.set_string(key, value));
            sub.menu.addMenuItem(it);
            items.set(value, it);
        }
        sync();
        this._settingsIds.push(this._settings.connect(`changed::${key}`, sync));
        this._menu.addMenuItem(sub);
    }

    _openMenu(event) {
        const [px, py] = event.get_coords();
        this._menuAnchor.set_position(px, py);
        this._menu.open();
        this._menuManager.ignoreRelease?.();
    }

    /* ---------------- input: drag, scroll, right click ---------------- */

    _hitActor(event) {
        try {
            const [x, y] = event.get_coords();
            return global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        } catch (e) {
            return null;
        }
    }

    _isInteractive(actor) {
        for (let a = actor; a && a !== this; a = a.get_parent()) {
            if (a instanceof St.Button || a._mvInteractive)
                return true;
        }
        return false;
    }

    _connectInput() {
        this.connect('button-press-event', (_a, event) => {
            const btn = event.get_button();
            if (btn === 3) {
                this._openMenu(event);
                return Clutter.EVENT_STOP;
            }
            if (btn !== 1)
                return Clutter.EVENT_PROPAGATE;
            if (this._isInteractive(this._hitActor(event)))
                return Clutter.EVENT_PROPAGATE;
            const [px, py] = event.get_coords();
            if (this._isDoubleClick(px, py)) {
                this._dragOrigin = null;
                this._doubleClickAction();
                return Clutter.EVENT_STOP;
            }
            if (this._settings.get_boolean('locked'))
                return Clutter.EVENT_PROPAGATE;
            const [, , mods] = global.get_pointer();
            const resize = !!(mods & Clutter.ModifierType.CONTROL_MASK);
            this._dragOrigin = {
                px, py, x: this.x, y: this.y, active: false,
                resize, w: this.width, h: this.height,
            };
            return Clutter.EVENT_PROPAGATE; // never swallow the click
        });

        this.connect('motion-event', (_a, event) => {
            const o = this._dragOrigin;
            if (!o)
                return Clutter.EVENT_PROPAGATE;
            const [, , mods] = global.get_pointer();
            if (!(mods & Clutter.ModifierType.BUTTON1_MASK)) {
                this._dragOrigin = null;
                return Clutter.EVENT_PROPAGATE;
            }
            const [px, py] = event.get_coords();
            if (!o.active) {
                if (Math.hypot(px - o.px, py - o.py) < 6)
                    return Clutter.EVENT_PROPAGATE;
                o.active = true;
                this._grab = global.stage.grab(this);
            }
            if (o.resize) {
                // Ctrl + drag: resize (width and height, in unscaled pixels)
                const sc = this._scale();
                o.nw = Math.min(900, Math.max(220, Math.round(o.w + (px - o.px) / sc)));
                o.nh = Math.min(900, Math.max(120, Math.round(o.h + (py - o.py) / sc)));
                this._applySize(o.nw, o.nh);
                return Clutter.EVENT_STOP;
            }
            this.set_position(Math.round(o.x + px - o.px), Math.round(o.y + py - o.py));
            return Clutter.EVENT_STOP;
        });

        this.connect('button-release-event', () => {
            const o = this._dragOrigin;
            if (!o)
                return Clutter.EVENT_PROPAGATE;
            this._dragOrigin = null;
            if (!o.active)
                return Clutter.EVENT_PROPAGATE;
            this._grab?.dismiss();
            this._grab = null;
            if (o.resize) {
                if (o.nw !== undefined) {
                    this._settings.set_int('widget-width', o.nw);
                    this._settings.set_int('widget-height', o.nh);
                    this._settings.set_boolean('custom-size', true);
                }
                this.clampToStage();
                return Clutter.EVENT_STOP;
            }
            this.clampToStage();
            this._settings.set_int('widget-x', Math.round(this.x));
            this._settings.set_int('widget-y', Math.round(this.y));
            return Clutter.EVENT_STOP;
        });

        this.connect('leave-event', () => {
            if (this._dragOrigin && !this._dragOrigin.active)
                this._dragOrigin = null;
            return Clutter.EVENT_PROPAGATE;
        });

        // scroll: volume; Ctrl + scroll: resize
        this.connect('scroll-event', (_a, event) => {
            const dir = event.get_scroll_direction();
            let d = 0;
            if (dir === Clutter.ScrollDirection.UP)
                d = 1;
            else if (dir === Clutter.ScrollDirection.DOWN)
                d = -1;
            else if (dir === Clutter.ScrollDirection.SMOOTH)
                d = event.get_scroll_delta()[1] < 0 ? 1 : -1;
            if (!d)
                return Clutter.EVENT_PROPAGATE;

            const [, , mods] = global.get_pointer();
            if (mods & Clutter.ModifierType.CONTROL_MASK) {
                const ns = Math.min(2.0, Math.max(0.5,
                    Math.round((this._scale() + d * 0.05) * 100) / 100));
                this._settings.set_double('widget-scale', ns);
                return Clutter.EVENT_STOP;
            }

            const st = this._mpris.getState();
            if (!st)
                return Clutter.EVENT_PROPAGATE;
            if (st.volume === null) {
                this._flash('Volume not supported');
                return Clutter.EVENT_STOP;
            }
            const base = this._t < this._volTargetUntil ? this._volTarget : st.volume;
            const v = Math.min(1, Math.max(0, Math.round((base + d * 0.05) * 100) / 100));
            this._volTarget = v;
            this._volTargetUntil = this._t + 1.5;
            this._mpris.setVolume(st, v);
            this._flash(`Volume ${Math.round(v * 100)}%`);
            return Clutter.EVENT_STOP;
        });
    }

    _isDoubleClick(px, py) {
        const now = GLib.get_monotonic_time() / 1000;
        const c = this._lastClick;
        if (c && now - c.t < 400 && Math.hypot(px - c.x, py - c.y) < 10) {
            this._lastClick = null;
            return true;
        }
        this._lastClick = {t: now, x: px, y: py};
        return false;
    }

    _doubleClickAction() {
        switch (this._settings.get_string('double-click-action')) {
        case 'raise': this._mpris.raise(); break;
        case 'playpause': this._mpris.playPause(); break;
        default: break;
        }
    }

    _connectProgressInput() {
        this._prog.connect('button-press-event', (_a, event) => {
            if (event.get_button() !== 1)
                return Clutter.EVENT_PROPAGATE;
            if (!(this._lengthUs > 0))
                return Clutter.EVENT_STOP;
            this._seekFrac = this._progFrac(event);
            this._progGrab = global.stage.grab(this._prog);
            this._progDirty = true;
            return Clutter.EVENT_STOP;
        });
        this._prog.connect('motion-event', (_a, event) => {
            if (this._seekFrac === null)
                return Clutter.EVENT_PROPAGATE;
            this._seekFrac = this._progFrac(event);
            this._progDirty = true;
            return Clutter.EVENT_STOP;
        });
        this._prog.connect('button-release-event', (_a, event) => {
            if (this._seekFrac === null)
                return Clutter.EVENT_PROPAGATE;
            const f = this._progFrac(event);
            this._seekFrac = null;
            this._progGrab?.dismiss();
            this._progGrab = null;
            this._seekTo(f);
            return Clutter.EVENT_STOP;
        });
    }

    _progFrac(event) {
        const [ex, ey] = event.get_coords();
        const [, lx] = this._prog.transform_stage_point(ex, ey);
        const w = Math.max(this._prog.width, 40);
        return Math.min(1, Math.max(0, (lx - 18) / (w - 36)));
    }

    _seekTo(frac) {
        const st = this._mpris.getState();
        if (!st || !(this._lengthUs > 0))
            return;
        const pos = Math.round(frac * this._lengthUs);
        this._mpris.seek(st, pos, this._currentPosUs());
        this._posUs = pos;
        this._posStamp = GLib.get_monotonic_time();
        this._progDirty = true;
        this._jumpT = this._t; // the character hops!
        if (this._seekTimerId)
            GLib.source_remove(this._seekTimerId);
        this._seekTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._seekTimerId = 0;
            this._pollPosition();
            return GLib.SOURCE_REMOVE;
        });
    }

    /* ---------------- positioning / scale ---------------- */

    _scale() {
        return this._settings.get_double('widget-scale');
    }

    _baseWidth() {
        if (this._settings.get_boolean('custom-size'))
            return Math.min(900, Math.max(220, this._settings.get_int('widget-width')));
        return (LAYOUTS[this._settings.get_string('layout')] ?? LAYOUTS.standard).width;
    }

    _applyScale() {
        const sc = this._scale();
        this.set_scale(sc, sc);
        this.clampToStage();
    }

    setInitialPosition() {
        const x = this._settings.get_int('widget-x');
        const y = this._settings.get_int('widget-y');
        if (x < 0 || y < 0) {
            this.resetPosition();
        } else {
            this.set_position(x, y);
            this.clampToStage();
        }
    }

    resetPosition() {
        const mon = Main.layoutManager.primaryMonitor;
        this.set_position(
            mon.x + mon.width - this._baseWidth() * this._scale() - 40,
            mon.y + Math.max(Main.panel.height, 0) + 40);
        this.clampToStage();
        this._settings.set_int('widget-x', Math.round(this.x));
        this._settings.set_int('widget-y', Math.round(this.y));
    }

    clampToStage() {
        const sc = this._scale();
        const [sw, sh] = global.stage.get_size();
        const w = this._baseWidth() * sc;
        const h = (this.height || 240) * sc;
        const minY = Main.panel.height;
        const x = Math.min(Math.max(0, this.x), Math.max(0, sw - w));
        const y = Math.min(Math.max(minY, this.y), Math.max(minY, sh - h));
        this.set_position(Math.round(x), Math.round(y));
    }

    /* ---------------- state refresh ---------------- */

    _setText(m, text) {
        if (m.label.text === text)
            return;
        m.label.text = text;
        m.label.translation_x = 0;
        m.startT = this._t;
    }

    _applyArtistText() {
        this._setText(this._artistM, this._flashText ?? this._artistText);
    }

    _flash(text) {
        this._flashText = text;
        this._flashUntil = this._t + 1.3;
        this._applyArtistText();
    }

    _updateExtraButtons(st) {
        const compact = this._compact;
        this._shuffleBtn.visible = !compact && !!st && st.shuffle !== null;
        this._repeatBtn.visible = !compact && !!st && st.loop !== null;
        this._likeBtn.visible = !compact && !!st && this._settings.get_boolean('show-like');
        if (!st)
            return;
        if (this._isFav(st)) this._likeBtn.add_style_class_name('musicviz-btn-active');
        else this._likeBtn.remove_style_class_name('musicviz-btn-active');
        if (st.shuffle !== null) {
            if (st.shuffle) this._shuffleBtn.add_style_class_name('musicviz-btn-active');
            else this._shuffleBtn.remove_style_class_name('musicviz-btn-active');
        }
        if (st.loop !== null) {
            this._repeatBtn.child.icon_name = st.loop === 'Track'
                ? 'media-playlist-repeat-song-symbolic' : 'media-playlist-repeat-symbolic';
            if (st.loop !== 'None') this._repeatBtn.add_style_class_name('musicviz-btn-active');
            else this._repeatBtn.remove_style_class_name('musicviz-btn-active');
        }
    }

    /* ---------------- local favourites (MPRIS has no "like" call) ---------------- */

    _favPath() {
        return GLib.build_filenamev([GLib.get_user_data_dir(), 'musicviz', 'favorites.json']);
    }

    _loadFavs() {
        try {
            const [ok, data] = GLib.file_get_contents(this._favPath());
            if (ok) {
                const obj = JSON.parse(new TextDecoder().decode(data));
                if (obj && typeof obj === 'object' && !Array.isArray(obj))
                    return obj;
            }
        } catch (e) {
            // no favourites saved yet
        }
        return {};
    }

    _saveFavs() {
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(this._favPath()), 0o755);
            GLib.file_set_contents(this._favPath(), JSON.stringify(this._favs, null, 2));
        } catch (e) {
            console.warn(`musicviz: could not save favourites: ${e.message}`);
        }
    }

    _favKey(st) {
        return `${st.title}|${st.artist}`;
    }

    _isFav(st) {
        return !!st && this._favKey(st) in this._favs;
    }

    _toggleLike() {
        const st = this._lastState;
        if (!st)
            return;
        const key = this._favKey(st);
        if (key in this._favs) {
            delete this._favs[key];
            this._flash('Removed from favourites');
        } else {
            this._favs[key] = {
                title: st.title, artist: st.artist, added: new Date().toISOString(),
            };
            this._flash('Added to favourites');
        }
        this._saveFavs();
        this._updateExtraButtons(st);
    }

    _openFavs() {
        try {
            if (!GLib.file_test(this._favPath(), GLib.FileTest.EXISTS))
                this._saveFavs();
            Gio.AppInfo.launch_default_for_uri(
                Gio.File.new_for_path(this._favPath()).get_uri(), null);
        } catch (e) {
            console.warn(`musicviz: could not open favourites: ${e.message}`);
        }
    }

    _refresh() {
        const st = this._mpris.getState();
        this._lastState = st;
        if (!st) {
            this._setText(this._titleM, 'Nothing playing');
            this._artistText = '';
            this._applyArtistText();
            this._audio.playing = false;
            this._audio.stop();
            this._setPlayIcon(false);
            if (this._playing)
                this._pausedAt = this._t;
            this._playing = false;
            this._lengthUs = 0;
            this._posUs = 0;
            this._trackKey = '';
            this._progDirty = true;
            this._updateTimeLabels();
            this._updateExtraButtons(null);
            if (this._lastArtUrl) {
                this._lastArtUrl = null;
                this._onArtChanged();
            }
            return;
        }

        this._setText(this._titleM, st.title);
        this._artistText = st.artist;
        this._applyArtistText();

        if (this._playing && !st.playing)
            this._pausedAt = this._t;
        this._playing = st.playing;
        this._lengthUs = st.length;
        const key = `${st.title}|${st.artist}|${st.length}`;
        if (key !== this._trackKey) {
            this._trackKey = key;
            this._posUs = 0;
            this._posStamp = GLib.get_monotonic_time();
        }
        this._pollPosition();
        this._progDirty = true;

        this._audio.playing = st.playing;
        if (st.playing)
            this._audio.start();
        else
            this._audio.stop();
        this._setPlayIcon(st.playing);
        this._updateExtraButtons(st);

        if (st.artUrl !== this._lastArtUrl) {
            this._lastArtUrl = st.artUrl;
            this._onArtChanged();
        }
    }

    _pollPosition() {
        const st = this._mpris.getState();
        if (!st)
            return;
        this._mpris.fetchPosition(st.proxy, pos => {
            this._posUs = pos;
            this._posStamp = GLib.get_monotonic_time();
            this._progDirty = true;
        });
    }

    _currentPosUs() {
        let p = this._posUs;
        if (this._playing)
            p += GLib.get_monotonic_time() - this._posStamp;
        if (this._lengthUs > 0)
            p = Math.min(p, this._lengthUs);
        return Math.max(0, p);
    }

    _fmt(us) {
        const s = Math.floor(us / 1e6);
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }

    _updateTimeLabels() {
        const pos = this._seekFrac !== null ? this._seekFrac * this._lengthUs : this._currentPosUs();
        const e = this._fmt(pos);
        const t = this._fmt(this._lengthUs);
        if (this._elapsedLabel.text !== e)
            this._elapsedLabel.text = e;
        if (this._totalLabel.text !== t)
            this._totalLabel.text = t;
    }

    _setPlayIcon(playing) {
        this._playBtn.child.icon_name = playing
            ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
    }

    /* ---------------- album art + colour ---------------- */

    async _onArtChanged() {
        const url = this._lastArtUrl;
        if (!url) {
            this._setDefaultColors();
            this._art.gicon = null;
            this._art.icon_name = 'audio-x-generic-symbolic';
            return;
        }
        try {
            const bytes = await this._loadBytes(url);
            if (url !== this._lastArtUrl)
                return;

            const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, url, -1);
            const path = GLib.build_filenamev([this._cacheDir, `art-${hash}`]);
            GLib.file_set_contents(path, bytes.get_data());
            this._art.gicon = Gio.FileIcon.new(Gio.File.new_for_path(path));

            if (this._settings.get_boolean('dynamic-color')) {
                this._extractColor(bytes);
            } else {
                this._setDefaultColors();
            }
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`musicviz: could not load art: ${e.message}`);
        }
    }

    async _loadBytes(url) {
        if (url.startsWith('file://'))
            return (await Gio.File.new_for_uri(url).load_bytes_async(this._cancellable))[0];
        const msg = Soup.Message.new('GET', url);
        return await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable);
    }

    _setDefaultColors() {
        this._bgT = [40, 40, 48];
        this._accentT = [0.4, 0.8, 1.0];
        this._bg2T = [18, 18, 22];
        this._accent2T = [0.72, 0.52, 1.0];
    }

    _extractColor(bytes) {
        const stream = Gio.MemoryInputStream.new_from_bytes(bytes);
        const pb = GdkPixbuf.Pixbuf.new_from_stream_at_scale(stream, 32, 32, false, null);
        const px = pb.get_pixels();
        const n = pb.get_n_channels(), rs = pb.get_rowstride();
        let sr = 0, sg = 0, sb = 0, sw = 0;
        const bins = Array.from({length: 12}, () => ({w: 0, r: 0, g: 0, b: 0}));
        for (let y = 0; y < pb.get_height(); y++) {
            for (let x = 0; x < pb.get_width(); x++) {
                const i = y * rs + x * n;
                const r = px[i], g = px[i + 1], b = px[i + 2];
                const [ph, s, v] = rgbToHsv(r, g, b);
                const w = (s * 0.8 + 0.05) * (v > 0.15 ? 1 : 0.1);
                sr += r * w; sg += g * w; sb += b * w; sw += w;
                const bin = bins[Math.floor(ph * 12) % 12];
                bin.w += w; bin.r += r * w; bin.g += g * w; bin.b += b * w;
            }
        }
        if (sw === 0)
            return;
        const [h, s, v] = rgbToHsv(sr / sw, sg / sw, sb / sw);
        this._bgT = hsvToRgb(h, Math.min(1, s * 1.05), Math.min(v, 0.5)).map(c => c * 255);
        this._accentT = hsvToRgb(h, Math.min(s, 0.75), Math.max(v, 0.95));

        // Second colour: the strongest hue at least 60 degrees away from the first.
        // If the cover is basically one colour, shift the hue a little instead.
        const first = Math.floor(h * 12) % 12;
        let bestBin = -1, bestW = 0;
        bins.forEach((bin, i) => {
            const d = Math.min((i - first + 12) % 12, (first - i + 12) % 12);
            if (d >= 2 && bin.w > bestW) {
                bestW = bin.w;
                bestBin = i;
            }
        });
        let h2, s2, v2;
        if (bestBin >= 0 && bestW > sw * 0.12) {
            const bn = bins[bestBin];
            [h2, s2, v2] = rgbToHsv(bn.r / bn.w, bn.g / bn.w, bn.b / bn.w);
        } else {
            h2 = (h + 0.1) % 1;
            s2 = s;
            v2 = v;
        }
        this._bg2T = hsvToRgb(h2, Math.min(1, s2 * 1.05), Math.min(v2, 0.42)).map(c => c * 255);
        this._accent2T = hsvToRgb(h2, Math.min(Math.max(s2, 0.35), 0.8), Math.max(v2, 0.95));
    }

    /** Smoothly move current colours towards their targets; true if anything changed. */
    _fadeColors() {
        let diff = false;
        const step = (cur, tgt, eps) => {
            for (let i = 0; i < 3; i++) {
                const d = tgt[i] - cur[i];
                if (d !== 0) {
                    diff = true;
                    cur[i] = Math.abs(d) < eps ? tgt[i] : cur[i] + d * 0.12;
                }
            }
        };
        step(this._bg, this._bgT, 0.5);
        step(this._bg2, this._bg2T, 0.5);
        step(this._accent, this._accentT, 0.004);
        step(this._accent2, this._accent2T, 0.004);
        if (diff) {
            this._applyStyle();
            this._progDirty = true;
        }
    }

    _applyStyle() {
        const op = this._settings.get_double('opacity');
        const [r, g, b] = this._bg.map(Math.round);
        const [r2, g2, b2] = this._settings.get_boolean('gradient-colors')
            ? this._bg2.map(Math.round)
            : [r, g, b].map(c => Math.round(c * 0.45));
        this.style =
            'background-gradient-direction: vertical; ' +
            `background-gradient-start: rgba(${r},${g},${b},${op}); ` +
            `background-gradient-end: rgba(${r2},${g2},${b2},${op}); ` +
            `box-shadow: 0 4px 24px rgba(0,0,0,${(0.35 * op).toFixed(2)});`;
        this._viz?.queue_repaint();
    }

    /* ---------------- animation ---------------- */

    _pose() {
        if (this._playing)
            return 'walk';
        return this._t - this._pausedAt > 8 ? 'sleep' : 'sit';
    }

    _tickMarquee(m, t) {
        const over = m.label.get_preferred_width(-1)[1] - m.boxW;
        if (over <= 1) {
            if (m.label.translation_x !== 0)
                m.label.translation_x = 0;
            return;
        }
        const pause = 1.5, speed = 35, dur = over / speed, T = 2 * (pause + dur);
        const ph = Math.max(0, t - m.startT) % T;
        let x;
        if (ph < pause) x = 0;
        else if (ph < pause + dur) x = -(ph - pause) * speed;
        else if (ph < 2 * pause + dur) x = -over;
        else x = -over + (ph - 2 * pause - dur) * speed;
        m.label.translation_x = Math.round(x);
    }

    _startAnimation() {
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => {
            if (!this.visible)
                return GLib.SOURCE_CONTINUE;

            const t = GLib.get_monotonic_time() / 1e6 - this._startTime;
            this._t = t;

            this._fadeColors();

            const active = this._audio.tick(t);
            if (active || this._needsFinalPaint) {
                this._viz.queue_repaint();
                this._needsFinalPaint = active;
            }

            if (this._flashText && t > this._flashUntil) {
                this._flashText = null;
                this._applyArtistText();
            }
            this._tickMarquee(this._titleM, t);
            this._tickMarquee(this._artistM, t);

            const ch = this._settings.get_string('character');
            const sleepAnim = this._pose() === 'sleep' && (ch === 'cat' || ch === 'dog');
            if (this._playing || this._progDirty || this._seekFrac !== null ||
                t - this._jumpT < 0.6 || sleepAnim) {
                this._prog.queue_repaint();
                this._updateTimeLabels();
                this._progDirty = false;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    /* ---------------- drawing: visualizer ---------------- */

    _draw(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const v = this._audio.values;
        const n = v.length;
        const style = this._settings.get_string('visualizer-style');
        const rounded = this._settings.get_boolean('rounded-bars');
        const [r, g, b] = this._accent;
        const [r2, g2, b2] = this._accent2;
        const grad = this._settings.get_boolean('gradient-colors');
        // fill colour: accent -> second colour, left to right
        const fill = a => {
            if (!grad) {
                cr.setSourceRGBA(r, g, b, a);
                return;
            }
            const pat = new Cairo.LinearGradient(0, 0, w, 0);
            pat.addColorStopRGBA(0, r, g, b, a);
            pat.addColorStopRGBA(1, r2, g2, b2, a);
            cr.setSource(pat);
        };

        if (n > 0) {
            const bw = w / n;
            const gap = Math.min(this._settings.get_int('bar-gap'), bw * 0.8);
            const barW = Math.max(1, bw - gap);
            const bar = (x, y, bh) => {
                if (rounded)
                    roundRect(cr, x, y, barW, bh, barW / 2);
                else
                    cr.rectangle(x, y, barW, bh);
            };
            fill(0.95);

            switch (style) {
            case 'mirror':
                for (let i = 0; i < n; i++) {
                    const bh = Math.max(2, v[i] * h);
                    bar(i * bw + gap / 2, (h - bh) / 2, bh);
                }
                cr.fill();
                break;

            case 'wave': {
                const pts = v.map((val, i) => [bw * (i + 0.5), h - Math.max(2, val * h * 0.95)]);
                cr.setLineWidth(2.5);
                cr.moveTo(0, h);
                cr.lineTo(pts[0][0], pts[0][1]);
                for (let i = 1; i < pts.length; i++) {
                    const mx = (pts[i - 1][0] + pts[i][0]) / 2;
                    cr.curveTo(mx, pts[i - 1][1], mx, pts[i][1], pts[i][0], pts[i][1]);
                }
                cr.lineTo(w, pts[n - 1][1]);
                cr.strokePreserve();
                cr.lineTo(w, h);
                cr.closePath();
                fill(0.25);
                cr.fill();
                break;
            }

            case 'dots': {
                const rows = 7, rowH = h / rows;
                const rad = Math.max(1.5, Math.min(bw, rowH) / 2 - 1.5);
                for (let i = 0; i < n; i++) {
                    const lit = Math.round(v[i] * rows);
                    for (let j = 0; j < Math.max(1, lit); j++) {
                        cr.arc(i * bw + bw / 2, h - rowH * (j + 0.5), rad, 0, TAU);
                        cr.fill();
                    }
                }
                break;
            }

            case 'bars':
            default:
                for (let i = 0; i < n; i++) {
                    const bh = Math.max(2, v[i] * h);
                    bar(i * bw + gap / 2, h - bh, bh);
                }
                cr.fill();
                break;
            }
        }
        cr.$dispose();
    }

    /* ---------------- drawing: progress bar + character ---------------- */

    _drawProgress(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const [r, g, b] = this._accent;
        const [r2, g2, b2] = this._accent2;
        const pad = 18, lineY = h - 6, tw = Math.max(1, w - 2 * pad);
        const base = this._lengthUs > 0 ? this._currentPosUs() / this._lengthUs : 0;
        const frac = Math.min(1, Math.max(0, this._seekFrac ?? base));
        const x = pad + tw * frac;

        cr.setLineCap(1);
        cr.setLineJoin(1);
        cr.setLineWidth(4);
        cr.setSourceRGBA(1, 1, 1, 0.22);
        cr.moveTo(pad, lineY);
        cr.lineTo(pad + tw, lineY);
        cr.stroke();
        if (this._settings.get_boolean('gradient-colors')) {
            const pat = new Cairo.LinearGradient(pad, 0, pad + tw, 0);
            pat.addColorStopRGBA(0, r, g, b, 0.95);
            pat.addColorStopRGBA(1, r2, g2, b2, 0.95);
            cr.setSource(pat);
        } else {
            cr.setSourceRGBA(r, g, b, 0.95);
        }
        cr.moveTo(pad, lineY);
        cr.lineTo(x, lineY);
        cr.stroke();

        const kind = this._settings.get_string('character');
        if (kind !== 'none') {
            const sz = this._settings.get_double('character-size');
            const jt = this._t - this._jumpT;
            const jump = jt < 0.5 ? Math.sin(Math.PI * jt / 0.5) * 12 * sz : 0;
            // hop to the beat while playing
            const bt = this._playing && this._settings.get_boolean('beat-bounce')
                ? this._audio.beat : 0;
            cr.save();
            cr.translate(x, lineY - 2 - jump - bt * 5 * sz);
            cr.scale(sz * (1 - bt * 0.04), sz * (1 + bt * 0.08));
            cr.setSourceRGBA(1, 1, 1, 0.97);
            this._drawCharacter(cr, kind, this._pose(), this._t);
            cr.restore();
        }
        cr.$dispose();
    }

    _drawCharacter(cr, kind, pose, t) {
        switch (kind) {
        case 'rocket': this._drawRocket(cr, t, pose === 'walk'); break;
        case 'note': this._drawNote(cr, t, pose === 'walk'); break;
        default: this._drawAnimal(cr, kind, pose, t); break;
        }
    }

    _animalHead(cr, kind, hx, hy, sleeping) {
        cr.setSourceRGBA(1, 1, 1, 0.97);
        cr.arc(hx, hy, 4.6, 0, TAU);
        cr.fill();
        if (kind === 'dog') {
            ellipse(cr, hx + 4.5, hy + 1.3, 3.3, 2.3);   // snout
            cr.fill();
            cr.setSourceRGBA(0.6, 0.6, 0.68, 1);          // floppy ear
            ellipse(cr, hx - 1.8, hy - 1.2, 2, 4.2);
            cr.fill();
        } else {
            cr.moveTo(hx - 3.3, hy - 3);                  // cat ears
            cr.lineTo(hx - 2.2, hy - 8.5);
            cr.lineTo(hx + 0.6, hy - 4.3);
            cr.closePath();
            cr.fill();
            cr.moveTo(hx - 0.2, hy - 4.4);
            cr.lineTo(hx + 2.8, hy - 8.5);
            cr.lineTo(hx + 4, hy - 3.3);
            cr.closePath();
            cr.fill();
        }
        cr.setSourceRGBA(0.1, 0.1, 0.12, 1);
        if (sleeping) {
            cr.setLineWidth(1);
            cr.moveTo(hx + 1.4, hy - 0.4);
            cr.lineTo(hx + 3.4, hy - 0.4);
            cr.stroke();
        } else {
            cr.arc(hx + 1.8, hy - 0.6, 0.9, 0, TAU);
            cr.fill();
        }
        if (kind === 'dog') {
            cr.arc(hx + 7.4, hy + 0.5, 1, 0, TAU);
            cr.fill();
        } else {
            cr.setSourceRGBA(1, 0.6, 0.7, 1);
            cr.arc(hx + 4.6, hy + 1.4, 0.7, 0, TAU);
            cr.fill();
        }
        cr.setSourceRGBA(1, 1, 1, 0.97);
    }

    _drawAnimal(cr, kind, pose, t) {
        if (pose === 'walk') {
            const ph = t * 11;
            const bob = -Math.abs(Math.sin(ph)) * 1.2;
            cr.setLineWidth(2.2);
            for (const [lx, off] of [[-6, 0], [-3, Math.PI], [4, Math.PI], [7, 0]]) {
                cr.moveTo(lx, -5 + bob);
                cr.lineTo(lx + Math.sin(ph + off) * 3, -Math.max(0, Math.cos(ph + off)) * 2.2);
                cr.stroke();
            }
            const wag = Math.sin(t * 6) * 3;
            cr.setLineWidth(2.4);
            if (kind === 'dog') {
                cr.moveTo(-8, -11 + bob);
                cr.lineTo(-13 + wag * 0.4, -17 + bob);
            } else {
                cr.moveTo(-8, -10 + bob);
                cr.curveTo(-14, -10 + bob, -15 + wag, -17 + bob, -12 + wag, -21 + bob);
            }
            cr.stroke();
            ellipse(cr, 0, -9 + bob, 9, 5);
            cr.fill();
            this._animalHead(cr, kind, 10, -13 + bob, false);
        } else if (pose === 'sit') {
            cr.setLineWidth(2.4);
            cr.moveTo(-5, -2);
            cr.curveTo(-12, 0, -15, -3, -14, -8);
            cr.stroke();
            ellipse(cr, -1, -8, 5.5, 8);
            cr.fill();
            ellipse(cr, -4, -3, 4.5, 3);
            cr.fill();
            cr.setLineWidth(2.2);
            cr.moveTo(2, -6); cr.lineTo(2, 0); cr.stroke();
            cr.moveTo(4.8, -6); cr.lineTo(4.8, 0); cr.stroke();
            this._animalHead(cr, kind, 2, -18.5, false);
        } else {
            // sleeping loaf + floating z's
            cr.setLineWidth(2.4);
            cr.moveTo(-9, -4);
            cr.curveTo(-12, 1, 2, 2, 10, -0.5);
            cr.stroke();
            ellipse(cr, 0, -5, 10, 5);
            cr.fill();
            this._animalHead(cr, kind, 9, -5.5, true);
            cr.setLineWidth(1.2);
            for (let i = 0; i < 3; i++) {
                const k = (t * 0.5 + i / 3) % 1;
                const s = 2.5 + i * 0.9;
                const zx = 14 + k * 7, zy = -14 - k * 13;
                cr.setSourceRGBA(1, 1, 1, 0.9 * (1 - k));
                cr.moveTo(zx, zy);
                cr.lineTo(zx + s, zy);
                cr.lineTo(zx, zy + s);
                cr.lineTo(zx + s, zy + s);
                cr.stroke();
            }
        }
    }

    _drawRocket(cr, t, flying) {
        const bob = flying ? Math.sin(t * 14) * 0.6 : 0;
        if (flying) {
            const f = 6 + Math.sin(t * 30) * 2.5;
            cr.setSourceRGBA(1, 0.6, 0.15, 0.95);
            cr.moveTo(-9, -12 + bob);
            cr.lineTo(-9 - f - 3, -9 + bob);
            cr.lineTo(-9, -6 + bob);
            cr.closePath();
            cr.fill();
        }
        cr.setSourceRGBA(0.95, 0.35, 0.35, 1);
        cr.moveTo(-6, -13 + bob); cr.lineTo(-11.5, -19 + bob); cr.lineTo(-1, -13.5 + bob);
        cr.closePath(); cr.fill();
        cr.moveTo(-6, -5 + bob); cr.lineTo(-11.5, 1 + bob); cr.lineTo(-1, -4.5 + bob);
        cr.closePath(); cr.fill();
        cr.setSourceRGBA(1, 1, 1, 0.97);
        ellipse(cr, 0, -9 + bob, 11, 4.8);
        cr.fill();
        cr.setSourceRGBA(0.95, 0.35, 0.35, 1);
        cr.moveTo(8, -13 + bob); cr.lineTo(16, -9 + bob); cr.lineTo(8, -5 + bob);
        cr.closePath(); cr.fill();
        cr.setSourceRGBA(0.3, 0.6, 0.9, 1);
        cr.arc(1, -9.5 + bob, 2.2, 0, TAU);
        cr.fill();
    }

    _drawNote(cr, t, playing) {
        const hop = playing ? -Math.abs(Math.sin(t * 8)) * 3 : 0;
        cr.save();
        cr.translate(0, hop);
        cr.save();
        cr.translate(-2, -5);
        cr.rotate(-0.35);
        cr.scale(4.5, 3.2);
        cr.arc(0, 0, 1, 0, TAU);
        cr.restore();
        cr.fill();
        cr.setLineWidth(1.8);
        cr.moveTo(2, -6.2);
        cr.lineTo(2, -21);
        cr.stroke();
        cr.moveTo(2, -21);
        cr.curveTo(8, -19.5, 9.5, -14, 6, -11.5);
        cr.stroke();
        cr.restore();
    }

    /* ---------------- cleanup ---------------- */

    shutdown() {
        for (const id of ['_tickId', '_posTimerId', '_seekTimerId']) {
            if (this[id]) {
                GLib.source_remove(this[id]);
                this[id] = 0;
            }
        }
        this._grab?.dismiss();
        this._grab = null;
        this._progGrab?.dismiss();
        this._progGrab = null;
        this._menu?.close?.();
        this._menu?.destroy();
        this._menu = null;
        this._menuAnchor?.destroy();
        this._menuAnchor = null;
        this.remove_effect_by_name('musicviz-blur');
        this._audio.stop();
        this._cancellable.cancel();
        this._mpris.stop();
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        this._settingsIds = [];
        this._session.abort();
    }
});

/* ------------------------------------------------------------------ */
/* Panel button (show/hide, lock, reset, prefs)                        */
/* ------------------------------------------------------------------ */

const MusicVizPanelButton = GObject.registerClass(
class MusicVizPanelButton extends PanelMenu.Button {
    _init(ext, settings, widget) {
        super._init(0.0, 'Music Visualizer');
        this._settings = settings;

        this.add_child(new St.Icon({
            icon_name: 'audio-x-generic-symbolic', style_class: 'system-status-icon',
        }));

        const showItem = new PopupMenu.PopupSwitchMenuItem(
            'Show widget', settings.get_boolean('widget-visible'));
        showItem.connect('toggled', (_i, state) => settings.set_boolean('widget-visible', state));

        const lockItem = new PopupMenu.PopupSwitchMenuItem(
            'Lock position', settings.get_boolean('locked'));
        lockItem.connect('toggled', (_i, state) => settings.set_boolean('locked', state));

        const resetItem = new PopupMenu.PopupMenuItem('Reset position');
        resetItem.connect('activate', () => widget.resetPosition());

        const prefsItem = new PopupMenu.PopupMenuItem('Settings');
        prefsItem.connect('activate', () => ext.openPreferences());

        this.menu.addMenuItem(showItem);
        this.menu.addMenuItem(lockItem);
        this.menu.addMenuItem(resetItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(prefsItem);

        this._ids = [
            settings.connect('changed::widget-visible', () =>
                showItem.setToggleState(settings.get_boolean('widget-visible'))),
            settings.connect('changed::locked', () =>
                lockItem.setToggleState(settings.get_boolean('locked'))),
        ];
    }

    destroy() {
        this._ids.forEach(id => this._settings.disconnect(id));
        super.destroy();
    }
});

/* ------------------------------------------------------------------ */

export default class MusicVizExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._widget = new MusicVizWidget(this, this._settings);

        // Behind windows, above the wallpaper = a true desktop widget.
        Main.layoutManager._backgroundGroup.add_child(this._widget);
        this._widget.setInitialPosition();

        this._button = new MusicVizPanelButton(this, this._settings, this._widget);
        Main.panel.addToStatusArea(this.uuid, this._button, 1, 'right');

        this._monitorsId = Main.layoutManager.connect('monitors-changed', () =>
            this._widget?.clampToStage());
    }

    disable() {
        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }
        this._button?.destroy();
        this._button = null;
        if (this._widget) {
            this._widget.shutdown();
            this._widget.destroy();
            this._widget = null;
        }
        this._settings = null;
    }
}

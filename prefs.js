import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function addSwitch(group, s, title, subtitle, key) {
    const row = new Adw.SwitchRow({title, subtitle: subtitle ?? ''});
    s.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
}

function addCombo(group, s, title, key, options) {
    const row = new Adw.ComboRow({
        title,
        model: Gtk.StringList.new(options.map(o => o[1])),
    });
    row.selected = Math.max(0, options.findIndex(o => o[0] === s.get_string(key)));
    row.connect('notify::selected', () => s.set_string(key, options[row.selected][0]));
    group.add(row);
}

function addScale(group, s, title, subtitle, key, min, max, step, digits) {
    const row = new Adw.ActionRow({title, subtitle: subtitle ?? ''});
    const scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, min, max, step);
    scale.set_value(s.get_double(key));
    scale.set_draw_value(true);
    scale.set_digits(digits);
    scale.set_size_request(240, -1);
    scale.set_valign(Gtk.Align.CENTER);
    scale.connect('value-changed', () => s.set_double(key, scale.get_value()));
    row.add_suffix(scale);
    group.add(row);
}

function addIntScale(group, s, title, subtitle, key, min, max, step) {
    const row = new Adw.ActionRow({title, subtitle: subtitle ?? ''});
    const scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, min, max, step);
    scale.set_value(s.get_int(key));
    scale.set_draw_value(true);
    scale.set_digits(0);
    scale.set_size_request(240, -1);
    scale.set_valign(Gtk.Align.CENTER);
    scale.connect('value-changed', () => s.set_int(key, Math.round(scale.get_value())));
    row.add_suffix(scale);
    group.add(row);
}

function addEntry(group, s, title, subtitle, key) {
    const row = new Adw.EntryRow({title});
    row.text = s.get_string(key);
    row.connect('changed', () => s.set_string(key, row.text.trim()));
    group.add(row);
    if (subtitle) {
        const hint = new Adw.ActionRow({title: subtitle});
        hint.add_css_class('dim-label');
        group.add(hint);
    }
}

/** Names of the MPRIS players running right now (for the player settings). */
function detectPlayers() {
    try {
        const res = Gio.DBus.session.call_sync(
            'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'ListNames', null, new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE, 500, null);
        const [names] = res.deepUnpack();
        const list = names.filter(n => n.startsWith('org.mpris.MediaPlayer2.'))
            .map(n => n.slice('org.mpris.MediaPlayer2.'.length));
        return list.length ? list.join(', ') : 'none running right now';
    } catch (e) {
        return 'could not be detected';
    }
}

function addSpin(group, s, title, key, min, max) {
    const row = new Adw.SpinRow({
        title,
        adjustment: new Gtk.Adjustment({
            lower: min, upper: max, step_increment: 1, value: s.get_int(key),
        }),
    });
    row.connect('notify::value', () => s.set_int(key, Math.round(row.value)));
    group.add(row);
}

export default class MusicVizPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const s = this.getSettings();

        /* ---------- Appearance ---------- */
        const appearance = new Adw.PreferencesPage({title: 'Appearance', icon_name: 'preferences-desktop-appearance-symbolic'});
        const look = new Adw.PreferencesGroup({title: 'Widget'});
        addCombo(look, s, 'Layout', 'layout',
            [['standard', 'Standard'], ['horizontal', 'Horizontal'], ['compact', 'Compact']]);
        addScale(look, s, 'Widget size', 'Tip: Ctrl + scroll over the widget also resizes it',
            'widget-scale', 0.5, 2.0, 0.05, 2);
        addScale(look, s, 'Background opacity', 'Lower = more transparent',
            'opacity', 0.0, 1.0, 0.05, 2);
        addSwitch(look, s, 'Colours from album art', 'Background and visualizer follow the song cover', 'dynamic-color');
        addSwitch(look, s, 'Gradient colours',
            'Adds a second colour from the cover to the background, bars and progress bar', 'gradient-colors');
        appearance.add(look);

        const size = new Adw.PreferencesGroup({
            title: 'Size',
            description: 'Or drag with Ctrl held down on the widget to resize it freely. ' +
                'Extra height goes to the visualizer.',
        });
        addSwitch(size, s, 'Custom width and height', 'Off = automatic size for the chosen layout', 'custom-size');
        addIntScale(size, s, 'Width (px)', null, 'widget-width', 220, 900, 10);
        addIntScale(size, s, 'Height (px)', 'Only applies while the visualizer is shown', 'widget-height', 120, 900, 10);
        appearance.add(size);

        const glass = new Adw.PreferencesGroup({
            title: 'Frosted glass',
            description: 'Blurs the wallpaper behind the widget. Works best at moderate opacity.',
        });
        addSwitch(glass, s, 'Enable blur', null, 'blur-enabled');
        addIntScale(glass, s, 'Blur strength', null, 'blur-strength', 0, 100, 1);
        appearance.add(glass);

        const show = new Adw.PreferencesGroup({title: 'Show / hide parts'});
        addSwitch(show, s, 'Album art', null, 'show-art');
        addSwitch(show, s, 'Visualizer', 'Not available in the compact layout', 'show-visualizer');
        addSwitch(show, s, 'Time (elapsed / total)', null, 'show-time');
        appearance.add(show);
        window.add(appearance);

        /* ---------- Visualizer ---------- */
        const vizPage = new Adw.PreferencesPage({title: 'Visualizer', icon_name: 'audio-x-generic-symbolic'});
        const viz = new Adw.PreferencesGroup({title: 'Visualizer'});
        addCombo(viz, s, 'Style', 'visualizer-style',
            [['bars', 'Bars'], ['mirror', 'Mirrored bars'], ['wave', 'Wave'], ['dots', 'Dots']]);
        addSpin(viz, s, 'Number of bars', 'bar-count', 8, 64);
        addSpin(viz, s, 'Gap between bars (px)', 'bar-gap', 0, 10);
        addSwitch(viz, s, 'Rounded bars', null, 'rounded-bars');
        addScale(viz, s, 'Sensitivity', 'Higher = taller bars', 'sensitivity', 0.2, 4.0, 0.1, 1);
        addScale(viz, s, 'Smoothing', 'Higher = slower, smoother movement', 'smoothing', 0.0, 0.95, 0.05, 2);
        addSwitch(viz, s, 'Use cava for real audio data',
            'Requires the "cava" package; otherwise a simulated animation is shown', 'use-cava');
        vizPage.add(viz);
        window.add(vizPage);

        /* ---------- Progress bar character ---------- */
        const charPage = new Adw.PreferencesPage({title: 'Character', icon_name: 'emoji-nature-symbolic'});
        const ch = new Adw.PreferencesGroup({
            title: 'Progress bar character',
            description: 'Walks along the progress bar. Click or drag the bar to seek – the character hops!',
        });
        addCombo(ch, s, 'Character', 'character',
            [['cat', 'Cat'], ['dog', 'Dog'], ['rocket', 'Rocket'], ['note', 'Music note'], ['none', 'None']]);
        addScale(ch, s, 'Character size', null, 'character-size', 0.6, 2.0, 0.05, 2);
        addSwitch(ch, s, 'Bounce to the beat', 'Needs cava for real beats; otherwise it follows the simulated animation', 'beat-bounce');
        charPage.add(ch);
        window.add(charPage);

        /* ---------- Behaviour ---------- */
        const behPage = new Adw.PreferencesPage({title: 'Behaviour', icon_name: 'preferences-system-symbolic'});
        const beh = new Adw.PreferencesGroup({
            title: 'Behaviour',
            description: 'Scroll over the widget to change volume. Right-click it for a quick menu.',
        });
        addSwitch(beh, s, 'Show desktop widget', null, 'widget-visible');
        addSwitch(beh, s, 'Lock widget position', 'Disable dragging', 'locked');
        behPage.add(beh);

        const players = new Adw.PreferencesGroup({
            title: 'Players',
            description: `Running now: ${detectPlayers()}. Type any part of a name, separated by commas ` +
                '(for example "spotify" or "firefox, chrom").',
        });
        addEntry(players, s, 'Preferred player', null, 'preferred-player');
        addSwitch(players, s, 'Always use the preferred player',
            'Off = a player that is playing wins, and the preferred one only breaks ties', 'prefer-strict');
        addEntry(players, s, 'Ignored players', null, 'ignored-players');
        behPage.add(players);

        const actions = new Adw.PreferencesGroup({title: 'Actions'});
        addCombo(actions, s, 'Double-click the widget', 'double-click-action',
            [['raise', 'Open the player window'], ['playpause', 'Play / pause'], ['none', 'Do nothing']]);
        addSwitch(actions, s, 'Favourite (heart) button',
            'Players do not expose a "like" over MPRIS, so this saves songs to a local list: ' +
            '~/.local/share/musicviz/favorites.json', 'show-like');
        behPage.add(actions);
        window.add(behPage);
    }
}

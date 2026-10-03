# GNOME Music Visualizer

A GNOME Shell extension that adds a customizable music player and audio visualizer widget to the desktop.

The widget displays the currently playing song, album artwork, playback controls, a real-time audio visualizer, and a progress bar with an optional animated character.

## Features

- Displays the currently playing song and artist
- Shows album artwork
- Real-time audio visualizer
- CAVA support for real audio data
- Simulated visualizer when CAVA is unavailable
- Multiple visualizer styles:
  - Bars
  - Mirrored bars
  - Wave
  - Dots
- Adjustable number of bars, sensitivity, smoothing, and spacing
- Three widget layouts:
  - Standard
  - Horizontal
  - Compact
- Dynamic colours based on album artwork
- Optional gradient colours
- Adjustable widget opacity and size
- Optional frosted-glass background effect
- Play, pause, next, and previous controls
- Track seeking
- Volume control
- Shuffle and repeat controls
- Optional animated progress bar character:
  - Cat
  - Dog
  - Rocket
  - Music note
- Beat-based character animation
- Local favourite songs list
- Preferred and ignored media player support
- Movable and lockable widget position
- Configurable double-click action
- Quick settings menu from the GNOME panel

## Media Player Support

The extension uses the MPRIS interface to communicate with media players running on the system.

It can work with media players that provide MPRIS support, including Spotify and other compatible applications.

## Requirements

- GNOME Shell 45 or newer
- CAVA is optional but recommended for real-time audio visualization

The extension currently declares compatibility with GNOME Shell versions 45, 46, 47, 48, 49, and 50.

## Installation

### Manual Installation

Clone the repository:

```bash
git clone https://github.com/Wizz-ard/gnome-music-visualizer.git
#### Copy the extension to the GNOME extensions directory:
mkdir -p ~/.local/share/gnome-shell/extensions/musicviz@example.local
cp -r gnome-music-visualizer/* ~/.local/share/gnome-shell/extensions/musicviz@example.local/
##### Enable the extension:
gnome-extensions enable musicviz@example.local

###### Installing CAVA:
For real-time audio visualization, install CAVA using your distribution's package manager.
On Fedora:
sudo dnf install cava

If CAVA is not installed, the extension automatically uses a simulated visualizer.

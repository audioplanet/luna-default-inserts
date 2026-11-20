# Default Inserts

A LUNA Add On that puts the plugins you choose on every **new** audio track, instrument
track and bus, automatically.

It was made for Softube **Console 1**: with Console 1 on every channel, every new track
shows up on the Console 1 hardware controller without any clicking. Console 1 is the
default, but you can pick any effect plugins you like.

## Install

1. Download `default-inserts.lunaaddon` from the [latest release](../../releases/latest).
2. Double-click it. LUNA opens and asks to add it.

Or, in LUNA's Add Ons settings, import this repository's address; LUNA installs the latest
release and offers updates.

Then open it from **Add Ons > Windows > Default Inserts**. Needs LUNA 3.1.2 or later.

## Use

- Three lists: **Audio tracks**, **Instrument tracks** and **Buses**. Type in a list's search
  box to add a plugin; ↑ ↓ reorder, ✕ removes. Plugins installed in more than one format
  show which one, e.g. "Console 1 (VST3)".
- On first open, if Console 1 is installed, every list starts with it (VST3 preferred).
- Each new channel gets the plugins it does not already have, in the first empty insert
  slots, as **one undo step**. Duplicated tracks and track presets that already carry a
  plugin do not get it twice.
- The master bus, MIDI, video and click tracks, and folders that only group tracks are
  left alone.
- **On / Off** pauses it. **Apply to existing tracks** fills in channels made while it was
  off or closed.
- The Activity log shows what was added and anything that failed.

Good to know:

- It works while its window is open, including when hidden. It opens with each session.
- When a session uses one of LUNA's console extensions, LUNA shows that console in the
  first insert slot, so your plugins start in the second.
- Your plugin lists are kept on your computer and apply to every session.

## Develop

Built with [`@uaudio/luna-builder-sdk`](https://github.com/uaudio-labs/luna-builder-sdk).

| File | Purpose |
|---|---|
| `manifest.json` | What LUNA reads: id, name, window size, entry page. |
| `index.html` | The page. Loads the SDK bundle, then `logic.js`, then `main.js`. |
| `logic.js` | Engine logic with no DOM: settings, which channels count, inserting, watching. |
| `main.js` | The window: plugin lists, search, on/off, activity log, session following. |
| `vendor/luna.global.js` | The SDK as a script-tag bundle. |
| `tests/` | Vitest against `Luna.MockEngine`, no LUNA needed. |

```sh
npm install               # needs the LUNA Builder SDK; see the devDependency in package.json
npm test
npx ua-builder serve      # http://localhost:8790/ with LUNA running
npx ua-builder install    # link into LUNA's Add Ons folder
npx ua-builder pack       # build default-inserts.lunaaddon
```

## License

MIT. See [LICENSE](LICENSE). The bundled `vendor/luna.global.js` is Universal Audio's LUNA
Builder SDK, under its own Apache 2.0 license and supplemental terms.

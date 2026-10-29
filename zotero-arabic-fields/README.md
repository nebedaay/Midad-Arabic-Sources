# Arabic Fields Romanizer (Zotero companion)

An optional **Zotero 7** plugin that creates a romanized copy of a Zotero item, transliterating its Arabic fields through the same local transliteration server as Midad Arabic Sources. It lives here as a companion project so the documentation and the `.xpi` download stay together; it is **not** bundled into the Obsidian plugin's `main.js` or its release assets.

- `bootstrap.js` — the Zotero bootstrapped-plugin entry point.
- `manifest.json` / `prefs.js` — Zotero metadata and default server URL (`http://127.0.0.1:8756`) and engine (`bert`).
- `locale/` — the menu label.
- `arabic-fields-romanizer.xpi` — the built plugin.
- `updates.json` — the update manifest used by Zotero.

## Build

```shell
./build.sh
```

The script zips `manifest.json`, `bootstrap.js`, `prefs.js`, and `locale/` into `arabic-fields-romanizer.xpi`.

## Install

Install the `.xpi` from **Zotero → Tools → Plugins → gear → Install Plugin From File…**. The Midad transliteration server must be running; see [Zotero Arabic fields](../docs/zotero-arabic-fields.md) for the full guide.

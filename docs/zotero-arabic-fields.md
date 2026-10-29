# Zotero Arabic fields

**Arabic Fields Romanizer** is an optional **Zotero 7** plugin that creates a romanized copy of a Zotero item by transliterating its Arabic fields through the same resident server as Midad Arabic Sources. It is a companion project, not part of the Obsidian plugin bundle: its source and `.xpi` live in the Midad repository under `zotero-arabic-fields/`, so there is one place to download and document it.

## Requirements

- **Zotero 7**.
- The **Midad transliteration server** running, normally on `127.0.0.1:8756`. Start it with **Transliteration server…** in Obsidian, or `python3 scripts/transliterate-server.py --port 8756`; see [Transliteration](./transliteration.md).
- The Python and CAMeL data the server needs — see [Dependencies](./dependencies.md).

## Install

1. Start the transliteration server.
2. Download [arabic-fields-romanizer.xpi](https://github.com/nebedaay/Midad-Arabic-Sources/raw/main/zotero-arabic-fields/arabic-fields-romanizer.xpi).
3. In Zotero, open **Tools → Plugins**, use the gear menu, and choose **Install Plugin From File…**.
4. Select the `.xpi` and enable **Arabic Fields Romanizer**.

There is no separate preferences pane. To change the server URL or engine, use Zotero's **Settings → Advanced → Config Editor** and edit `extensions.arabicFieldsRomanizer.serverUrl` (default `http://127.0.0.1:8756`) and `extensions.arabicFieldsRomanizer.engine` (`bert`, `mle`, or `none`). The running server and these preferences must agree.

## Use

Select one or more items and right-click **Create romanized copy** (the same action is under **Tools**). The plugin:

- creates a **copy** and leaves the original untouched;
- transliterates every field containing Arabic script;
- maps the **Place** field through the server's place list and transliterates it otherwise;
- converts the creators as well, so an Arabic author name becomes a romanized author;
- asks for a reading when the engine reports an unknown term, and adds the answer to the shared user lexicon through the server.

It needs the server for every run: the request goes to `/transliterate`, with `/place` for places and `/lexicon` for unknown terms. If the server is not running, the command reports the failure and changes nothing.

## Updates

`manifest.json` points at `zotero-arabic-fields/updates.json` in the Midad repository, so Zotero can check for a newer `.xpi`. The authoritative build is the `.xpi` beside that file; after a Midad update, reinstall from the downloaded `.xpi` if Zotero has not picked it up.

The Zotero plugin is a separate companion under the same GPL-3.0 licence; it is not part of the Obsidian community-plugin review surface.

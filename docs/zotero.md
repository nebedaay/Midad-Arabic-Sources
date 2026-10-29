
# Zotero export

## Literature notes

This plugin is optimized for **[ScholarWeft](https://community.obsidian.md/plugins/scholar-weft)**’s imported Zotero literature notes using the standard ScholarWeft template. To associate transcriptions and translations with a Zotero item, import its literature note into Obsidian with ScholarWeft, then run the commands to transcribe and translate its PDF attachments (see [Transcription](./transcription.md)). To romanize the Arabic fields of a Zotero item, install the optional [Midad Arabic Transliteration](./midad-arabic-transliteration.md) companion.

Installed works can be sent to Zotero as `book` items, each tagged **Midad Arabic Sources** and filed in a collection of that name. Only new or changed items are sent; an item the plugin sent before is **updated in place**, never duplicated.

Turn it on under **Zotero → Enable Zotero export**.

## Methods

Choose the method under **Zotero → Method**:

- **Local API (this computer)** — writes to the Zotero running on `127.0.0.1:23119`. The default. No key needed.
- **Web API (zotero.org)** — writes to your online library. Needs an API key (from [zotero.org/settings/keys](https://www.zotero.org/settings/keys), with write access) and your numeric user or group ID. **Detect local Zotero** fills the library ID from a running local Zotero when it can.
- **CSL-JSON file (manual import)** — writes `<Sources>/zotero-export.csl.json`, which you import by hand through Zotero’s **File → Import**.

## Commands

- **Send all installed sources to Zotero** — every installed work that has not been sent, or whose bibliographic fields changed.
- **Send selected sources…** — opens **Manage text sources** in its *Send to Zotero* tab, where a **Select All/None** toggle picks the works to send.
- **Send this source to Zotero** — the work whose note is open.

All three share the collection and tag, and all three skip items that are already current.

## Keeping Zotero up to date

Two settings wire the export into the automatic process. Both are silent: they run after any render (install, re-fetch, re-render) and once at startup.

- **Keep Zotero items up to date** — re-send an already-exported item whenever its fields change.
- **Create Zotero items for all sources** — send any installed work that was never exported, without asking. An item you deleted in Zotero is recreated.

Whether a send is needed is decided by the **item’s content hash**, built from the work model and the publication map — *not* the rendered note. So a pure template re-render changes no Zotero field and sends nothing; only a re-fetch (a new model) or an edit to the publication map does.

## Where the bibliographic data comes from

The **publication map** (`midad-arabic-sources-import-templates/publication-map.json`, overridable in your vault copy) is the single source for both the work’s hub YAML and its Zotero item. It is keyed by work (`<collection>:<id>`).

- Entries are marked `verified: false` until you check them; an unverified entry adds a *“Bibliographic details are provisional — verify”* line to the Zotero item’s `extra`.
- A creator is a name string (the last word becomes Zotero’s last name) or, where that split is wrong, an object `{ "first": …, "last": … }`. Creators are exported as `author`, `translator`, or `editor` by role.
- A Better BibTeX citekey becomes `midad-up: [[@citekey]]` on the work hub.

Nothing that ends up in the Zotero item’s `extra` lives only in Zotero: `midad-note` holds the map’s edition note plus the provisional caveat, and `midad-id` carries the plugin’s registry identity. The repository, attribution, and repository date are already the `repository`, `license-attribution`, and `repository-updated` properties on the hub.

## Update-in-place details

Each exported item’s Zotero key and version are remembered. A later send uses `PUT` to update it; if the key no longer exists in the library, the item is recreated — but only when **Create Zotero items for all sources** is on. The CSL-JSON method always writes the whole file; re-import it in Zotero to update.

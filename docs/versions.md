# Versions, removal, and cleanup

This guide covers the lifecycle shared by repository sources, transcriptions, translations, and adopted notes: how versions work, what happens when a source is re-rendered or removed, and how to clean up detached material.

## Version 0

Version 0 is the installed source itself.

- For a repository source, Version 0 is the cached render model.
- For a transcription or translation, Version 0 is the archived JSON batch.
- Version 0 is virtual: it has no snapshot in the version archive. Re-rendering it reads the model or archive again.
- Version 0 cannot be renamed or edited as a version. Editing the note changes your working copy of Version 0; save those changes as a version if you want to keep them.
- Version 0 can be selected, rendered as a separate `.Version0.md` note, or set as the default. Rendering it only ever writes that separate note; the default note and its properties are left untouched. A legacy transcription with no archived batch has nothing older to re-render, so its `.Version0.md` is written from the note as it stands, and the link from the default note points at it.
- An adopted note has no installed model to regenerate. Its Version 0 must be an explicitly saved snapshot.

## Saved versions

Saved versions are user snapshots.

- The first saved version is Version 1; later versions are Version 2, Version 3, and so on.
- The default version occupies the main note path.
- Selected non-default versions are rendered as `<note>.VersionN.md` notes.
- Deselecting a version archives it; deleting it removes its snapshot.
- Version 0 is never deleted as a saved version; it is the installed source.

Versions are stored per work under:

```text
.midad-arabic-sources/version-archives/<work>-<hash>.zip
```

Each archive contains that work's version manifest and snapshot notes. The old global `source-versions.zip` is migrated automatically.

An archive is read and written **one work at a time**. The manager knows a note's work from its `midad-id`, so opening it reads that note's archive only, and changing something rewrites that archive only — every other work's zip is left untouched, byte for byte. The one view that needs all works (the startup check that maps saved versions to notes) reads each archive's `manifest.json` without decompressing a single snapshot. In a vault with hundreds of works and gigabytes of snapshots that is the difference between a dialog that answers at once and one that blocks the interface for a minute.

Baseline and version hashes live in:

```text
.midad-arabic-sources/note-hashes.json
```

The baseline hash detects edits to the rendered Version 0. Saved-version hashes compare a note with a specific snapshot.

## Managing versions

Run **Manage versions of this note…** from the command palette.

The manager lets you:

- Save the current note as a new version.
- Overwrite the current default version.
- Select a version for rendering as a separate note.
- Set a version as the default.
- Rename user versions.
- Delete user versions.
- Render Version 0 as a separate version note.

If the note differs from its saved version, the manager asks whether to save, overwrite, or discard the changes. If a re-render is requested while the note has unsaved changes, one review covers every kind of note: keep the edited text as the default version and store the fresh render as another version, save the edited text as a version and then show the update, update without saving, skip the notes, or cancel. The automatic policy is the same for repository sources, transcriptions, translations and adopted notes — see **Settings → Midad Arabic Sources → General → Auto-update notes when a source, template, or script changes** in [Templates](./templates.md#auto-update-when-a-template-changes).

## Re-rendering and restoring

- Re-rendering Version 0 reads the current model or archive.
- Re-rendering a transcription's **parent note** — the volume index of a multi-volume item — re-renders every volume note in it, the same way re-rendering a multi-volume work's MOC re-renders its volumes. The same applies to **Post-process this transcription/translation** and to assigning a topic, which re-processes all the volumes at once.
- Reinstalling a source reapplies its saved versions automatically.
- Restoring an archived source reapplies saved versions automatically.
- Annotations are stored separately and are restored through the normal annotation lifecycle.
- A template or render-fingerprint change is reported in the version manager. Historical snapshots are preserved; Version 0 re-renders with the current templates.
- The managed-region hash is what decides whether a note was edited: the text inside `<span class="mas-managed">…</span>`, never your content outside it and never the YAML. A transcription, a translation and a repository note are measured the same way, and the stamp of the scripts that produced the note lives beside that hash.

## Removing a source

Removing a source offers two choices:

- **Remove, keep my notes** — deletes generated-only notes and the cached model, keeps notes containing user-written text outside the managed region, and strips only the generated region from those notes.
- **Remove everything** — deletes the complete work folder, including user-written notes.

Removal keeps saved versions and annotations. Reinstalling the source reapplies them.

The installed-source context menu also offers:

- **Re-download source/model…** — fetch the model and notes again while preserving user content.
- **Delete cached model only…** — remove the model but keep rendered notes and saved versions.

## State summary

| Path | Holds |
| --- | --- |
| `version-archives/<work>-<hash>.zip` | Per-work version manifests and snapshot notes |
| `note-hashes.json` | Baseline and saved-version hashes |
| `source-archives/<collection>/<id>.zip` | Archived source models and rendered notes |
| `annotations/` | Annotation store and adopted-note registry |
| `source-imports.json` | Installed, deleting, and archived source status |

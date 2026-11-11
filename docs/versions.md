# Versions, removal, and cleanup

This guide covers the lifecycle shared by repository sources, transcriptions, translations, and adopted notes: how versions work, what happens when a source is re-rendered or removed, and how to clean up detached material.

## Version 0

Version 0 is the installed source itself.

- For a repository source, Version 0 is the cached render model.
- For a transcription or translation, Version 0 is the archived JSON batch.
- Version 0 is virtual: it has no snapshot in the version archive. Re-rendering it reads the model or archive again.
- Version 0 cannot be renamed or edited as a version. Editing the note changes your working copy of Version 0; save those changes as a version if you want to keep them.
- Version 0 can be selected, rendered as a separate `.Version0.md` note, or set as the default.
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

If the note differs from its saved version, the manager asks whether to save, overwrite, or discard the changes. If a source re-render is requested while the note has unsaved changes, it offers to save the changes as versions, keep them as Version 1 while Version 0 stays the model, overwrite with the original, or skip.

## Re-rendering and restoring

- Re-rendering Version 0 reads the current model or archive.
- Reinstalling a source reapplies its saved versions automatically.
- Restoring an archived source reapplies saved versions automatically.
- Annotations are stored separately and are restored through the normal annotation lifecycle.
- A template or render-fingerprint change is reported in the version manager. Historical snapshots are preserved; Version 0 re-renders with the current templates.

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

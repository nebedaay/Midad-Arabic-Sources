# Managed regions, identity, and adoption

Managed regions are the boundary between generated content and your own writing. They apply to repository sources, transcriptions, translations, adopted notes, and generated MOCs.

## The managed region

Generated content sits between two marker lines:

```markdown
<span class="mas-managed">mas-managed</span>

generated content

<span class="mas-managed">/mas-managed</span>
```

The markers are always on their own blank-line-separated block, including a blank line after the closing marker at the end of a note. Re-rendering replaces the managed region and preserves everything outside it.

Notes rendered before the HTML markers used `%%mas-managed%%` and `%%/mas-managed%%`; these are recognized and normalized on the next write.

## Adding managed tags

- **Add managed region tags to this note** wraps the body of the active note.
- **Add managed region tags to all Midad-managed notes** applies the boundary to every managed content note that lacks one, with backups and confirmation.

Adding tags does not move your text. Anything currently inside the new region becomes replaceable on the next render; move user-written content outside the markers first if it should be preserved.

## Identity

Midad notes carry a single `midad-id`. Kind, work, and unit are parsed from it:

```text
repo/<collection>/<work-id>
zotero/<zotero-id>/<transcription|translation>[/<unit>]
pdf/<pdf-key>/<transcription|translation>[/<unit>]
adopted/<uuid>
```

The retired `midad-kind`, `midad-work`, `midad-unit`, and `midad-source` properties are read as fallbacks for older notes but are no longer written.

## Adoption

Known Midad transcriptions and translations are registered automatically. For another Markdown note, **Adopt note for annotations** adds an `adopted/<uuid>` identity and wraps its body in a managed region.

When a legacy transcription or translation is recognized, the adoption dialog offers to apply Midad metadata defaults and move it into the standard folder. Annotations and saved versions are tied to the note’s identity, so adoption should happen before making extensive annotations when possible.

## Unadopting

**Unadopt this note (remove Midad identity and managed tags)…**:

- Removes Midad identity and version properties.
- Removes the managed marker lines, keeping the content inside them.
- Removes saved versions and hash records.
- Removes adopted-note registration.

The note and its content remain. This is the right command for material that should no longer be managed by Midad.

## Re-rendering and preservation

Re-rendering replaces only the managed region. Everything outside it is preserved, including `related:`, user notes, and detached content. Template-declared frontmatter properties are reconciled separately; see [Templates](./templates.md).

If a note has user-written content outside its managed region and its source is removed, the note is kept and only the generated region is stripped. Choose **Remove everything** in the removal dialog to delete it too. See [Versions, removal, and cleanup](./versions.md#removing-a-source).

## Versions

Version 0 represents the installed source, not the managed-region text. Saved versions capture snapshots of the managed region. See [Versions, removal, and cleanup](./versions.md).

## Cleanup

**Clean up orphaned Midad data…** removes hash records for missing notes and adopted-registry entries for missing files that have no annotations. It does not delete saved-version archives or annotation content.

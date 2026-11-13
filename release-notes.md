# 0.2.6

Qur'ānic font rendering fix.

### U+06DF small high rounded zero

- KFGQPC HAFS maps U+06DF (the mark after wāw in forms such as `أُو۟لَٰٓئِكَ`) to a dotted-circle placeholder.
- Added a range-scoped `mas-quran-mark` face that routes only U+06DF through Amiri Quran, Scheherazade New, or Noto Naskh Arabic, while the rest of the verse keeps KFGQPC.

### Bottom clipping

- Expanded the painted box around Arabic verse text and inline `.quran-quote` text so the gilded background covers descenders and combining marks instead of clipping their lower edge.

### Documentation

- Noted the U+06DF font routing in the Setup guide’s font section.

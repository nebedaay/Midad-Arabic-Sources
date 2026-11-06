<% start_YAML(); -%>
<% add_property('document-type', '[[text-source]]'); -%>
<% add_property('created', generated); -%>
<% add_property('updated', updated()); -%>
<% const pub = work.publication || {}; -%>
<% const yamlId = (value) => String(value).replace(/:/g, '/'); -%>
<% add_property('midad-up', [...work.up, '[[Midad Arabic Sources]]']); -%>
<% add_property('midad-id', yamlId('repo:' + work.key)); -%>
<% add_property('midad-kind', 'repo-work'); -%>
<% /* Retired properties. The source is derived from midad-id/midad-kind/midad-work,
   and the raw key is midad-id without its `repo/` prefix. Declared empty with
   `remove` so a re-render deletes either one from an older note. */ -%>
<% add_property('midad-source', '', { merge: 'remove' }); -%>
<% add_property('midad-key', '', { merge: 'remove' }); -%>
<% if (pub.mas_note) { add_property('midad-note', pub.mas_note); } -%>
<% add_property('related', [], { force: true, merge: 'keep' }); -%>
<% add_property('title', work.title); -%>
<% const shortTitle = pub.shorttitle || work.short; -%>
<% if (shortTitle) { add_property('shorttitle', shortTitle); } -%>
<% /* The rule is the language of the published work, not its genre: an Arabic
   dictionary keeps its Arabic title; an English-language work (Wehr, Lane, an
   English Qur'ān translation) does not get an Arabic rendering of its title. */ -%>
<% const titleArAllowed = (work.title_language || work.language) === 'ar'; -%>
<% const titleAr = titleArAllowed ? (pub.title_ar || work.title_ar) : ''; -%>
<% if (titleArAllowed && titleAr) { add_property('title-ar', titleAr, { quote: 'always' }); } else if (!titleArAllowed) { add_property('title-ar', '', { merge: 'remove' }); } -%>
<% const scholarName = (a) => {
  if (typeof a !== 'string') return a.name || [a.last, a.first].filter(Boolean).join(', ');
  const s = a.trim();
  if (s.includes(',') || /(?:^|\s)(?:b\.\s|ibn\b|bint\b|al-\S|Abū\b|Abu\b)/i.test(s)) return s;
  const parts = s.split(/\s+/).filter(Boolean);
  return parts.length > 1 ? `${parts[parts.length - 1]}, ${parts.slice(0, -1).join(' ')}` : s;
}; -%>
<% const person = (a) => scholarName(a); -%>
<% const pubAuthors = (pub.authors && pub.authors.length) ? pub.authors : (work.authors || []); -%>
<% const pubTranslators = (pub.translators && pub.translators.length) ? pub.translators : (work.translators || []); -%>
<% const pubEditors = pub.editors || []; -%>
<% add_property('item-type', pub.item_type || 'book'); -%>
<% if (pubAuthors.length) { add_property('authors', pubAuthors.map(a => wikilink(person(a)))); } -%>
<% const authorsArAllowed = (work.title_language || work.language) === 'ar'; -%>
<% const authorsArRaw = authorsArAllowed ? ((pub.authors_ar && pub.authors_ar.length) ? pub.authors_ar : (work.authors_ar || [])) : []; -%>
<% const authorsAr = Array.isArray(authorsArRaw) ? authorsArRaw : (authorsArRaw ? [authorsArRaw] : []); -%>
<% if (authorsArAllowed && authorsAr.length) { add_property('authors-ar', authorsAr, { quote: 'always' }); } else if (!authorsArAllowed) { add_property('authors-ar', '', { merge: 'remove' }); } -%>
<% /* One standard: `authors-ar` is the list, even for a single author. */ -%>
<% add_property('author-ar', '', { merge: 'remove' }); -%>
<% if (pubTranslators.length) { add_property('translators', pubTranslators.map(a => wikilink(person(a)))); } -%>
<% if (pubEditors.length) { add_property('editors', pubEditors.map(a => wikilink(person(a)))); } -%>
<% if (pub.contributors) { const contributors = Array.isArray(pub.contributors) ? pub.contributors : [pub.contributors]; add_property('contributors', contributors.map(a => wikilink(person(a)))); } -%>
<% if (pub.publisher) { add_property('publisher', wikilink(pub.publisher)); } -%>
<% if (pub.place) { add_property('place', pub.place); } -%>
<% if (pub.date) { add_property('year', wikilink(String(pub.date).slice(0, 4))); } -%>
<% if (pub.edition) { add_property('edition', pub.edition); } -%>
<% if (pub.series) { add_property('series', pub.series); } -%>
<% if (pub['series-number']) { add_property('series-number', pub['series-number']); } -%>
<% if (pub.volume) { add_property('volume', pub.volume); } -%>
<% const volumeCount = pub.volumes || (Number(work.volumes) > 1 ? Number(work.volumes) : ''); -%>
<% if (volumeCount) { add_property('volumes', volumeCount); } -%>
<% if (pub.number) { add_property('number', pub.number); } -%>
<% if (pub.issue) { add_property('issue', pub.issue); } -%>
<% if (pub.pages) { add_property('pages', pub.pages); } -%>
<% if (pub.doi) { add_property('doi', pub.doi); } -%>
<% if (pub.isbn) { add_property('isbn', pub.isbn); } -%>
<% const url = pub.url || work.source; -%>
<% if (url) { add_property('url', url); } -%>
<% const genre = pub.genre || work.genre; -%>
<% if (genre) { add_property('genre', genre); } -%>
<% if (pub.section) { add_property('section', pub.section); } -%>
<% if (pub.citekey) { add_property('citekey', pub.citekey); } -%>
<% if (work.language_links.length > 1) { add_property('language', work.language_links.map(l => wikilink(l))); } else { add_property('language', wikilink(work.language_links[0])); } -%>
<% if (work.repo) { add_property('repository', `[${work.repo_name || work.repo}](${work.repo})`); } -%>
<% const showSource = work.source && work.source !== work.repo; -%>
<% const sourceLabel = work.repo_name && work.source_name && work.repo_name !== work.source_name ? `${work.source_name} (upstream)` : (work.source_name || work.source); -%>
<% add_property('source', showSource ? `[${sourceLabel}](${work.source})` : undefined); -%>
<% if (work.license_attribution) { add_property('license-attribution', work.license_attribution); } -%>
<% if (work.repository_updated) { add_property('repository-updated', work.repository_updated); } -%>
<% add_property('aliases', work.aliases); -%>
<% add_property('cssclasses', [], { merge: 'replace' }); -%>
<%~ end_YAML() %>
<span class="mas-managed">mas-managed</span>

<% if (!unit) { -%>
# <%= work.title %>

<% } -%>
<% if (work.author) { -%>
*<%~ work.author %>*

<% } -%>
<% if (unit) { -%>
<% if (unit.kind === 'hadith') { -%>
<% for (const h of unit.hadiths) { -%>
# <%= h.number %>

<% if (bilingual === 'table') { -%>
| العربية | English |
| --- | --- |
| <%~ h.arabic.replace(/\n+/g, '<br>') %> | <%~ h.english.replace(/\n+/g, '<br>') %> |

<% } else { -%>
<% if (h.narrator) { -%>
**<%~ h.narrator %>**

<% } -%>
<%~ h.english %>

<%~ h.arabic %>

<% } -%>
<% } -%>
<% } else if (unit.kind === 'book') { -%>
<% const multi = (work.volumes || 1) > 1; -%>
<% for (const p of unit.pages) { -%>
#### p. <%= multi ? `${p.vol}:${p.page}` : p.page %>

<%~ p.body %>

<% } -%>
<% } else { -%>
<% for (const b of unit.blocks) { -%>
# <%= b.number %>

## <%= b.ref %>

<%~ b.body %>

<% } -%>
<% } -%>
<% } else if (work.kind === 'dict') { -%>
## Roots

<% const letters = units.filter(u => u.kind === 'dict-index'); -%>
<% for (const u of letters) { -%>
- <%= wikilink(u.note_stem, u.title || u.base) %> — <%= u.roots.length %>
<% } -%>

<% } else if (work.kind === 'book') { -%>
<% const letterUnits = units.filter(u => u.kind === 'book-letter'); -%>
<% const volumeUnits = units.filter(u => u.kind === 'book-volume'); -%>
<% if (letterUnits.length) { -%>
## Roots

<% for (const u of letterUnits) { -%>
- <%= wikilink(u.note_stem || `${work.dir} - ${u.base}`, u.title || u.base) %>
<% } -%>

<% } else if ((work.volumes || 1) > 1 && volumeUnits.length) { -%>
<% for (const u of volumeUnits) { -%>
- <%= wikilink(u.note_stem || `${work.dir} - ${u.base}`, u.title || u.base) %><% if (u.chapters && u.chapters.length) { %> — <%= u.chapters.length %> chapter<%= u.chapters.length === 1 ? '' : 's' %><% } %>
<% } -%>

<% } else { -%>
<% for (const u of units.filter(u => u.kind === 'book')) { -%>
- <%= wikilink(u.note_stem || `${work.dir} - ${u.base}`, u.title || u.base) %><% if (u.span) { %> — <%= u.span %><% } %>
<% } -%>

<% } -%>
<% } else { -%>
## <%= work.unit_label %>

<% for (const u of units) { -%>
- <%= wikilink(u.note_stem || (work.unit_prefix ? `${work.unit_prefix} - ${u.base}` : u.base), u.title || u.base) %>
<% } -%>

<% } -%>
<span class="mas-managed">/mas-managed</span>

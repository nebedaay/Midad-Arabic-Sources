<% start_YAML(); -%>
<% add_property('document-type', '[[text-source]]'); -%>
<% add_property('created', generated); -%>
<% add_property('updated', updated()); -%>
<% add_property('mas-up', [...work.up, '[[Midad Arabic Sources]]']); -%>
<% add_property('mas-id', 'repo:' + work.key); -%>
<% add_property('mas-kind', 'repo-work'); -%>
<% add_property('mas-source', 'repo:' + work.key); -%>
<% add_property('related', [], { force: true, merge: 'keep' }); -%>
<% add_property('title', work.title); -%>
<% const pub = work.publication || {}; -%>
<% const person = (a) => (typeof a === 'string' ? a : (a.name || [a.first, a.last].filter(Boolean).join(' '))); -%>
<% const pubAuthors = (pub.authors && pub.authors.length) ? pub.authors : (work.authors || []); -%>
<% const pubTranslators = (pub.translators && pub.translators.length) ? pub.translators : (work.translators || []); -%>
<% const pubEditors = pub.editors || []; -%>
<% add_property('item-type', 'book'); -%>
<% if (pubAuthors.length) { add_property('authors', pubAuthors.map(a => wikilink(person(a)))); } -%>
<% if (pubTranslators.length) { add_property('translators', pubTranslators.map(a => wikilink(person(a)))); } -%>
<% if (pubEditors.length) { add_property('editors', pubEditors.map(a => wikilink(person(a)))); } -%>
<% if (pub.publisher) { add_property('publisher', wikilink(pub.publisher)); } -%>
<% if (pub.place) { add_property('place', pub.place); } -%>
<% if (pub.date) { add_property('year', wikilink(String(pub.date).slice(0, 4))); } -%>
<% if (pub.edition) { add_property('edition', pub.edition); } -%>
<% if (pub.mas_note) { add_property('mas-note', pub.mas_note); } -%>
<% add_property('mas-key', work.key); -%>
<% if (work.language_links.length > 1) { add_property('language', work.language_links.map(l => wikilink(l))); } else { add_property('language', wikilink(work.language_links[0])); } -%>
<% if (work.repo) { add_property('repository', `[${work.repo_name || work.repo}](${work.repo})`); } -%>
<% if (work.source) { const label = work.repo_name && work.source_name && work.repo_name !== work.source_name ? `${work.source_name} (upstream)` : (work.source_name || work.source); add_property('source', `[${label}](${work.source})`); } -%>
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
A dictionary has too many roots to list here, so they are indexed by first letter. Each note also carries `term-ar`, `term`, and a `<%= work.note_prefix || 'HW' %> …` alias, so search works too.

<% for (const u of letters) { -%>
- <%= wikilink(u.note_stem, u.title || u.base) %> — <%= u.roots.length %>
<% } -%>

<% } else if (work.kind === 'book') { -%>
<% if ((work.volumes || 1) > 1) { -%>
<% for (const u of units.filter(u => u.kind === 'book-volume')) { -%>
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

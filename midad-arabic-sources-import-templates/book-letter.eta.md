<% start_YAML(); -%>
<% add_property('document-type', '[[text-source]]'); -%>
<% add_property('created', generated); -%>
<% add_property('updated', updated()); -%>
<% add_property('midad-up', [wikilink(work.dir)]); -%>
<% add_property('related', [], { force: true, merge: 'keep' }); -%>
<% add_property('title', unit.title || unit.base); -%>
<% if (work.authors && work.authors.length) { add_property('authors', work.authors.map(a => wikilink(a))); } -%>
<% if (work.language_links.length > 1) { add_property('language', work.language_links.map(l => wikilink(l))); } else { add_property('language', wikilink(work.language_links[0])); } -%>
<% add_property('aliases', work.aliases.slice(0, 1).map(a => `${a} - ${unit.base}`)); -%>
<% add_property('cssclasses', [work.cssclass], { quote: 'never' }); -%>
<%~ end_YAML() %>
<span class="mas-managed">mas-managed</span>

# <%= unit.title %>

<% let lastVolume = null; -%>
<% let lastBab = null; -%>
<% for (const c of (unit.chapters || [])) { -%>
<% const volume = String(c.volume ?? ''); -%>
<% const bab = String(c.bab ?? ''); -%>
<% if (volume !== lastVolume) { lastVolume = volume; lastBab = null; -%>
## المجلد <%= volume %>

<% } -%>
<% if (bab && bab !== lastBab) { lastBab = bab; -%>
### <%= bab %>

<% } -%>
- <%= wikilink(c.note_stem || `${work.dir} - ${c.base}`, c.fasl || c.title) %><% if (c.span) { %> — <%= c.span %><% } %>
<% } -%>
<span class="mas-managed">/mas-managed</span>

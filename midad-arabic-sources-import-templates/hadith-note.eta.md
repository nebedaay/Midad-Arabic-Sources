<% start_YAML(); -%>
<% add_property('document-type', '[[text-source]]'); -%>
<% add_property('created', generated); -%>
<% add_property('updated', updated()); -%>
<% add_property('mas-up', [unit.section_page ? wikilink(unit.section_page) : null, wikilink(work.dir), '[[Midad Arabic Sources]]'].filter(Boolean)); -%>
<% add_property('mas-id', 'repo:' + work.key + ':' + unit.kind + ':' + unit.id); -%>
<% add_property('mas-kind', 'repo-unit'); -%>
<% add_property('mas-work', 'repo:' + work.key); -%>
<% add_property('mas-unit', unit.id); -%>
<% add_property('related', [], { force: true, merge: 'keep' }); -%>
<% add_property('title', unit.title || unit.base); -%>
<% if (work.authors && work.authors.length) { add_property('authors', work.authors.map(a => wikilink(a))); } -%>
<% if (work.translators && work.translators.length) { add_property('translators', work.translators.map(a => wikilink(a))); } -%>
<% if (work.language_links.length > 1) { add_property('language', work.language_links.map(l => wikilink(l))); } else { add_property('language', wikilink(work.language_links[0])); } -%>
<% add_property('aliases', work.aliases.map(a => `${a} - ${unit.base}`)); -%>
<% add_property('cssclasses', [work.cssclass], { quote: 'never' }); -%>
<%~ end_YAML() %>
<span class="mas-managed">mas-managed</span>

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
<% if (!unit.hadiths || !unit.hadiths.length) { -%>
> [!missing-data] No hadiths were found for this chapter in the source.

<% } -%>
<span class="mas-managed">/mas-managed</span>

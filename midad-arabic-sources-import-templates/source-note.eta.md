<% start_YAML(); -%>
<% add_property('document-type', '[[text-source]]'); -%>
<% add_property('created', generated); -%>
<% add_property('updated', updated()); -%>
<% add_property('mas-up', [unit.section_page ? wikilink(unit.section_page) : null, wikilink(work.dir), '[[Midad Arabic Sources]]'].filter(Boolean)); -%>
<% add_property('related', [], { force: true, merge: 'keep' }); -%>
<% add_property('title', unit.title || unit.base); -%>
<% if (work.short) { add_property('shorttitle', work.short); } -%>
<% if (work.authors && work.authors.length) { add_property('authors', work.authors.map(a => wikilink(a))); } -%>
<% if (work.translators && work.translators.length) { add_property('translators', work.translators.map(a => wikilink(a))); } -%>
<% if (work.language_links.length > 1) { add_property('language', work.language_links.map(l => wikilink(l))); } else { add_property('language', wikilink(work.language_links[0])); } -%>
<% add_property('aliases', work.aliases.map(a => `${a} - ${unit.base}`)); -%>
<% add_property('cssclasses', [work.cssclass], { quote: 'never' }); -%>
<%~ end_YAML() %>
<span class="mas-managed">mas-managed</span>

<% for (const b of unit.blocks) { -%>
# <%= b.number %>

## <%= b.ref %>

<%~ b.body %>

<% } -%>
<% if (!unit.blocks || !unit.blocks.length) { -%>
> [!missing-data] No commentary was found for this sūrah in the source.

<% } -%>
<span class="mas-managed">/mas-managed</span>

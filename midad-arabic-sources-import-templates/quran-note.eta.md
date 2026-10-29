<% start_YAML(); -%>
<% add_property('document-type', '[[text-source]]'); -%>
<% add_property('tags', ['quran'], { quote: 'never' }); -%>
<% add_property('total_verses', unit.blocks.length); -%>
<% add_property('created', generated); -%>
<% add_property('updated', updated()); -%>
<% add_property('midad-up', [unit.section_page ? wikilink(unit.section_page) : null, wikilink(work.dir)].filter(Boolean)); -%>
<% add_property('related', [], { force: true, merge: 'keep' }); -%>
<% add_property('title', unit.title || unit.base); -%>
<% if (work.authors && work.authors.length) { add_property('authors', work.authors.map(a => wikilink(a))); } -%>
<% if (work.translators && work.translators.length) { add_property('translators', work.translators.map(a => wikilink(a))); } -%>
<% if (work.language_links.length > 1) { add_property('language', work.language_links.map(l => wikilink(l))); } else { add_property('language', wikilink(work.language_links[0])); } -%>
<% const aliasList = work.aliases.map(a => `${a} - ${unit.base}`); -%>
<% if (work.canonical) { aliasList.push(unit.translit, unit.arabic); } -%>
<% add_property('aliases', aliasList); -%>
<% add_property('cssclasses', [work.language === 'ar' ? 'quran-ar' : 'quran-en'], { quote: 'never' }); -%>
<%~ end_YAML() %>
<span class="mas-managed">mas-managed</span>

<% let prevHafs = []; -%>
<% for (const b of unit.blocks) { -%>
# <%= b.number %>

<% const match = (b.hafs || []).find((n) => !prevHafs.includes(n)); -%>
<% if (match != null) { -%>
## [[<%= unit.base %>#<%= match %>|Ḥafṣ <%= match %>]]

<% } -%>
<%~ b.body %>

<% prevHafs = b.hafs || []; -%>
<% } -%>
<% if (!unit.blocks || !unit.blocks.length) { -%>
> [!missing-data] No text was found for this sūrah in the source.

<% } -%>
<span class="mas-managed">/mas-managed</span>

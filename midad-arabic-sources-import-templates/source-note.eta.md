<% start_YAML(); -%>
<% add_property('document-type', '[[text-source]]'); -%>
<% add_property('created', generated, { merge: 'keep' }); -%>
<% add_property('updated', updated()); -%>
<% add_property('midad-up', [unit.section_page ? wikilink(unit.section_page) : null, wikilink(work.dir)].filter(Boolean)); -%>
<% add_property('related', [], { force: true, merge: 'keep' }); -%>
<% add_property('title', unit.title || unit.base); -%>
<% if (work.short) { add_property('shorttitle', work.short); } -%>
<% if (work.authors && work.authors.length) { add_property('authors', work.authors.map(a => wikilink(a))); } -%>
<% if (work.translators && work.translators.length) { add_property('translators', work.translators.map(a => wikilink(a))); } -%>
<% if (work.language_links.length > 1) { add_property('language', work.language_links.map(l => wikilink(l))); } else { add_property('language', wikilink(work.language_links[0])); } -%>
<% add_property('aliases', work.aliases.slice(0, 1).map(a => `${a} - ${unit.base}`)); -%>
<% add_property('cssclasses', [work.cssclass], { quote: 'never' }); -%>
<%~ end_YAML() %>
<span class="mas-managed">mas-managed</span>

<% for (const b of unit.blocks) { -%>
<% const digits = (value) => String(value).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))); -%>
<% const num = digits(b.number).trim(); -%>
<% const single = /^(\d+)$/.exec(num); -%>
<% const range = /^(\d+)\s*[–—-]\s*(\d+)$/.exec(num); -%>
<% const anchor = single ? single[1] : (range ? range[1] : ""); -%>
<% const label = single ? `${unit.id}:${single[1]}` : (range ? `${unit.id}:${range[1]}–${unit.id}:${range[2]}` : ""); -%>
<% const target = (b.ref || "").match(/\[\[\s*([^\]|]+)/); -%>
<% const href = target ? target[1].trim() : (anchor ? `${unit.base}#${anchor}` : ""); -%>
# <%= num %>

<% if (href && label) { -%>
**[[<%= href %>|<%= label %>]]**﻿<%~ b.body %>
<% } else { -%>
<%~ b.body %>
<% } -%>

<% } -%>
<% if (!unit.blocks || !unit.blocks.length) { -%>
> [!missing-data] No commentary was found for this sūrah in the source.

<% } -%>
<span class="mas-managed">/mas-managed</span>

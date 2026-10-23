<% const isProse = work.body === 'prose'; -%>
<% start_YAML(); -%>
<% add_property('document-type', '[[text-source]]'); -%>
<% add_property('created', generated); -%>
<% add_property('updated', updated()); -%>
<% add_property('mas-up', [unit.section_page ? wikilink(unit.section_page) : null, wikilink(work.dir), '[[Midad Arabic Sources]]'].filter(Boolean)); -%>
<% add_property('mas-id', 'repo:' + work.key + ':' + unit.kind + ':' + unit.base); -%>
<% add_property('mas-kind', 'repo-unit'); -%>
<% add_property('mas-work', 'repo:' + work.key); -%>
<% add_property('mas-unit', unit.base); -%>
<% add_property('related', [], { force: true, merge: 'keep' }); -%>
<% add_property('title', unit.title || `${unit.root.arabic} ${unit.root.roman}`); -%>
<% add_property('term-ar', unit.root.arabic); -%>
<% add_property('term', unit.root.roman); -%>
<% add_property(`${(work.note_prefix || 'HW').toLowerCase()}-id`, unit.id); -%>
<% add_property('language', wikilink('Arabic')); -%>
<% add_property('aliases', [`${work.note_prefix || 'HW'} ${unit.root.arabic}`, `${work.note_prefix || 'HW'} ${unit.root.roman}`]); -%>
<% add_property('cssclasses', [work.cssclass, isProse ? 'mas-prose' : null].filter(Boolean), { quote: 'never' }); -%>
<%~ end_YAML() %>
<span class="mas-managed">mas-managed</span>

<% const rowsOf = (e) => (e.bullets || e.lines || []); -%>
<% const isBullets = (e) => Array.isArray(e.bullets); -%>
<% const defBlock = (e) => ['> [!mas-dictionary-definition]', ...rowsOf(e).map((b, i) => `> - ${i === 0 && isBullets(e) ? `<span class="mas-hw">${b}</span>` : b}`)].join('\n'); -%>
<% const bodyOf = (e) => isProse ? (e.paragraphs || []).join('\n\n') : defBlock(e); -%>
<% const headingOf = (e, level) => `${'#'.repeat(level)} ${e.roman ? `*${e.roman}* ` : ''}(${e.arabic}) ^${e.id}`; -%>
<% const blocks = [headingOf(unit.root, 1)]; -%>
<% if (bodyOf(unit.root)) blocks.push(bodyOf(unit.root)); -%>
<% if (unit.root.supplement) blocks.push('# Supplement'); -%>
<% let suppShown = !!unit.root.supplement; -%>
<% for (const e of unit.entries) { -%>
<% if (e.supplement && !suppShown) { blocks.push('# Supplement'); suppShown = true; } -%>
<% blocks.push(headingOf(e, 2)); -%>
<% if (bodyOf(e)) blocks.push(bodyOf(e)); -%>
<% } -%>
<%~ blocks.join('\n\n') %>

<span class="mas-managed">/mas-managed</span>

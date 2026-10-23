<% start_YAML(); -%>
<% add_property('document-type', '[[text-source]]'); -%>
<% add_property('created', generated); -%>
<% add_property('updated', updated()); -%>
<% add_property('mas-up', [wikilink(work.dir), '[[Midad Arabic Sources]]']); -%>
<% add_property('mas-id', 'repo:' + work.key + ':' + unit.kind + ':' + unit.base); -%>
<% add_property('mas-kind', 'repo-unit'); -%>
<% add_property('mas-work', 'repo:' + work.key); -%>
<% add_property('mas-unit', unit.base); -%>
<% add_property('related', [], { force: true, merge: 'keep' }); -%>
<% add_property('title', unit.title || unit.base); -%>
<% add_property('language', wikilink('Arabic')); -%>
<% add_property('aliases', []); -%>
<% add_property('cssclasses', [work.cssclass], { quote: 'never' }); -%>
<%~ end_YAML() %>
<span class="mas-managed">mas-managed</span>

# <%= unit.base %>

<% for (const r of unit.roots) { -%>
- <%= wikilink(r.base, r.title || `${r.arabic} ${r.roman}`) %>
<% } -%>

<span class="mas-managed">/mas-managed</span>

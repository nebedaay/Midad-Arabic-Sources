<% start_YAML(); -%>
<% add_property('created', generated, { merge: 'keep' }); -%>
<% add_property('mas-up', parent === 'Midad Arabic Sources' ? ['[[Midad Arabic Sources]]'] : [wikilink(parent), '[[Midad Arabic Sources]]']); -%>
<% add_property('cssclasses', [], { merge: 'replace' }); -%>
<%~ end_YAML() %>
<span class="mas-managed">mas-managed</span>

<% for (const s of sections) { -%>
# <%= s.name %>

<% for (const w of s.works) { -%>
- <%= wikilink(w.dir, w.title) %>
<% } -%>

<% } -%>
<span class="mas-managed">/mas-managed</span>

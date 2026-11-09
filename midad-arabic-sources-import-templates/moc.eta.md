<% start_YAML(); -%>
<% add_property('created', generated, { merge: 'keep' }); -%>
<% add_property('midad-up', parent === 'Midad Arabic Sources' ? ['[[Midad Arabic Sources]]'] : [wikilink(parent), '[[Midad Arabic Sources]]']); -%>
<% add_property('cssclasses', [], { merge: 'replace' }); -%>
<%~ end_YAML() %>
<span class="mas-managed">mas-managed</span>

<% for (const s of sections) { -%>
# <%= s.name %>

<% for (const w of s.works) { -%>
<% if (w.linked === false) { -%>
- <%= w.title %><% if (w.count != null) { %> (<%= w.count %>)<% } %>
<% } else { -%>
- <%= wikilink(w.dir, w.title) %><% if (w.count != null) { %> (<%= w.count %>)<% } %>
<% } -%>
<% } -%>

<% } -%>
<span class="mas-managed">/mas-managed</span>

<% start_YAML(); -%>
<% add_property('created', generated, { merge: 'keep' }); -%>
<% add_property('up', ['[[Home]]'], { merge: 'keep' }); -%>
<%~ end_YAML() %>
<span class="mas-managed">mas-managed</span>

>[!mas-sources-list]
<% for (const g of groups) { -%>
>- <%= wikilink(g.name, g.count != null ? `${g.label} (${g.count})` : g.label) %>
<% for (const item of g.items) { -%>
>	- <%= wikilink(item.name, item.count != null ? `${item.label} (${item.count})` : item.label) %>
<% } -%>
<% } -%>

<span class="mas-managed">/mas-managed</span>

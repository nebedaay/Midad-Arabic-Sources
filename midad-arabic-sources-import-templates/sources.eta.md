<% start_YAML(); -%>
<% add_property('created', generated, { merge: 'keep' }); -%>
<% add_property('up', ['[[Home]]'], { merge: 'keep' }); -%>
<%~ end_YAML() %>
<span class="mas-managed">mas-managed</span>

>[!mas-sources-list]
<% for (const m of mocs) { -%>
>- <%= wikilink(m) %>
<% } -%>

<span class="mas-managed">/mas-managed</span>

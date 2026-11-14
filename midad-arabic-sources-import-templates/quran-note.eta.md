<% start_YAML(); -%>
<% add_property('document-type', '[[text-source]]'); -%>
<% /* Retired: quran notes are identified by their template/model and path. */ -%>
<% add_property('tags', '', { merge: 'remove' }); -%>
<% add_property('total_verses', unit.blocks.length); -%>
<% add_property('created', generated, { merge: 'keep' }); -%>
<% add_property('updated', updated()); -%>
<% add_property('midad-up', [unit.section_page ? wikilink(unit.section_page) : null, wikilink(work.dir)].filter(Boolean)); -%>
<% add_property('related', [], { force: true, merge: 'keep' }); -%>
<% add_property('title', unit.title || unit.base); -%>
<% if (work.authors && work.authors.length) { add_property('authors', work.authors.map(a => wikilink(a))); } -%>
<% if (work.translators && work.translators.length) { add_property('translators', work.translators.map(a => wikilink(a))); } -%>
<% if (work.language_links.length > 1) { add_property('language', work.language_links.map(l => wikilink(l))); } else { add_property('language', wikilink(work.language_links[0])); } -%>
<% const aliasList = work.aliases.slice(0, 1).map(a => `${a} - ${unit.base}`); -%>
<% if (work.canonical) { aliasList.push(unit.translit, unit.arabic); } -%>
<% add_property('aliases', aliasList); -%>
<% const riwayaKey = String(work.dir || work.title || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); -%>
<% const quranClasses = [work.language === 'ar' ? 'quran-ar' : 'quran-en']; -%>
<% for (const [key, cls] of [['warsh', 'quran-warsh'], ['qalun', 'quran-qalun'], ['duri', 'quran-duri'], ['susi', 'quran-susi']]) { if (riwayaKey.includes(key)) quranClasses.push(cls); } -%>
<% add_property('cssclasses', quranClasses, { quote: 'never' }); -%>
<%~ end_YAML() %>
<span class="mas-managed">mas-managed</span>

<% const firstBody = (unit.blocks && unit.blocks[0] && unit.blocks[0].body) || ""; -%>
<% const firstPlain = firstBody.normalize("NFKD").replace(/[\u0300-\u036f\u064b-\u065f\u0670\u06d6-\u06ed]/g, "").replace(/[\u0671\u0622\u0623\u0625]/g, "\u0627").replace(/\s+/g, ""); -%>
<% if (!firstPlain.startsWith("\u0628\u0633\u0645") && String(unit.id) !== "9") { -%>
بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ

<% } -%>
<% let prevHafs = []; -%>
<% for (const b of unit.blocks) { -%>
# <%= b.number %>

<% const match = (b.hafs || []).find((n) => !prevHafs.includes(n)); -%>
<% if (!work.canonical && match != null) { -%>
## [[<%= unit.base %>#<%= match %>|Ḥafṣ <%= match %>]]

<% } -%>
<%~ b.body %>

<% prevHafs = b.hafs || []; -%>
<% } -%>
<% if (!unit.blocks || !unit.blocks.length) { -%>
> [!missing-data] No text was found for this sūrah in the source.

<% } -%>
<span class="mas-managed">/mas-managed</span>

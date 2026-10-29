#!/bin/zsh
# Build the Zotero plugin .xpi (a zip of manifest.json + bootstrap.js + prefs.js + locale/).
set -e
here="${0:A:h}"
cd "$here"
rm -f midad-arabic-transliteration.xpi
zip -qXrD midad-arabic-transliteration.xpi manifest.json bootstrap.js prefs.js locale
echo "Built: $here/midad-arabic-transliteration.xpi"

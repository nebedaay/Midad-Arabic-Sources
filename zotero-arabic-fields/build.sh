#!/bin/zsh
# Build the Zotero plugin .xpi (a zip of manifest.json + bootstrap.js + prefs.js + locale/).
set -e
here="${0:A:h}"
cd "$here"
rm -f arabic-fields-romanizer.xpi
zip -qXrD arabic-fields-romanizer.xpi manifest.json bootstrap.js prefs.js locale
echo "Built: $here/arabic-fields-romanizer.xpi"

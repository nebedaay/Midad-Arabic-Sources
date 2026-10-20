# Midad Arabic Sources — import templates

The `.eta.md` files in this folder are the default ETA templates the plugin renders imported works with. The full reference — the render-model variables, the helper functions, the merge and auto-update behaviour, and the source JSON shapes — lives in the plugin documentation at [`docs/templates.md`](../docs/templates.md), which is bundled into the plugin and readable in-app under **Settings → Midad Arabic Sources → Documentation → Templates**.

The plugin bundles these templates too (see `gen-assets.mjs`), and `npm run deploy` copies this folder into `.obsidian/plugins/midad-arabic-sources/`.

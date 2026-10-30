# Transliteration

Midad Arabic Sources romanizes Arabic from Obsidian. A resident Python service does the work, so the model loads once and Obsidian does not pay for it on every call.

The romanization server also has a command-line interface for running it and invoking transliteration from a terminal (see the [Commands](./commands.md) documentation). It also provides a local web interface for use in a web browser (see below).

## Commands

- **Transliterate selection to clipboard** — romanize the selection, or the current line if nothing is selected, and copy the result.
- **Transliterate note to new note** — romanize a whole note (or the selection) into a sibling note named `<note> (romanized)`.
- **Transliteration server…** — one dialog that shows the server's status (running or not, engines loaded, which engine is actually being used, and the LLM providers) with a single button that **Starts** or **Stops** it. The **Transliteration** settings page carries the same status line and the same button, so you never have to check before knowing whether to start or stop.

Both transliteration commands open a small dialog first, with two toggles:

- **Full vocalization** — retain case endings and tanwīn (with pausal shortening at the end of a passage).
- **Use LLM** — romanize with the configured API instead of the rule engine. Your choices are remembered as the new defaults.

Only Arabic-script runs are changed. Markdown, newlines, link targets, and `{.quran-quote}` attributes pass through untouched; a link’s alias is transliterated.

## The resident server

The service is `scripts/transliterate-server.py` and listens on `127.0.0.1:8756` by default. Start it from the command palette, or by hand:

```shell
python3 scripts/transliterate-server.py --port 8756
```

The plugin's **Start transliteration server** loads only `bert` — it passes no `--preload`, so the script's `bert` default applies. When starting by hand, run it the same way: **no `--preload` flag**. `--preload` is repeatable, so a server started as `--preload bert --preload mle` loads both; that is how an `mle` engine ends up resident even though nothing asks for it. **Check transliteration server** reports what is *loaded*, not what is used, so `engines_loaded: ["bert","mle"]` means the server was started with both preloads.

**Restart the server whenever the engine changes.** A long-running server keeps serving the code it loaded at startup, so an older `arabic-bw-transliterate.py` can keep running while the file on disk is new. This is exactly how a stale engine once silently stripped final short vowels and tanwīn from every reading. **Check transliteration server** reports only the *loaded* engines, so it cannot see that the code is out of date. When in doubt, **Stop transliteration server** then **Start transliteration server**.

## Engines

Set the engine under **Transliteration → Engine**.

| Engine | Startup | Use |
| --- | --- | --- |
| `bert` (default) | ~16 s | Best for unvocalized prose; the engine the plugin is tuned for. |
| `mle` (opt-in) | ~2 s | Faster and rougher on classical text; choose it only if you prefer it. Needs the calima MLE data. |
| `none` | ~1 s | No CAMeL at all; fully vocalized input only, and no proclitic hyphens. |

`bert` is the default and what all the tuning targets: it reads **context**, so it diacritizes unvocalized classical prose far better than `mle`, at the cost of size and startup — ~0.4 GB and ~16 s for the MSA model, against ~85 MB and ~2 s for MLE (both share the ~160 MB morphology database). `mle` is never preloaded or selected for you — pick it under **Transliteration → Engine** only if you want it. If `bert` cannot load (missing `transformers` or its data) the script falls back to `mle` automatically and tells you — an Obsidian alert, or stderr at the CLI. See [Dependencies](./dependencies.md) for the install sizes.

The BERT load is per process, which is why the service exists: interactive use pays it once for the session instead of on every call.

## Romanization options

- **Sun-letter assimilation** — assimilate the article before sun letters (`ash-shams`); when off, the article is invariant (`al-shams`). Off by default.
- **Keep case endings** — retain noun and adjective iʿrāb endings and `-un`/`-in` tanwīn. Off by default; verb inflections and pronominal-suffix vowels are always kept. Qurʾān spans are always fully vocalized.
- **Name mode** — capitalize each substantive word, for author and editor fields (`al-Qāḍī ʿIyāḍ`, `al-ʿAṭṭār`). `al-` stays lowercase unless it opens the field; `b.`/`bt.`/`wuld` stay lowercase.
- **Final dotless yāʾ** — read a final `ى` as alif maqṣūra (`ā`), or let the analysis choose. After a kasra it is always read as a defective yāʾ (`zidnī`), never as `aī`.

## The convention

The engine implements the IAFR/vault transliteration guidelines, not a generic romanization:

- The definite article is invariant `al-`, hyphenated, with elision on proclitics (`wa-l-`, `bi-l-`, `lil-`).
- Tāʾ marbūṭa is dropped after a short fatḥa (`al-qiyāma`), kept as `h` after ā (`al-ḥayāh`), and written `t` in iḍāfa.
- Feminine nisba `ـيّة` is `-iyya`; masculine `ـيّ` is `-ī`.
- Word-initial `آ` is `ā`; elsewhere madda is `ʾā` (`al-qurʾān`).
- Tanwīn `-an` is kept by default; `-un`/`-in` only with **Keep case endings**. A defective-root indefinite keeps `-in` (`qāḍin`).
- Provided tashkīl is authoritative: a fully vocalized token is transliterated from its own ḥarakāt, and the engine is used only to segment proclitics.

## The user lexicon

When the engine has no credible morphological analysis for a term, the plugin can ask you for a romanization and remember it. After a note transliteration, a dialog lists the unknown terms with a suggested reading per row; edit any that are wrong and **Save** to add them to the lexicon (`scripts/transliteration-lexicon.json`). The next run uses them.

The lexicon is also the place to pin a term the engine misreads. It grows file by file.

## LLM romanization

LLM configurations are managed on the plugin's **LLM** settings page. A configuration records a provider, model, optional base URL, and API key:

- **Provider** — Gemini, DeepSeek, or **OpenAI-compatible**.
- **Model** — e.g. `gemini-3.5-flash-lite`; for OpenAI-compatible, e.g. `gpt-4o-mini` or your local model.
- **Base URL** — OpenAI-compatible only: the endpoint, e.g. `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`, or `http://localhost:11434/v1`. Empty uses the server's `OPENAI_BASE_URL`.
- **API key** — optional; used only when the server process has no `GEMINI_API_KEY` / `GOOGLE_API_KEY` / `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` in its environment.

Add as many configurations as you need with **Add LLM configuration**; then choose one for **Transliteration**, one for **Transcription**, and one for **Translation**. Configurations can share a model and differ only by API key. Transcription and translation currently require a Gemini configuration; transliteration accepts all three providers.

**OpenAI-compatible** is any endpoint that speaks the OpenAI chat-completions API: OpenAI itself, OpenRouter, Groq, or a local llama.cpp / Ollama / vLLM server. Set the base URL, model, and key in the configuration (or the server's `OPENAI_BASE_URL` / `OPENAI_MODEL` / `OPENAI_API_KEY`); the CLI takes `--provider openai --base-url … --model …`.

Turn it on per call with **Use LLM** in the transliteration dialog. The LLM path lives in the server (`POST /romanize`), so it can also translate in the same call.

## The web browser interface

The server serves a self-contained interface at `http://127.0.0.1:8756/`. Arabic goes on the right, the result on the left, with route (rule engine or LLM) and the same options as the commands. Unknown terms are listed below the result with an editable romanization and an **Add** button that writes to the lexicon and refreshes the result in place. It is handy for working outside Obsidian, or for testing after an engine change. The same script also has a command-line interface; see [Commands → From the command line](./commands.md#from-the-command-line). For a Zotero item, the optional [Midad Arabic Transliteration](./midad-arabic-transliteration.md) companion uses the same server to create a romanized copy.

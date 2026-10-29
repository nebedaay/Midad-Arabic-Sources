/* Midad Arabic Transliteration — Zotero 7 bootstrapped plugin
 *
 * Adds an item context-menu action "Midad: Create romanized copy" that clones the
 * selected item and transliterates its Arabic fields via the local
 * transliteration server (scripts/transliterate-server.py). The place field is
 * mapped to an accepted English city name by the server's /place endpoint, and
 * transliterated otherwise.
 */

"use strict";

var AFR = {
	id: null,
	rootURI: null,
	initialized: false,
	menuIDs: [],
	pendingUnknown: new Map(),
	defaultServer: "http://127.0.0.1:8756",
	defaultEngine: "bert",
};

const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

function debug(msg) {
	try { Zotero.debug("MidadArabicTransliteration: " + msg); } catch (e) {}
}

function serverUrl() {
	try { return Zotero.Prefs.get("extensions.midadArabicTransliteration.serverUrl", true) || AFR.defaultServer; }
	catch (e) { return AFR.defaultServer; }
}

function engine() {
	try { return Zotero.Prefs.get("extensions.midadArabicTransliteration.engine", true) || AFR.defaultEngine; }
	catch (e) { return AFR.defaultEngine; }
}

function install() {}
function uninstall() {}

function startup({ id, version, rootURI }, reason) {
	AFR.id = id;
	AFR.rootURI = rootURI;
	AFR.initialized = true;
	if (typeof Zotero === "undefined") return;
	if (Zotero.MenuManager && Zotero.MenuManager.registerMenu) {
		registerMenus();
	} else if (Zotero.getMainWindows) {
		for (const win of Zotero.getMainWindows()) addUI(win);
	}
	debug("started");
}

function registerMenus() {
	const setLabel = (event, context) => {
		try {
			if (context.menuElem) context.menuElem.setAttribute("label", "Midad: Create romanized copy");
		} catch (e) {}
	};
	const run = (event, context) => {
		let items = context.items;
		if (!items) {
			try { items = Zotero.getActiveZoteroPane().getSelectedItems(); } catch (e) { items = []; }
		}
		createRomanizedCopy(items || []).catch(reportError);
	};
	const targets = [
		["midad-arabic-transliteration-item", "main/library/item"],
		["midad-arabic-transliteration-tools", "main/menubar/tools"],
	];
	for (const [menuID, target] of targets) {
		try {
			const id = Zotero.MenuManager.registerMenu({
				menuID,
				pluginID: AFR.id,
				target,
				menus: [{ menuType: "menuitem", onShowing: setLabel, onCommand: run }],
			});
			if (id) AFR.menuIDs.push(id);
			debug(`registerMenu ${target} -> ${id}`);
		} catch (e) {
			debug(`registerMenu ${target} failed: ${e}`);
		}
	}
}

function shutdown(data, reason) {
	if (reason === APP_SHUTDOWN) return;
	if (typeof Zotero === "undefined") return;
	if (Zotero.MenuManager && Zotero.MenuManager.unregisterMenu) {
		for (const id of AFR.menuIDs) {
			try { Zotero.MenuManager.unregisterMenu(id); } catch (e) {}
		}
	}
	AFR.menuIDs = [];
	if (Zotero.getMainWindows) {
		for (const win of Zotero.getMainWindows()) removeUI(win);
	}
	AFR.initialized = false;
}

function onMainWindowLoad({ window }) {
	if (AFR.initialized && AFR.menuIDs.length === 0) addUI(window);
}

function onMainWindowUnload({ window }) {
	removeUI(window);
}

function addUI(win) {
	try {
		const doc = win.document;
		const menu = doc.getElementById("zotero-itemmenu");
		if (!menu || doc.getElementById("midad-arabic-transliteration")) return;
		const mi = doc.createXULElement("menuitem");
		mi.id = "midad-arabic-transliteration";
		mi.setAttribute("label", "Midad: Create romanized copy");
		mi.addEventListener("command", () => {
			const items = win.ZoteroPane ? win.ZoteroPane.getSelectedItems() : [];
			createRomanizedCopy(items).catch((e) => reportError(e));
		});
		menu.appendChild(mi);
	} catch (e) {
		debug("addUI failed: " + e);
	}
}

function removeUI(win) {
	try {
		const el = win.document.getElementById("midad-arabic-transliteration");
		if (el) el.remove();
	} catch (e) {}
}

function reportError(e) {
	debug("error: " + (e && e.message ? e.message : e));
	try {
		const pw = new Zotero.ProgressWindow();
		pw.changeHeadline("Midad Arabic Transliteration");
		pw.addDescription("Failed: " + (e && e.message ? e.message : e));
		pw.show();
		pw.startCloseTimer(5000);
	} catch (e2) {}
}

async function postJson(path, payload) {
	const url = serverUrl().replace(/\/+$/, "") + path;
	const xhr = await Zotero.HTTP.request("POST", url, {
		body: JSON.stringify(payload),
		headers: { "Content-Type": "application/json" },
		responseType: "json",
	});
	return xhr.response || JSON.parse(xhr.responseText);
}

async function transliterate(value, opts) {
	const data = await postJson("/transliterate", Object.assign({ text: value, engine: engine() }, opts || {}));
	if (data && data.error) throw new Error(data.error);
	if (data && Array.isArray(data.unknown)) {
		for (const u of data.unknown) AFR.pendingUnknown.set(u.term, u.guess || "");
	}
	return data && data.romanized != null ? data.romanized : value;
}

async function promptForUnknown() {
	if (!AFR.pendingUnknown.size) return false;
	const win = Zotero.getMainWindow();
	const entries = {};
	for (const [term, guess] of AFR.pendingUnknown) {
		try {
			const input = { value: guess || "" };
			const ok = Services.prompt.prompt(
				win,
				"Midad Arabic Transliteration",
				`Transliteration for «${term}»:`,
				input,
				null,
				{}
			);
			if (ok && input.value && input.value.trim()) entries[term] = input.value.trim();
		} catch (e) {
			debug("prompt failed: " + e);
		}
	}
	AFR.pendingUnknown.clear();
	if (!Object.keys(entries).length) return false;
	try {
		await postJson("/lexicon", { entries });
		debug(`lexicon updated with ${Object.keys(entries).length} term(s)`);
		return true;
	} catch (e) {
		debug("lexicon save failed: " + e);
		return false;
	}
}

async function transliteratePlace(value) {
	const data = await postJson("/place", { text: value, engine: engine() });
	return data && data.place != null ? data.place : value;
}

async function fillCopy(copy, item, placeField) {
	for (const fieldID of Zotero.ItemFields.getItemTypeFields(item.itemTypeID)) {
		const value = item.getField(fieldID);
		if (!value) continue;
		if (fieldID === placeField) {
			copy.setField(fieldID, ARABIC_RE.test(value) ? await transliteratePlace(value) : value);
		} else if (ARABIC_RE.test(value)) {
			copy.setField(fieldID, await transliterate(value));
		} else {
			copy.setField(fieldID, value);
		}
	}
	const creators = item.getCreators().map((c) => ({
		firstName: c.firstName || "",
		lastName: c.lastName || "",
		creatorType: c.creatorType || (c.creatorTypeID ? Zotero.CreatorTypes.getName(c.creatorTypeID) : "author"),
		fieldMode: c.fieldMode || 0,
	}));
	for (const c of creators) {
		if (c.firstName && ARABIC_RE.test(c.firstName)) c.firstName = await transliterate(c.firstName, { name: true });
		if (c.lastName && ARABIC_RE.test(c.lastName)) c.lastName = await transliterate(c.lastName, { name: true });
	}
	copy.setCreators(creators);
}

async function createRomanizedCopy(items) {
	const selected = (items || []).filter((i) => i.isRegularItem());
	if (!selected.length) {
		const pw = new Zotero.ProgressWindow();
		pw.changeHeadline("Midad Arabic Transliteration");
		pw.addDescription("Select a regular item first.");
		pw.show();
		pw.startCloseTimer(4000);
		return;
	}

	const pw = new Zotero.ProgressWindow();
	pw.changeHeadline("Midad Arabic Transliteration");
	pw.addDescription("Transliterating fields…");
	pw.show();

	const placeField = Zotero.ItemFields.getID("place");
	let count = 0;
	let lastCopy = null;
	const created = [];

	for (const item of selected) {
		const copy = new Zotero.Item(Zotero.ItemTypes.getName(item.itemTypeID));
		copy.libraryID = item.libraryID;
		await fillCopy(copy, item, placeField);
		for (const tag of item.getTags()) copy.addTag(tag.tag, tag.type);
		copy.addTag("romanized");
		await copy.saveTx();
		created.push({ original: item, copy });
		lastCopy = copy;
		count++;
	}

	try {
		const win = Zotero.getMainWindow();
		if (lastCopy && win && win.ZoteroPane) win.ZoteroPane.selectItem(lastCopy.id);
	} catch (e) {}

	if (await promptForUnknown()) {
		for (const { original, copy } of created) {
			await fillCopy(copy, original, placeField);
			await copy.saveTx();
		}
	}

	pw.addDescription(`Created ${count} romanized ${count === 1 ? "copy" : "copies"}.`);
	pw.startCloseTimer(4000);
}

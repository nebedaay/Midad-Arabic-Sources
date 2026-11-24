class TFile {
	constructor(path) {
		this.path = path;
		this.extension = path.split(".").pop() || "";
		this.stat = { size: 0, mtime: Date.now() };
	}
}

function normalizePath(value) {
	return String(value).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
}

/** The dialog base the modules extend; the tests never open one. */
class Modal {
	constructor(app) {
		this.app = app;
		this.contentEl = {};
		this.titleEl = {};
		this.modalEl = {};
	}
	open() {}
	close() {}
	onOpen() {}
	onClose() {}
}

class Notice {
	constructor() {}
}

class Setting {
	constructor() {}
	setName() { return this; }
	setDesc() { return this; }
	addText() { return this; }
	addButton() { return this; }
	addDropdown() { return this; }
}

function setIcon() {}
function getIcon() { return null; }
function addIcon() {}
function requestUrl() { return Promise.resolve({}); }
async function ensureFolder() {}

module.exports = { TFile, normalizePath, Modal, Notice, Setting, setIcon, getIcon, addIcon, requestUrl, ensureFolder };

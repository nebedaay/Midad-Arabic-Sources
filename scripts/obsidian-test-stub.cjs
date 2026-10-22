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

module.exports = { TFile, normalizePath };

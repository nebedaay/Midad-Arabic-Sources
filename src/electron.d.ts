/** Electron's renderer-only helper for turning a chosen File into a path. */
declare module "electron" {
	export const webUtils:
		| {
				getPathForFile(file: File): string;
		  }
		| undefined;
}

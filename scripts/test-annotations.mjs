import esbuild from "esbuild";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

const root = process.cwd();
const outfile = path.join(root, "tmp", "annotations-regression.cjs");
fs.mkdirSync(path.dirname(outfile), { recursive: true });
await esbuild.build({
	entryPoints: [path.join(root, "src/sourceAnnotations/regression.ts")],
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "es2018",
	outfile,
	plugins: [{
		name: "obsidian-test-stub",
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({
				path: path.join(root, "scripts/obsidian-test-stub.cjs"),
			}));
		},
	}],
});

const require = createRequire(import.meta.url);
const { runAnnotationRegressionTests } = require(outfile);
const result = await runAnnotationRegressionTests();
for (const line of result.lines) console.log(line);
console.log(`\n${result.passed} passed, ${result.failed} failed`);
fs.rmSync(outfile, { force: true });
process.exit(result.failed ? 1 : 0);

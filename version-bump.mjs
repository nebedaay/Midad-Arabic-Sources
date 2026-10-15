/*
 * version-bump.mjs — sync the release version into every manifest Obsidian
 * reads, so a release only needs the version set in one place.
 *
 * Usage:
 *   1. Set the new version in package.json, e.g.
 *        npm version 0.2.8 --no-git-tag-version
 *      (or edit the "version" field by hand).
 *   2. npm run bump
 *
 * The target version comes from package.json via npm's npm_package_version
 * environment variable. manifest.json, versions.json and package-lock.json
 * are rewritten in place; each keeps its existing indentation so the diff
 * stays small.
 */

import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
  console.error(
    "version-bump: no npm_package_version — run this via `npm run bump`."
  );
  process.exit(1);
}

// manifest.json — tab-indented; its minAppVersion is what versions.json maps to.
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const minAppVersion = manifest.minAppVersion;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

// versions.json — Obsidian's { "<plugin version>": "<min app version>" } map,
// 2-space indented; used to decide compatibility on install/update.
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "  ") + "\n");

// package-lock.json — keep its root "version" in step with package.json so
// `npm ci` (release CI) does not warn about a version mismatch.
try {
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  lock.version = targetVersion;
  if (lock.packages && lock.packages[""]) {
    lock.packages[""].version = targetVersion;
  }
  writeFileSync("package-lock.json", JSON.stringify(lock, null, "  ") + "\n");
} catch {
  // No lockfile — nothing to keep in sync.
}

console.log(
  `version-bump: ${targetVersion} written to manifest.json, versions.json, package-lock.json`
);

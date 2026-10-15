/*
 * release-notes.mjs — produce release-notes.md for a release.
 *
 * release-notes.md is what the Release workflow publishes as the GitHub
 * release body (see .github/workflows/release.yml). If it already has content
 * (written by hand or by the agent preparing the release), it is left alone.
 * Otherwise a scaffold is written from the commits since the last tag plus the
 * staged file list, so there is always something to start from.
 *
 * Run via `npm run rlnotes` (called by `npm run bump`).
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";

const run = (cmd) => {
  try {
    return execSync(cmd, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

const existing = existsSync("release-notes.md")
  ? readFileSync("release-notes.md", "utf8").trim()
  : "";
if (existing) {
  console.log("release-notes.md already has content — leaving it as is.");
  process.exit(0);
}

run("git fetch --tags --quiet");
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const lastTag = run("git describe --tags --abbrev=0");
const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
const log = run(`git log ${range} --pretty=format:'- %s'`);
const stat = run("git diff --cached --stat");

const body = [
  "Install/update via BRAT.",
  "",
  `### ${version}`,
  "",
  log || "_(describe the changes here — commit messages, then details.)_",
  "",
  "<details><summary>Changed files</summary>",
  "",
  "```",
  stat || "(nothing staged)",
  "```",
  "",
  "</details>",
  "",
].join("\n");

writeFileSync("release-notes.md", body);
console.log("release-notes.md scaffolded — review/edit it before releasing.");

// Cuts a release: bumps the version in package.json, package-lock.json,
// tauri.conf.json and Cargo.toml (and Cargo.lock through cargo), commits,
// tags vX.Y.Z and pushes. The Release workflow does the rest.
//
//   npm run release 2.1.0
//   npm run release patch|minor|major
//
// Refuses to run with uncommitted changes, off main, or behind origin.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sh = (cmd, opts = {}) => {
  const out = execSync(cmd, { cwd: root, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...opts });
  // With stdout ignored or inherited there is nothing to return.
  return out == null ? "" : String(out).trim();
};

function fail(msg) {
  console.error(`release: ${msg}`);
  process.exit(1);
}

const arg = process.argv[2];
if (!arg) fail("say which version: 2.1.0, or patch | minor | major");

const pkgPath = resolve(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const current = pkg.version;

let next = arg;
if (["patch", "minor", "major"].includes(arg)) {
  const [ma, mi, pa] = current.split(".").map(Number);
  next = arg === "major" ? `${ma + 1}.0.0` : arg === "minor" ? `${ma}.${mi + 1}.0` : `${ma}.${mi}.${pa + 1}`;
}
if (!/^\d+\.\d+\.\d+$/.test(next)) fail(`"${next}" is not a plain X.Y.Z version`);
if (next === current) fail(`already at ${current}`);

// A release is cut from a clean, current main.
if (sh("git status --porcelain")) fail("commit or stash your changes first");
if (sh("git rev-parse --abbrev-ref HEAD") !== "main") fail("switch to main first");
sh("git fetch origin main --tags");
if (sh("git rev-list --count HEAD..origin/main") !== "0") fail("main is behind origin; pull first");
if (sh(`git tag --list v${next}`)) fail(`tag v${next} already exists`);

// package.json and its lock.
pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
const lockPath = resolve(root, "package-lock.json");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
lock.version = next;
if (lock.packages && lock.packages[""]) lock.packages[""].version = next;
writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");

// tauri.conf.json.
const confPath = resolve(root, "src-tauri/tauri.conf.json");
const conf = JSON.parse(readFileSync(confPath, "utf8"));
conf.version = next;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");

// Cargo.toml: the first `version = "..."` is the package's.
const cargoPath = resolve(root, "src-tauri/Cargo.toml");
const cargo = readFileSync(cargoPath, "utf8");
const bumped = cargo.replace(/^version = "[^"]+"/m, `version = "${next}"`);
if (bumped === cargo) fail("could not find the version line in src-tauri/Cargo.toml");
writeFileSync(cargoPath, bumped);
// Refresh Cargo.lock's entry for the app without touching dependencies.
sh("cargo metadata --format-version 1", { cwd: resolve(root, "src-tauri"), stdio: ["ignore", "ignore", "inherit"] });

sh("git add package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock");
sh(`git commit -q -m "Release v${next}"`);
sh(`git tag -a v${next} -m "QACut v${next}"`);
sh("git push origin main --follow-tags", { stdio: "inherit" });

console.log(`\nv${next} tagged and pushed. Watch the build: gh run watch --repo mcinnisdev/qacut`);
console.log(`Release page: https://github.com/mcinnisdev/qacut/releases/tag/v${next}`);

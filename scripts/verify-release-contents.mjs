import { execFileSync } from "node:child_process";

const allowedPaths = new Set([
  ".env.example",
  ".gitignore",
  ".npmignore",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "package-lock.json",
  "package.json",
  "ratevert-client.mjs",
  "server.mjs",
  "server.test.mjs",
  "smoke-test.mjs",
  "scripts/verify-release-contents.mjs",
]);

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .map((file) => file.trim())
  .filter(Boolean);
const unexpected = files.filter((file) => !allowedPaths.has(file));
const missing = [...allowedPaths].filter((file) => !files.includes(file));

if (unexpected.length || missing.length) {
  console.error(JSON.stringify({ missing, unexpected }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ files: files.length, status: "release_allowlist_ok" }));

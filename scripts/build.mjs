/**
 * Production build: runs the three Vite builds (background, content,
 * sidebar) sequentially, then copies static files (manifest, icons).
 */
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd) => execSync(cmd, { cwd: ROOT, stdio: "inherit" });

run("npx vite build --config vite.background.config.ts");
run("npx vite build --config vite.content.config.ts");
run("npx vite build --config vite.sidebar.config.ts");

// Copy static assets (manifest.json, icons) into dist/.
const SRC = join(ROOT, "static");
const DEST = join(ROOT, "dist");
mkdirSync(DEST, { recursive: true });
for (const entry of readdirSync(SRC)) {
  cpSync(join(SRC, entry), join(DEST, entry), { recursive: true });
  console.log(`copied static/${entry} -> dist/${entry}`);
}
console.log("Build complete: dist/");

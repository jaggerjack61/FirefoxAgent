import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(root, "source-artifacts");
rmSync(destination, { force: true, recursive: true });
mkdirSync(destination, { recursive: true });
execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--pack-destination", destination], {
  cwd: root,
  stdio: "inherit",
});

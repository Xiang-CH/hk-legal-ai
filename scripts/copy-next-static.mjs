// Copies the built `_next/static` assets (JS, CSS, fonts) under the app's
// mount path after `next build`. `assetPrefix` (next.config.ts) makes the HTML
// request <APP_BASE_PATH>/_next/static/...; because Azure SWA serves `_next`
// from the root of its static host, those prefixed requests 404 unless the
// files also exist at the prefixed path. This makes it work on any host (the
// SWA default hostname and the shared custom domain) with no edge rewrite.
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();

const routesSource = readFileSync(resolve(root, "src/lib/routes.ts"), "utf8");
const match = routesSource.match(/APP_BASE_PATH\s*=\s*["']([^"']+)["']/);
if (!match) {
  console.error("[copy-next-static] APP_BASE_PATH not found in src/lib/routes.ts");
  process.exit(1);
}
const basePath = match[1];

const from = resolve(root, ".next/static");
const to = resolve(root, `public${basePath}/_next/static`);

if (!existsSync(from)) {
  console.error(`[copy-next-static] ${from} does not exist; run "next build" first.`);
  process.exit(1);
}

rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });

console.log(`[copy-next-static] copied .next/static -> public${basePath}/_next/static`);

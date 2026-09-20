/* Build gate: colours live in the token sheet, never in TS/TSX. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../src/", import.meta.url));
const ALLOW = new Set(["lib/tokens.ts"]);
const RE = /#[0-9a-fA-F]{3,8}\b|\brgba?\(/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const hits = [];
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  if (ALLOW.has(rel)) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    // "#root"-like ids are not colours: need exactly 3/6/8 hex digits
    for (const m of line.matchAll(RE)) {
      const t = m[0];
      if (t.startsWith("#") && ![4, 7, 9].includes(t.length)) continue;
      hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
    }
  });
}
if (hits.length) {
  console.error(`no-literal-colors: ${hits.length} literal colour(s) outside lib/tokens.ts\n` + hits.join("\n"));
  process.exit(1);
}

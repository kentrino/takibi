import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
function importGraph(file, seen = new Map()) {
  const path = resolve(file);
  if (seen.has(path)) return seen;
  const source = readFileSync(path, "utf8");
  seen.set(path, source);
  // vp pack emits static relative .mjs imports for shared chunks.
  for (const match of source.matchAll(/(?:from\s*|import\s*)["'](\.\/[^"']+\.mjs)["']/g)) {
    importGraph(resolve(dirname(path), match[1]), seen);
  }
  return seen;
}
const http = importGraph(resolve(dist, "client.mjs"));
assert(
  ![...http.values()].some((source) => /\bWebSocket\b|webSocketProtocols/.test(source)),
  "takibi/client must not include the WebSocket runtime",
);
const watch = importGraph(resolve(dist, "watch.mjs"));
assert([...watch.values()].some((source) => /new WebSocket\(/.test(source)));
assert(
  ![...watch.values()].some((source) => /cloudflare:workers|node:/.test(source)),
  "takibi/watch must stay browser-only",
);
console.log(
  `Client entry graphs verified: HTTP ${http.size} modules, watch ${watch.size} modules.`,
);

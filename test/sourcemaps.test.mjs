import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findMaps, servedPath, upload } from "../packages/sourcemaps/dist/index.js";

function build() {
  const dir = mkdtempSync(join(tmpdir(), "tracex-maps-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
  writeFileSync(join(dir, "assets", "index-4f9a.js"), "console.log(1)");
  writeFileSync(join(dir, "assets", "index-4f9a.js.map"), '{"version":3,"sources":["a.ts"],"mappings":"AAAA"}');
  writeFileSync(join(dir, "assets", "vendor-77aa.js.map"), '{"version":3,"sources":["b.ts"],"mappings":"AAAA"}');
  writeFileSync(join(dir, "node_modules", "x", "skip.js.map"), "{}");
  return dir;
}

async function server(handler) {
  const calls = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ url: req.url, auth: req.headers.authorization, body });
      const [status, reply] = handler(req);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { api: `http://127.0.0.1:${srv.address().port}`, calls, close: () => srv.close() };
}

test("finds maps (not node_modules) and the paths they're served at", () => {
  const dir = build();
  assert.deepEqual(findMaps(dir), ["assets/index-4f9a.js.map", "assets/vendor-77aa.js.map"]);
  assert.equal(servedPath("chunks/app-1.js.map", "_next/static"), "_next/static/chunks/app-1.js");
  assert.equal(servedPath("chunks/app-1.js.map", "~/static/"), "static/chunks/app-1.js");
});

test("uploads each map with the token and release, then deletes them", async () => {
  const dir = build();
  const s = await server(() => [201, { ok: true }]);
  try {
    const lines = [];
    const result = await upload({ dir, release: "web@1.4.0", token: "txs_abc", api: s.api, deleteAfter: true, log: (l) => lines.push(l) });
    assert.equal(result.uploaded.length, 2);
    assert.equal(result.failed.length, 0);
    const urls = s.calls.map((c) => decodeURIComponent(c.url)).sort();
    assert.deepEqual(urls, [
      "/v1/errors/sourcemaps?release=web@1.4.0&file=assets/index-4f9a.js",
      "/v1/errors/sourcemaps?release=web@1.4.0&file=assets/vendor-77aa.js",
    ]);
    assert.ok(s.calls.every((c) => c.auth === "Bearer txs_abc"));
    assert.ok(!existsSync(join(dir, "assets", "index-4f9a.js.map")));
    assert.ok(existsSync(join(dir, "assets", "index-4f9a.js")));
  } finally {
    s.close();
  }
});

test("a bad token stops at once and keeps the maps", async () => {
  const dir = build();
  const s = await server(() => [401, { error: "unknown_token", detail: "The upload token isn't valid or was revoked." }]);
  try {
    const result = await upload({ dir, release: "1", token: "txs_bad", api: s.api, deleteAfter: true, concurrency: 1 });
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].reason, /upload token/);
    assert.equal(s.calls.length, 1);
    assert.ok(existsSync(join(dir, "assets", "index-4f9a.js.map")));
  } finally {
    s.close();
  }
});

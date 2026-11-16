import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addImport, addToBody, detect, makePlan } from "../packages/wizard/dist/index.js";
import { applyChanges, parseArgs, sendTest } from "../packages/wizard/dist/index.js";

const KEY = "txp_pub_AbCdEf0123456789XyZ0";

function app(files) {
  const dir = mkdtempSync(join(tmpdir(), "tracex-wizard-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), typeof content === "string" ? content : JSON.stringify(content));
  }
  return dir;
}

const LAYOUT = `import "./globals.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
`;

test("Next.js App Router: every file, the layout edited, nothing overwritten", () => {
  const dir = app({
    "package.json": { dependencies: { next: "16.3.1", react: "19.0.0" }, devDependencies: { typescript: "5" } },
    "pnpm-lock.yaml": "",
    "app/layout.tsx": LAYOUT,
    "app/error.tsx": "// mine\n",
  });
  const project = detect(dir);
  assert.equal(project.framework, "nextjs-app");
  assert.equal(project.packageManager, "pnpm");
  const plan = makePlan(project, KEY);
  assert.deepEqual(plan.packages, ["@tracexpro/browser", "@tracexpro/node"]);
  const manual = applyChanges(dir, plan.changes);

  const lib = readFileSync(join(dir, "lib/tracex.ts"), "utf8");
  assert.match(lib, /process\.env\.NEXT_PUBLIC_TRACEX_KEY \?\? "txp_pub_AbCdEf0123456789XyZ0"/);
  assert.match(lib, /typeof window === "undefined"/);
  const init = readFileSync(join(dir, "app/tracex-init.tsx"), "utf8");
  assert.match(init, /^"use client";/);
  assert.match(init, /from "\.\.\/lib\/tracex"/);
  const layout = readFileSync(join(dir, "app/layout.tsx"), "utf8");
  assert.match(layout, /import "\.\/globals\.css";\nimport \{ TraceXInit \} from "\.\/tracex-init";/);
  assert.match(layout, /<body className="antialiased">\n        <TraceXInit \/>/);
  // Next 16.3: the retry prop is `retry`; global-error renders html and body
  const global = readFileSync(join(dir, "app/global-error.tsx"), "utf8");
  assert.match(global, /\{ error, retry \}/);
  assert.match(global, /<html lang="en">/);
  assert.match(readFileSync(join(dir, "instrumentation.ts"), "utf8"), /onRequestError: Instrumentation\.onRequestError/);
  // error.tsx existed: left alone, shown as a manual step
  assert.equal(readFileSync(join(dir, "app/error.tsx"), "utf8"), "// mine\n");
  assert.ok(manual.some((m) => m.title.startsWith("app/error.tsx already exists")));

  // Running again changes nothing
  const again = applyChanges(dir, makePlan(detect(dir), KEY).changes);
  assert.equal(readFileSync(join(dir, "app/layout.tsx"), "utf8"), layout);
  assert.ok(again.length >= 4);
});

test("Next.js retry prop follows the installed version", () => {
  for (const [version, prop] of [["15.2.0", "reset"], ["16.2.1", "unstable_retry"], ["^16.3.0", "retry"]]) {
    const dir = app({ "package.json": { dependencies: { next: version } }, "src/app/layout.jsx": LAYOUT });
    const project = detect(dir);
    assert.equal(project.appDir, "src/app");
    const global = makePlan(project, KEY).changes.find((c) => c.path === "src/app/global-error.jsx");
    assert.match(global.content, new RegExp(`\\{ error, ${prop} \\}`), version);
    assert.ok(makePlan(project, KEY).changes.some((c) => c.path === "src/instrumentation.js"));
  }
});

test("Vite + React: tracex.ts and an import at the top of main.tsx", () => {
  const dir = app({
    "package.json": { dependencies: { react: "19", "react-dom": "19" }, devDependencies: { vite: "6", typescript: "5" } },
    "src/main.tsx": `import { createRoot } from "react-dom/client";\ncreateRoot(document.getElementById("root")!).render(<App />);\n`,
  });
  const project = detect(dir);
  assert.equal(project.framework, "vite-react");
  const manual = applyChanges(dir, makePlan(project, KEY).changes);
  assert.match(readFileSync(join(dir, "src/main.tsx"), "utf8"), /^import "\.\/tracex";\n/);
  assert.match(readFileSync(join(dir, "src/tracex.ts"), "utf8"), /enabled: import\.meta\.env\.PROD/);
  assert.ok(manual.some((m) => /error boundaries/.test(m.title)));
});

test("Express: a tracex.cjs to load first, and the error handler as steps", () => {
  const dir = app({ "package.json": { type: "module", dependencies: { express: "5" } } });
  const project = detect(dir);
  assert.equal(project.framework, "express");
  const manual = applyChanges(dir, makePlan(project, KEY).changes);
  assert.ok(existsSync(join(dir, "tracex.cjs")));
  assert.ok(manual.some((m) => m.code === 'import "./tracex.cjs";'));
  assert.ok(manual.some((m) => /expressErrorHandler/.test(m.code)));
});

test("other frameworks are detected", () => {
  const cases = [
    [{ "@sveltejs/kit": "2" }, "sveltekit"],
    [{ "@angular/core": "19" }, "angular"],
    [{ "@react-router/dev": "7", react: "19" }, "react-router"],
    [{ vue: "3", vite: "6" }, "vue"],
    [{}, "node"],
  ];
  for (const [deps, framework] of cases) {
    assert.equal(detect(app({ "package.json": { dependencies: deps } })).framework, framework);
  }
  assert.equal(detect(app({})), null);
});

test("layout edits: imports after the last import, no <body> means a manual step", () => {
  assert.equal(addImport('"use client";\nimport a from "a";\nconst x = 1;', 'import b from "b";'), '"use client";\nimport a from "a";\nimport b from "b";\nconst x = 1;');
  assert.equal(addToBody("<div>{children}</div>", "<TraceXInit />"), null);
});

test("arguments", () => {
  const args = parseArgs(["--key", KEY, "-y", "--skip-install", "--no-test", "--framework", "vue"]);
  assert.equal(args.key, KEY);
  assert.equal(args.yes && !args.install && !args.test, true);
  assert.equal(args.framework, "vue");
});

test("test event: accepted, or the reason", async () => {
  const replies = [
    new Response(JSON.stringify({ accepted: 1 }), { status: 202 }),
    new Response(JSON.stringify({ error: "unknown_key" }), { status: 401 }),
  ];
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return replies.shift();
  };
  const ok = await sendTest("https://ingest.example/api/events", KEY, "vue");
  assert.equal(ok.ok, true);
  assert.equal(sent.url, `https://ingest.example/api/events?key=${KEY}`);
  assert.equal(sent.body.events[0].tags.source, "wizard");
  const bad = await sendTest("https://ingest.example/api/events", KEY, "vue");
  assert.equal(bad.message, "the key isn't valid or was revoked");
});

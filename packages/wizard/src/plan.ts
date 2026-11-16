import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { firstExisting, type Project } from "./detect";

/** One thing the wizard does. Nothing is overwritten: an existing file becomes a manual step. */
export type Change =
  | { kind: "create"; path: string; content: string; why: string }
  | { kind: "edit"; path: string; why: string; apply: (source: string) => string | null }
  | { kind: "manual"; title: string; code?: string; path?: string };

export interface Plan {
  packages: string[];
  changes: Change[];
  /** Shown at the end: what to do next */
  notes: string[];
}

const DOCS = "https://docs.tracexpro.com/errors";

function nextRetryProp(project: Project): string {
  // Next.js renamed the error boundary's retry function: reset → unstable_retry (16.2) → retry (16.3)
  let version = "";
  const installed = join(project.dir, "node_modules", "next", "package.json");
  try {
    version = JSON.parse(readFileSync(installed, "utf8")).version;
  } catch {
    const pkg = JSON.parse(readFileSync(join(project.dir, "package.json"), "utf8"));
    version = String({ ...pkg.devDependencies, ...pkg.dependencies }.next || "").replace(/^[^\d]*/, "");
  }
  const [major, minor] = version.split(".").map((n) => Number(n) || 0);
  if (major > 16 || (major === 16 && minor >= 3)) return "retry";
  if (major === 16 && minor === 2) return "unstable_retry";
  return "reset";
}

/** An import path from one file to another, without the extension. */
function importPath(fromFile: string, toFile: string): string {
  let rel = relative(dirname(fromFile), toFile).replace(/\\/g, "/").replace(/\.(t|j)sx?$/, "");
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}

/** Insert an import after the file's last import (or at the top). */
export function addImport(source: string, line: string): string {
  if (source.includes(line)) return source;
  const lines = source.split("\n");
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*import\s/.test(lines[i]) || /^\s*["']use (client|server)["'];?\s*$/.test(lines[i])) last = i;
    // multi-line imports end with `from "…";`
    if (last >= 0 && i > last && /^\s*}\s*from\s/.test(lines[i])) last = i;
  }
  lines.splice(last + 1, 0, line);
  return lines.join("\n");
}

/** Put `<TraceXInit />` right after `<body …>` in a root layout; null if there's no <body>. */
export function addToBody(source: string, element: string): string | null {
  if (source.includes(element)) return source;
  const match = /<body[^>]*>/.exec(source);
  if (!match) return null;
  const at = match.index + match[0].length;
  const indent = (/\n([ \t]*)[^\n]*$/.exec(source.slice(0, match.index))?.[1] ?? "") + "  ";
  const rest = source.slice(at);
  // Keep what followed <body> on its own line
  const after = rest.startsWith("\n") ? rest : "\n" + indent + rest;
  return source.slice(0, at) + "\n" + indent + element + after;
}

function create(project: Project, path: string, content: string, why: string, changes: Change[]) {
  if (existsSync(join(project.dir, path))) {
    changes.push({ kind: "manual", title: `${path} already exists: add TraceX to it yourself`, code: content, path });
  } else {
    changes.push({ kind: "create", path, content, why });
  }
}

export function makePlan(project: Project, key: string): Plan {
  const ts = project.typescript;
  const changes: Change[] = [];
  const notes: string[] = [];
  const keyEnv = (name: string) => `${name} ?? "${key}"`;

  switch (project.framework) {
    case "nextjs-app": {
      const app = project.appDir; // "app" or "src/app"
      const root = app.startsWith("src/") ? "src" : "";
      const lib = join(root, "lib", `tracex.${ts ? "ts" : "js"}`);
      const x = ts ? "tsx" : "jsx";
      const init = join(app, `tracex-init.${x}`);
      const retry = nextRetryProp(project);
      const errType = ts
        ? `: {\n  error: Error & { digest?: string };\n  ${retry}: () => void;\n}`
        : "";
      create(project, lib, `import * as TraceX from "@tracexpro/browser";

/** Start TraceX once, in the browser only (it does nothing on the server). */
export function startTraceX() {
  if (typeof window === "undefined" || TraceX.isInitialized()) return;
  TraceX.init({
    // The key is public: it can only send errors to TraceX
    key: ${keyEnv("process.env.NEXT_PUBLIC_TRACEX_KEY")},
    release: process.env.NEXT_PUBLIC_APP_VERSION,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
    enabled: process.env.NODE_ENV === "production",
    debug: process.env.NEXT_PUBLIC_TRACEX_DEBUG === "1",
  });
}

export { TraceX };
`, "starts TraceX in the browser", changes);
      create(project, init, `"use client";

import { startTraceX } from "${importPath(init, lib)}";

// Runs as soon as this module loads in the browser, before your pages render
startTraceX();

export function TraceXInit() {
  return null;
}
`, "a client component that loads it", changes);
      const layout = firstExisting(project.dir, ["tsx", "jsx", "js", "ts"].map((e) => join(app, `layout.${e}`)));
      if (layout) {
        changes.push({
          kind: "edit",
          path: layout,
          why: "renders <TraceXInit />",
          apply: (source) => {
            const withTag = addToBody(source, "<TraceXInit />");
            return withTag === null ? null : addImport(withTag, `import { TraceXInit } from "./tracex-init";`);
          },
        });
      } else {
        changes.push({ kind: "manual", title: `Render <TraceXInit /> inside <body> in your root layout`, code: `import { TraceXInit } from "./tracex-init";` });
      }
      const boundary = (name: string, extra: string, wrapStart: string, wrapEnd: string) => `"use client";

import { useEffect } from "react";
import { TraceX, startTraceX } from "${importPath(join(app, "x.tsx"), lib)}";

export default function ${name}({ error, ${retry} }${errType}) {
  useEffect(() => {
    startTraceX();
    TraceX.captureException(error, {${extra}
      tags: { mechanism: "next.${name === "Error" ? "error" : "global-error"}", ...(error.digest ? { digest: error.digest } : {}) },
    });
  }, [error]);

  return (
${wrapStart}      <h2>Something went wrong.</h2>
      <button onClick={() => ${retry}()}>Try again</button>
${wrapEnd}  );
}
`;
      create(project, join(app, `error.${x}`), boundary("Error", "", "    <div>\n", "    </div>\n"), "reports page crashes", changes);
      create(
        project,
        join(app, `global-error.${x}`),
        boundary("GlobalError", `\n      level: "fatal",`, `    <html lang="en">\n      <body>\n`, `      </body>\n    </html>\n`).replace(
          /      <h2>|      <button/g,
          (m) => "  " + m,
        ),
        "reports crashes in the root layout",
        changes,
      );
      create(project, join(root, `instrumentation.${ts ? "ts" : "js"}`), `${ts ? 'import type { Instrumentation } from "next";\n\n' : ""}export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const TraceX = await import("@tracexpro/node");
    TraceX.init({
      key: ${keyEnv("process.env.TRACEX_KEY")},
      release: process.env.NEXT_PUBLIC_APP_VERSION,
      enabled: process.env.NODE_ENV === "production",
      // Next.js handles crashes itself; let it
      captureUncaught: false,
    });
  }
}

export ${ts ? "const onRequestError: Instrumentation.onRequestError = async (error, request, context) =>" : "async function onRequestError(error, request, context)"} {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const TraceX = await import("@tracexpro/node");
  const digest =
    typeof error === "object" && error !== null && "digest" in error
      ? String(${ts ? "(error as { digest: unknown })" : "error"}.digest)
      : undefined;
  TraceX.captureException(error, {
    tags: { mechanism: "next.onRequestError", route_type: context.routeType, ...(digest ? { digest } : {}) },
    request: { method: request.method, url: request.path, route: context.routePath },
  });
  await TraceX.flush();
}${ts ? ";" : ""}
`, "reports server errors", changes);
      notes.push(
        `Set the release at build time: NEXT_PUBLIC_APP_VERSION (the commit or package.json version). See ${DOCS}/nextjs/#5-set-the-release`,
        "TraceX sends nothing from `next dev`. To try it: NEXT_PUBLIC_TRACEX_DEBUG=1 npm run build && npm start",
      );
      return { packages: ["@tracexpro/browser", "@tracexpro/node"], changes, notes };
    }

    case "nextjs-pages": {
      const lib = join(project.appDir.startsWith("src/") ? "src" : "", "lib", `tracex.${ts ? "ts" : "js"}`);
      create(project, lib, `import * as TraceX from "@tracexpro/browser";

if (typeof window !== "undefined" && !TraceX.isInitialized()) {
  TraceX.init({
    key: ${keyEnv("process.env.NEXT_PUBLIC_TRACEX_KEY")},
    release: process.env.NEXT_PUBLIC_APP_VERSION,
    enabled: process.env.NODE_ENV === "production",
  });
}

export { TraceX };
`, "starts TraceX in the browser", changes);
      const appFile = firstExisting(project.dir, ["tsx", "jsx", "js", "ts"].map((e) => join(project.appDir, `_app.${e}`)));
      if (appFile) {
        changes.push({
          kind: "edit",
          path: appFile,
          why: "loads it on every page",
          apply: (source) => addImport(source, `import "${importPath(appFile, lib)}";`),
        });
      } else {
        changes.push({ kind: "manual", title: `Import ${lib} from pages/_app` });
      }
      notes.push(`Report crashes from your error boundary with TraceX.captureException. See ${DOCS}/javascript/#react-error-boundaries`);
      return { packages: ["@tracexpro/browser"], changes, notes };
    }

    case "vite-react":
    case "browser": {
      const src = project.appDir || "";
      const file = join(src, `tracex.${ts ? "ts" : "js"}`);
      const vite = project.deps.has("vite");
      create(project, file, `import * as TraceX from "@tracexpro/browser";

TraceX.init({
  // The key is public: it can only send errors to TraceX
  key: ${vite ? keyEnv("import.meta.env.VITE_TRACEX_KEY") : `"${key}"`},
  release: ${vite ? "import.meta.env.VITE_APP_VERSION" : "undefined /* your app's version */"},
  ${vite ? "environment: import.meta.env.MODE,\n  enabled: import.meta.env.PROD," : ""}
});

export { TraceX };
`.replace(/\n  \n/, "\n"), "starts TraceX", changes);
      const entry = firstExisting(project.dir, ["main.tsx", "main.jsx", "main.ts", "main.js", "index.tsx", "index.jsx", "index.js"].map((f) => join(src, f)));
      if (entry) {
        changes.push({
          kind: "edit",
          path: entry,
          why: "starts it before your app",
          apply: (source) => {
            const line = `import "${importPath(entry, file)}";`;
            return source.includes(line) ? source : line + "\n" + source;
          },
        });
      } else {
        changes.push({ kind: "manual", title: `Import ${file} first thing in your app's entry file` });
      }
      if (project.deps.has("react")) {
        changes.push({
          kind: "manual",
          title: "Report what React's error boundaries catch",
          code: `// React 19, in createRoot:
createRoot(el, {
  onCaughtError: (error, info) => TraceX.reactErrorHandler(error, info),
  onUncaughtError: (error, info) => TraceX.reactErrorHandler(error, info),
});
// React 18: <ErrorBoundary onError={TraceX.reactErrorHandler}>`,
        });
      }
      return { packages: ["@tracexpro/browser"], changes, notes };
    }

    case "vue": {
      const file = join(project.appDir || "", `tracex.${ts ? "ts" : "js"}`);
      create(project, file, `import * as TraceX from "@tracexpro/browser";
${ts ? 'import type { App } from "vue";\n' : ""}
TraceX.init({
  key: ${keyEnv("import.meta.env.VITE_TRACEX_KEY")},
  release: import.meta.env.VITE_APP_VERSION,
  enabled: import.meta.env.PROD,
});

/** Vue catches component errors itself: hand them to TraceX. */
export function installTraceX(app${ts ? ": App" : ""}) {
  app.config.errorHandler = (error, _instance, info) => {
    TraceX.captureException(error, { tags: { mechanism: "vue", vue_info: String(info) } });
    console.error(error);
  };
}
`, "starts TraceX and hooks Vue's error handler", changes);
      changes.push({
        kind: "manual",
        title: "In your main file, before app.mount()",
        code: `import { installTraceX } from "./tracex";\n\ninstallTraceX(app);`,
      });
      return { packages: ["@tracexpro/browser"], changes, notes };
    }

    case "sveltekit": {
      create(project, `src/hooks.client.${ts ? "ts" : "js"}`, `import * as TraceX from "@tracexpro/browser";
import { dev } from "$app/environment";
${ts ? 'import type { HandleClientError } from "@sveltejs/kit";\n' : ""}
TraceX.init({ key: "${key}", enabled: !dev });

export const handleError${ts ? ": HandleClientError" : ""} = ({ error, status, message }) => {
  if (status !== 404) {
    TraceX.captureException(error, { tags: { mechanism: "sveltekit", status: String(status) } });
  }
  return { message };
};
`, "reports errors in the browser", changes);
      return { packages: ["@tracexpro/browser"], changes, notes };
    }

    case "angular": {
      create(project, "src/app/tracex-error-handler.ts", `import { ErrorHandler, Injectable } from "@angular/core";
import * as TraceX from "@tracexpro/browser";

TraceX.init({ key: "${key}" });

@Injectable()
export class TraceXErrorHandler implements ErrorHandler {
  handleError(error: unknown): void {
    TraceX.captureException(error, { tags: { mechanism: "angular" } });
    console.error(error);
  }
}
`, "starts TraceX and reports Angular's errors", changes);
      changes.push({
        kind: "manual",
        title: "Provide it in src/main.ts (bootstrapApplication) or your app config",
        code: `import { ErrorHandler } from "@angular/core";
import { TraceXErrorHandler } from "./app/tracex-error-handler";

providers: [{ provide: ErrorHandler, useClass: TraceXErrorHandler }]`,
      });
      return { packages: ["@tracexpro/browser"], changes, notes };
    }

    case "react-router": {
      changes.push({
        kind: "manual",
        title: "In app/root.tsx: start TraceX and report the route ErrorBoundary",
        code: `import * as TraceX from "@tracexpro/browser";
import { useEffect } from "react";
import { isRouteErrorResponse } from "react-router";

if (typeof window !== "undefined" && !TraceX.isInitialized()) {
  TraceX.init({ key: "${key}", enabled: import.meta.env.PROD });
}

export function ErrorBoundary({ error }: { error: unknown }) {
  useEffect(() => {
    if (!isRouteErrorResponse(error)) TraceX.captureException(error);
  }, [error]);
  return <h1>Something went wrong.</h1>;
}`,
      });
      return { packages: ["@tracexpro/browser"], changes, notes };
    }

    case "express":
    case "node": {
      const file = `${project.appDir ? project.appDir + "/" : ""}tracex.${ts ? "ts" : "cjs"}`;
      const content = ts
        ? `import * as TraceX from "@tracexpro/node";

TraceX.init({
  key: ${keyEnv("process.env.TRACEX_KEY")},
  release: process.env.GIT_SHA,
});

export { TraceX };
`
        : `const TraceX = require("@tracexpro/node");

TraceX.init({
  key: ${keyEnv("process.env.TRACEX_KEY")},
  release: process.env.GIT_SHA,
});

module.exports = TraceX;
`;
      create(project, file, content, "starts TraceX", changes);
      changes.push({
        kind: "manual",
        title: "Load it first, at the very top of your server's entry file",
        code: ts ? `import "./tracex";` : project.esm ? `import "./tracex.cjs";` : `require("./tracex.cjs");`,
      });
      if (project.framework === "express") {
        changes.push({
          kind: "manual",
          title: "After your routes, before your own error handler",
          code: `app.use(TraceX.expressErrorHandler());`,
        });
      }
      return { packages: ["@tracexpro/node"], changes, notes };
    }
  }
}

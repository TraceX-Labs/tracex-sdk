import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Framework =
  | "nextjs-app"
  | "nextjs-pages"
  | "vite-react"
  | "vue"
  | "sveltekit"
  | "angular"
  | "react-router"
  | "express"
  | "node"
  | "browser";

export const FRAMEWORK_NAMES: Record<Framework, string> = {
  "nextjs-app": "Next.js (App Router)",
  "nextjs-pages": "Next.js (Pages Router)",
  "vite-react": "Vite + React",
  vue: "Vue",
  sveltekit: "SvelteKit",
  angular: "Angular",
  "react-router": "React Router / Remix",
  express: "Express",
  node: "Node.js",
  browser: "JavaScript (browser)",
};

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface Project {
  dir: string;
  framework: Framework;
  packageManager: PackageManager;
  typescript: boolean;
  /** "src/app" or "app" for Next.js; "src" or "" otherwise */
  appDir: string;
  /** Installed dependencies (names) */
  deps: Set<string>;
  /** package.json "type": "module" */
  esm: boolean;
}

export function readPackage(dir: string): Record<string, any> | null {
  const file = join(dir, "package.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function detect(dir: string): Project | null {
  const pkg = readPackage(dir);
  if (!pkg) return null;
  const deps = new Set<string>([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ]);
  const has = (name: string) => deps.has(name);
  const exists = (p: string) => existsSync(join(dir, p));
  const typescript = has("typescript") || exists("tsconfig.json");

  let framework: Framework;
  let appDir = exists("src") ? "src" : "";
  if (has("next")) {
    if (exists("src/app")) {
      framework = "nextjs-app";
      appDir = "src/app";
    } else if (exists("app")) {
      framework = "nextjs-app";
      appDir = "app";
    } else {
      framework = "nextjs-pages";
      appDir = exists("src/pages") ? "src/pages" : "pages";
    }
  } else if (has("@sveltejs/kit")) framework = "sveltekit";
  else if (has("@angular/core")) framework = "angular";
  else if (has("@react-router/dev") || has("@remix-run/react")) framework = "react-router";
  else if (has("vue")) framework = "vue";
  else if (has("vite") && (has("react") || has("react-dom"))) framework = "vite-react";
  else if (has("express")) framework = "express";
  else if (has("react") || has("react-dom") || has("vite")) framework = "browser";
  else framework = "node";

  const packageManager: PackageManager = exists("pnpm-lock.yaml")
    ? "pnpm"
    : exists("yarn.lock")
      ? "yarn"
      : exists("bun.lockb") || exists("bun.lock")
        ? "bun"
        : "npm";
  return { dir, framework, packageManager, typescript, appDir, deps, esm: pkg.type === "module" };
}

export function installCommand(pm: PackageManager, packages: string[]): string[] {
  switch (pm) {
    case "pnpm":
      return ["pnpm", "add", ...packages];
    case "yarn":
      return ["yarn", "add", ...packages];
    case "bun":
      return ["bun", "add", ...packages];
    default:
      return ["npm", "install", ...packages];
  }
}

/** The first file that exists, relative to the project. */
export function firstExisting(dir: string, candidates: string[]): string | null {
  return candidates.find((c) => existsSync(join(dir, c))) ?? null;
}

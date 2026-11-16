/**
 * npx @tracexpro/sourcemaps upload ./dist --release 1.4.0
 *
 * Uploads a build's .map files to TraceX, so errors from that release show your
 * original files, lines and functions. Run it in CI after the build, with the same
 * release as `release` in TraceX.init and an upload token (TraceX → Issues →
 * Alerts and SDK → Source maps) in TRACEX_UPLOAD_TOKEN.
 */
import { readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export const VERSION = "0.1.0";
const DEFAULT_API = "https://api.tracexpro.com";

export interface UploadOptions {
  dir: string;
  release: string;
  token: string;
  api?: string;
  /** Put before each file's path, e.g. "_next/static" when uploading .next/static */
  urlPrefix?: string;
  /** Remove the .map files after uploading them (so they aren't deployed publicly) */
  deleteAfter?: boolean;
  dryRun?: boolean;
  concurrency?: number;
  log?: (line: string) => void;
}

export interface UploadResult {
  uploaded: string[];
  failed: { file: string; reason: string }[];
}

/** Every .map under dir (node_modules skipped), relative paths with forward slashes. */
export function findMaps(dir: string): string[] {
  const out: string[] = [];
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".git")) continue;
      const full = join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".map")) out.push(relative(dir, full).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/** The path the minified file is served at, as TraceX matches it against stack traces. */
export function servedPath(mapPath: string, urlPrefix = ""): string {
  const file = mapPath.replace(/\.map$/, "");
  const prefix = urlPrefix.replace(/^[~./]+/, "").replace(/\/+$/, "");
  return prefix ? `${prefix}/${file}` : file;
}

export async function upload(options: UploadOptions): Promise<UploadResult> {
  const log = options.log ?? (() => {});
  const api = (options.api || DEFAULT_API).replace(/\/+$/, "");
  const dir = resolve(options.dir);
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${options.dir} isn't a folder.`);
  const maps = findMaps(dir);
  const result: UploadResult = { uploaded: [], failed: [] };
  if (!maps.length) {
    log(`No .map files in ${options.dir}. Turn on source maps in your build (see the docs).`);
    return result;
  }
  log(`${maps.length} source map(s) for release ${options.release}${options.dryRun ? " (dry run)" : ""}`);
  let next = 0;
  const work = async () => {
    while (next < maps.length) {
      const mapPath = maps[next++];
      const file = servedPath(mapPath, options.urlPrefix);
      if (options.dryRun) {
        log(`  would upload ${mapPath} → ${file}`);
        result.uploaded.push(mapPath);
        continue;
      }
      try {
        const body = readFileSync(join(dir, mapPath));
        const url = `${api}/v1/errors/sourcemaps?release=${encodeURIComponent(options.release)}&file=${encodeURIComponent(file)}`;
        const response = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
          body,
        });
        const reply = (await response.json().catch(() => ({}))) as { detail?: string; error?: string };
        if (!response.ok) throw new Error(reply.detail || reply.error || `HTTP ${response.status}`);
        result.uploaded.push(mapPath);
        log(`  ✓ ${file}`);
        if (options.deleteAfter) unlinkSync(join(dir, mapPath));
      } catch (error) {
        const reason = (error as Error).message;
        result.failed.push({ file: mapPath, reason });
        log(`  ✗ ${mapPath}: ${reason}`);
        // A bad token fails every file the same way: stop at once
        if (/upload token/i.test(reason)) next = maps.length;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 4) }, work));
  return result;
}

const HELP = `
npx @tracexpro/sourcemaps upload <build folder> --release <release>

Uploads the build's .map files so TraceX shows your original code in stack traces.

Options
  --release <r>       The same value as \`release\` in TraceX.init (or TRACEX_RELEASE)
  --token <t>         Upload token, txs_… (or TRACEX_UPLOAD_TOKEN; prefer the variable in CI)
  --url-prefix <p>    Path the folder is served under, e.g. _next/static for .next/static
  --delete-after      Remove the .map files after uploading, so they aren't deployed
  --dry-run           List what would be uploaded
  --api <url>         TraceX API (default ${DEFAULT_API})

Examples
  npx @tracexpro/sourcemaps upload ./dist --release $GIT_SHA --delete-after
  npx @tracexpro/sourcemaps upload .next/static --url-prefix _next/static --release $GIT_SHA --delete-after
`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help" || command !== "upload") {
    console.log(HELP);
    return command && command !== "-h" && command !== "--help" ? 1 : 0;
  }
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const [name, inline] = a.slice(2).split("=", 2);
      if (["delete-after", "dry-run"].includes(name)) flags[name] = true;
      else flags[name] = inline ?? rest[++i] ?? "";
    } else positional.push(a);
  }
  const dir = positional[0];
  const release = String(flags.release || process.env.TRACEX_RELEASE || "");
  const token = String(flags.token || process.env.TRACEX_UPLOAD_TOKEN || "");
  if (!dir) return fail("Give the build folder: npx @tracexpro/sourcemaps upload ./dist --release …");
  if (!release) return fail("Give --release (the same value as `release` in TraceX.init), or set TRACEX_RELEASE.");
  if (!flags["dry-run"] && !token.startsWith("txs_")) {
    return fail(
      "Set TRACEX_UPLOAD_TOKEN to an upload token (txs_…): TraceX → Issues → Alerts and SDK → Source maps. " +
        "The public txp_pub_ key can't upload.",
    );
  }
  try {
    const result = await upload({
      dir,
      release,
      token,
      api: typeof flags.api === "string" ? flags.api : undefined,
      urlPrefix: typeof flags["url-prefix"] === "string" ? flags["url-prefix"] : undefined,
      deleteAfter: Boolean(flags["delete-after"]),
      dryRun: Boolean(flags["dry-run"]),
      log: (line) => console.log(line),
    });
    console.log(
      `\n${result.uploaded.length} uploaded${result.failed.length ? `, ${result.failed.length} failed` : ""}.` +
        (result.uploaded.length && !flags["dry-run"]
          ? ` New errors from release ${release} will show your original code.`
          : ""),
    );
    return result.failed.length ? 1 : 0;
  } catch (error) {
    return fail((error as Error).message);
  }
}

function fail(message: string): number {
  console.error(`TraceX: ${message}`);
  return 1;
}

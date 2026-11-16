/**
 * npx @tracexpro/wizard: sets up TraceX error tracking in the app in this folder.
 *
 * It detects the framework, asks for the project's key, shows every change and asks
 * before making it, installs the SDK, writes the files (never overwriting one: an
 * existing file becomes a step to do by hand), and sends a test event.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { detect, FRAMEWORK_NAMES, installCommand, type Framework } from "./detect";
import { makePlan, type Change } from "./plan";

export const VERSION = "0.1.1";
export { detect } from "./detect";
export { makePlan, addImport, addToBody } from "./plan";
const DEFAULT_ENDPOINT = "https://ingest.tracexpro.com/api/events";
const KEY = /^txp_pub_[A-Za-z0-9]{16,60}$/;
const DASHBOARD = "https://app.tracexpro.com";

const color = (code: number) => (s: string) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = color(1);
const dim = color(2);
const green = color(32);
const yellow = color(33);
const red = color(31);
const cyan = color(36);

interface Args {
  key?: string;
  yes: boolean;
  install: boolean;
  test: boolean;
  dir: string;
  endpoint: string;
  framework?: Framework;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { yes: false, install: true, test: true, dir: process.cwd(), endpoint: DEFAULT_ENDPOINT, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => argv[++i];
    if (a === "--key") args.key = value();
    else if (a.startsWith("--key=")) args.key = a.slice(6);
    else if (a === "-y" || a === "--yes") args.yes = true;
    else if (a === "--skip-install") args.install = false;
    else if (a === "--no-test") args.test = false;
    else if (a === "--dir") args.dir = resolve(value());
    else if (a === "--endpoint") args.endpoint = value();
    else if (a === "--framework") args.framework = value() as Framework;
    else if (a === "-h" || a === "--help") args.help = true;
  }
  return args;
}

const HELP = `
${bold("npx @tracexpro/wizard")}  Set up TraceX error tracking in this app.

Options
  --key txp_pub_…     The project's key (TraceX → Issues → Alerts and SDK)
  -y, --yes           Don't ask before changing files
  --skip-install      Don't install the packages
  --no-test           Don't send a test event
  --dir <path>        The app's folder (default: this one)
  --framework <name>  ${Object.keys(FRAMEWORK_NAMES).join(", ")}
`;

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function confirm(question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) return false;
  const answer = (await ask(`${question} ${dim("(Y/n)")} `)).toLowerCase();
  return answer === "" || answer === "y" || answer === "yes";
}

/** Apply a plan; returns the manual steps left (including edits that couldn't be made). */
export function applyChanges(dir: string, changes: Change[], log: (line: string) => void = () => {}): Change[] {
  const manual: Change[] = [];
  for (const change of changes) {
    if (change.kind === "manual") {
      manual.push(change);
      continue;
    }
    const full = join(dir, change.path);
    if (change.kind === "create") {
      if (existsSync(full)) {
        manual.push({ kind: "manual", title: `${change.path} already exists: add TraceX to it yourself`, code: change.content });
        continue;
      }
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, change.content);
      log(`${green("created")} ${change.path}  ${dim(change.why)}`);
    } else {
      const before = readFileSync(full, "utf8");
      const after = change.apply(before);
      if (after === null) {
        manual.push({ kind: "manual", title: `Couldn't change ${change.path} safely: ${change.why} yourself`, path: change.path });
      } else if (after === before) {
        log(`${dim("unchanged")} ${change.path}  ${dim("(already set up)")}`);
      } else {
        writeFileSync(full, after);
        log(`${yellow("updated")} ${change.path}  ${dim(change.why)}`);
      }
    }
  }
  return manual;
}

/** Send one event from here, so the key and the connection are proven before deploying. */
export async function sendTest(endpoint: string, key: string, framework: string): Promise<{ ok: boolean; message: string }> {
  try {
    const response = await fetch(`${endpoint}?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({
        events: [
          {
            level: "info",
            platform: "node",
            message: "TraceX test from the setup wizard",
            tags: { source: "wizard", framework },
            sdk: { name: "tracex.wizard", version: VERSION },
          },
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string; accepted?: number };
    if (response.ok && (body.accepted ?? 1) > 0) return { ok: true, message: "test event accepted" };
    if (response.ok) return { ok: false, message: "this month's error events are used: the test wasn't stored" };
    if (body.error === "unknown_key") return { ok: false, message: "the key isn't valid or was revoked" };
    return { ok: false, message: `TraceX answered ${response.status}${body.error ? ` (${body.error})` : ""}` };
  } catch (error) {
    return { ok: false, message: `couldn't reach ${endpoint} (${(error as Error).message})` };
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  console.log(`\n${bold("TraceX setup")} ${dim(`v${VERSION}`)}\n`);

  const project = detect(args.dir);
  if (!project) {
    console.log(red("No package.json here.") + " Run this in your app's folder.");
    return 1;
  }
  if (args.framework) {
    if (!(args.framework in FRAMEWORK_NAMES)) {
      console.log(red(`Unknown framework "${args.framework}".`) + ` Use one of: ${Object.keys(FRAMEWORK_NAMES).join(", ")}`);
      return 1;
    }
    project.framework = args.framework;
  }
  console.log(`Found ${bold(FRAMEWORK_NAMES[project.framework])} ${dim(`(${project.packageManager}${project.typescript ? ", TypeScript" : ""})`)}`);
  if (!args.framework && !args.yes && process.stdin.isTTY && !(await confirm("Is that right?", false))) {
    console.log(`Run again with ${cyan("--framework <name>")}: ${Object.keys(FRAMEWORK_NAMES).join(", ")}`);
    return 1;
  }

  let key = args.key?.trim();
  if (!key) {
    if (!process.stdin.isTTY) {
      console.log(red("Pass the key with --key txp_pub_…") + " (TraceX → Issues → Alerts and SDK)");
      return 1;
    }
    console.log(dim(`\nThe project's key is under TraceX → Issues → Alerts and SDK (${DASHBOARD}/issues/settings).`));
    key = await ask("Key (txp_pub_…): ");
  }
  if (!KEY.test(key)) {
    console.log(red("That isn't a TraceX key.") + " It starts with txp_pub_. (Never use a secret key: this one is public.)");
    return 1;
  }

  const plan = makePlan(project, key);
  console.log(`\n${bold("What will happen")}`);
  const missing = plan.packages.filter((p) => !project.deps.has(p));
  if (args.install && missing.length) console.log(`  ${cyan("install")} ${missing.join(" ")}`);
  for (const change of plan.changes) {
    if (change.kind === "create") console.log(`  ${green("create")}  ${change.path}  ${dim(change.why)}`);
    else if (change.kind === "edit") console.log(`  ${yellow("update")}  ${change.path}  ${dim(change.why)}`);
  }
  const manualFirst = plan.changes.filter((c) => c.kind === "manual").length;
  if (manualFirst) console.log(`  ${dim(`+ ${manualFirst} step(s) to do yourself, shown at the end`)}`);
  if (args.test) console.log(`  ${cyan("send")}    a test event to TraceX`);

  if (!(await confirm("\nGo ahead?", args.yes))) {
    console.log("Nothing was changed.");
    return 1;
  }

  if (args.install && missing.length) {
    const [cmd, ...rest] = installCommand(project.packageManager, missing);
    console.log(dim(`\n$ ${cmd} ${rest.join(" ")}`));
    const run = spawnSync(cmd, rest, { cwd: project.dir, stdio: "inherit", shell: process.platform === "win32" });
    if (run.status !== 0) {
      console.log(red("Installing failed.") + ` Run it yourself: ${cmd} ${rest.join(" ")}`);
    }
  }

  console.log("");
  const manual = applyChanges(project.dir, plan.changes, (line) => console.log("  " + line));

  if (args.test) {
    const result = await sendTest(args.endpoint, key, project.framework);
    console.log(
      result.ok
        ? `\n${green("✓")} ${result.message}: open ${cyan(`${DASHBOARD}/issues`)} and look for "TraceX test from the setup wizard".`
        : `\n${red("✗")} Test event: ${result.message}.`,
    );
  }

  if (manual.length) {
    console.log(`\n${bold("Do these yourself")}`);
    manual.forEach((step, i) => {
      if (step.kind !== "manual") return;
      console.log(`\n${i + 1}. ${step.title}`);
      if (step.code) console.log(step.code.split("\n").map((l) => "     " + dim(l)).join("\n"));
    });
  }
  console.log(`\n${bold("Next")}`);
  for (const note of plan.notes) console.log(`  • ${note}`);
  console.log(`  • If the key is limited to your sites, add every address the app runs on (TraceX → Issues → Alerts and SDK → Sites).`);
  console.log(`  • Add debug: true to TraceX.init to see what's sent, and why something isn't.`);
  if (!["express", "node"].includes(project.framework)) {
    console.log(`  • Readable production stack traces: upload source maps in CI with npx @tracexpro/sourcemaps (https://docs.tracexpro.com/errors/source-maps/).`);
  }
  console.log(`  • Guides and troubleshooting: https://docs.tracexpro.com/errors/overview/\n`);
  return 0;
}

// Builds each package: ESM + CommonJS (+ a browser script for a <script> tag), and
// type declarations bundled from the shared core.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const packages = {
  browser: { platform: "browser", target: "es2019", global: "TraceX" },
  node: { platform: "node", target: "node18" },
};

for (const [name, cfg] of Object.entries(packages)) {
  const dir = `packages/${name}`;
  rmSync(`${dir}/dist`, { recursive: true, force: true });
  mkdirSync(`${dir}/dist`, { recursive: true });
  const common = {
    entryPoints: [`${dir}/src/index.ts`],
    bundle: true,
    platform: cfg.platform,
    target: cfg.target,
    sourcemap: true,
    legalComments: "none",
  };
  await build({ ...common, format: "esm", outfile: `${dir}/dist/index.js` });
  await build({ ...common, format: "cjs", outfile: `${dir}/dist/index.cjs` });
  if (cfg.global) {
    await build({
      ...common,
      format: "iife",
      globalName: cfg.global,
      minify: true,
      outfile: `${dir}/dist/tracex.min.js`,
    });
  }
}

// Declarations: tsc emits per file; the core's types are re-exported from each index
execFileSync("npx", ["tsc", "-p", "tsconfig.json", "--noEmit", "false", "--emitDeclarationOnly", "--outDir", "build-types"], {
  stdio: "inherit",
});
for (const name of Object.keys(packages)) {
  const dts = readFileSync(`build-types/${name}/src/index.d.ts`, "utf8")
    .replaceAll("../../core/src/", "./core/");
  writeFileSync(`packages/${name}/dist/index.d.ts`, dts);
  mkdirSync(`packages/${name}/dist/core`, { recursive: true });
  for (const file of ["types", "client", "stack"]) {
    writeFileSync(
      `packages/${name}/dist/core/${file}.d.ts`,
      readFileSync(`build-types/core/src/${file}.d.ts`, "utf8"),
    );
  }
}
rmSync("build-types", { recursive: true, force: true });
console.log("built @tracexpro/browser and @tracexpro/node");

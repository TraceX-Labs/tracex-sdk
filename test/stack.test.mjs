import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const { outputFiles } = await build({
  entryPoints: ["packages/core/src/stack.ts"],
  bundle: true,
  format: "esm",
  write: false,
  platform: "neutral",
});
const { parseStack, describe } = await import(
  "data:text/javascript;base64," + Buffer.from(outputFiles[0].text).toString("base64")
);

test("Chrome stacks", () => {
  const frames = parseStack(`TypeError: x is undefined
    at CartSummary (https://cdn.acme.io/static/js/main.4f9a2c1b.js:42:17)
    at renderWithHooks (https://cdn.acme.io/node_modules/react-dom/cjs/react-dom.js:1:2)
    at https://cdn.acme.io/static/js/main.4f9a2c1b.js:7:3`);
  assert.equal(frames.length, 3);
  assert.deepEqual(frames[0], {
    filename: "https://cdn.acme.io/static/js/main.4f9a2c1b.js",
    function: "CartSummary",
    lineno: 42,
    colno: 17,
    in_app: true,
  });
  assert.equal(frames[1].in_app, false);
  assert.equal(frames[2].function, "?");
});

test("Firefox and Safari stacks", () => {
  const frames = parseStack(`CartSummary@https://cdn.acme.io/static/js/main.js:42:17
@https://cdn.acme.io/static/js/main.js:7:3`);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].function, "CartSummary");
  assert.equal(frames[0].lineno, 42);
});

test("Node stacks: node internals aren't the app's code", () => {
  const frames = parseStack(`Error: boom
    at handler (/srv/app/routes/orders.js:12:9)
    at Layer.handle (/srv/app/node_modules/express/lib/router/layer.js:95:5)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)`);
  assert.deepEqual(frames.map((f) => f.in_app), [true, false, false]);
});

test("describes anything thrown", () => {
  assert.deepEqual(describe("plain").type, "Error");
  assert.equal(describe({ message: "obj" }).value, "obj");
  assert.equal(describe(new RangeError("r")).type, "RangeError");
});

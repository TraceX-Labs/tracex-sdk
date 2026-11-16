import assert from "node:assert/strict";
import { test } from "node:test";
import * as TraceX from "../packages/node/dist/index.js";
import { build } from "esbuild";

const agentBundle = await build({ entryPoints: ["packages/browser/src/agent.ts"], bundle: true, format: "esm", write: false });
const { browserOf, osOf } = await import(
  "data:text/javascript;base64," + Buffer.from(agentBundle.outputFiles[0].text).toString("base64")
);

const KEY = "txp_pub_testkey";

function capture() {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response("{}", { status: 202 });
  };
  return sent;
}

test("captures an exception with its stack, innermost frame first", async () => {
  const sent = capture();
  TraceX.init({ key: KEY, release: "api@1.0.0", captureUncaught: false, captureUnhandledRejections: false });
  function checkout() {
    throw new TypeError("Cannot read properties of undefined (reading 'price')");
  }
  try {
    checkout();
  } catch (error) {
    TraceX.captureException(error, { tags: { route: "/cart" } });
  }
  await TraceX.flush();
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /^https:\/\/ingest\.tracexpro\.com\/api\/events\?key=txp_pub_testkey$/);
  const [event] = sent[0].body.events;
  assert.equal(event.exception.type, "TypeError");
  assert.equal(event.exception.stacktrace[0].function, "checkout");
  assert.equal(event.exception.stacktrace[0].in_app, true);
  assert.equal(event.release, "api@1.0.0");
  assert.equal(event.tags.route, "/cart");
  assert.equal(event.platform, "node");
  assert.equal(event.contexts.runtime.name, "node");
  TraceX.close();
});

test("dedupes repeats, honours beforeSend and ignoreErrors, caps per minute", async () => {
  const sent = capture();
  TraceX.init({
    key: KEY,
    captureUncaught: false,
    captureUnhandledRejections: false,
    maxEventsPerMinute: 3,
    ignoreErrors: ["ResizeObserver"],
    beforeSend: (e) => (e.message === "drop me" ? null : e),
  });
  const error = new Error("same");
  TraceX.captureException(error);
  TraceX.captureException(error); // a repeat within 5 s
  TraceX.captureMessage("ResizeObserver loop limit exceeded");
  TraceX.captureMessage("drop me");
  TraceX.captureMessage("one");
  TraceX.captureMessage("two");
  TraceX.captureMessage("three"); // over 3 a minute
  await TraceX.flush();
  const messages = sent.flatMap((s) => s.body.events).map((e) => e.message || e.exception.value);
  assert.deepEqual(messages, ["same", "one", "two"]);
  TraceX.close();
});

test("query-string secrets are filtered from request URLs", async () => {
  const sent = capture();
  TraceX.init({ key: KEY, captureUncaught: false, captureUnhandledRejections: false });
  TraceX.captureMessage("failed", "error", { request: { url: "https://a.io/x?token=abc&page=2" } });
  await TraceX.flush();
  assert.equal(sent[0].body.events[0].request.url, "https://a.io/x?token=[Filtered]&page=2");
  TraceX.close();
});

test("Express handler reports 5xx with the route and passes the error on", async () => {
  const sent = capture();
  TraceX.init({ key: KEY, captureUncaught: false, captureUnhandledRejections: false });
  const handler = TraceX.expressErrorHandler();
  let passed;
  handler(new Error("db down"), { method: "GET", originalUrl: "/orders/1", route: { path: "/orders/:id" } }, {}, (e) => (passed = e));
  handler(Object.assign(new Error("nope"), { status: 404 }), { method: "GET", url: "/x" }, {}, () => {});
  await TraceX.flush();
  assert.equal(passed.message, "db down");
  const events = sent.flatMap((s) => s.body.events);
  assert.equal(events.length, 1);
  assert.equal(events[0].request.route, "/orders/:id");
  assert.equal(events[0].request.status_code, 500);
  TraceX.close();
});

test("refuses a secret or missing key", () => {
  assert.throws(() => TraceX.init({ key: "sk_live_x" }), /public key/);
});

test("browser and OS from the user agent", () => {
  const ua =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  assert.deepEqual(browserOf(ua), { name: "Chrome", version: "131" });
  assert.deepEqual(osOf(ua), { name: "macOS" });
  assert.equal(browserOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) Version/17.1 Mobile/15E148 Safari/604.1").name, "Safari");
});

test("debug explains what was dropped and what the server refused", async () => {
  const lines = [];
  const info = console.info;
  const warn = console.warn;
  console.info = (...a) => lines.push(a.join(" "));
  console.warn = (...a) => lines.push(a.join(" "));
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "origin_not_allowed" }), { status: 403 });
  try {
    TraceX.init({ key: KEY, debug: true, captureUncaught: false, captureUnhandledRejections: false, ignoreErrors: ["noise"] });
    TraceX.captureMessage("noise here");
    TraceX.captureMessage("real one", "error");
    await TraceX.flush();
  } finally {
    console.info = info;
    console.warn = warn;
    TraceX.close();
  }
  const all = lines.join("\n");
  assert.match(all, /started 0\.2\.0: key txp_pub_testke/);
  assert.match(all, /not sent: info: noise here \(it matches ignoreErrors\)/);
  assert.match(all, /captured error: real one/);
  assert.match(all, /refused: this site isn't in the key's allowed sites/);
});

test("isInitialized", () => {
  assert.equal(TraceX.isInitialized(), false);
  TraceX.init({ key: KEY, captureUncaught: false, captureUnhandledRejections: false });
  assert.equal(TraceX.isInitialized(), true);
  TraceX.close();
});

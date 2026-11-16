/**
 * TraceX for Node.js: catches uncaught exceptions and unhandled rejections, reports
 * request errors from Express (and anything else you pass it) and sends them to TraceX.
 *
 *   const TraceX = require("@tracexpro/node");
 *   TraceX.init({ key: "txp_pub_…", release: process.env.GIT_SHA });
 *   app.use(TraceX.expressErrorHandler());   // after your routes
 */
import os from "node:os";
import { Client } from "../../core/src/client";
import type { BaseOptions, Breadcrumb, CaptureContext, Level } from "../../core/src/types";

export type { BaseOptions, Breadcrumb, CaptureContext, Level, TraceXEvent } from "../../core/src/types";

export const VERSION = "0.1.0";

export interface NodeOptions extends BaseOptions {
  /** Report uncaught exceptions (then exit, as Node would). Default true. */
  captureUncaught?: boolean;
  /** Report unhandled promise rejections. Default true. */
  captureUnhandledRejections?: boolean;
}

let client: Client | null = null;
const undo: Array<() => void> = [];

function contexts(): Record<string, unknown> {
  return {
    runtime: { name: "node", version: process.version },
    os: { name: os.type(), version: os.release() },
    device: { arch: process.arch, memory_mb: Math.round(os.totalmem() / 1048576) },
    app: { uptime_s: Math.round(process.uptime()) },
  };
}

async function send(url: string, body: string): Promise<void> {
  await fetch(url, {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(5000),
  });
}

/** Start TraceX. Call once, before the rest of your app runs. */
export function init(options: NodeOptions): void {
  if (client) close();
  client = new Client(
    { environment: process.env.NODE_ENV || "production", ...options },
    "node",
    { name: "tracex.node", version: VERSION },
    send,
    contexts,
  );
  const c = client;
  if (options.captureUncaught !== false) {
    const onUncaught = async (error: Error) => {
      c.captureException(error, { level: "fatal", tags: { mechanism: "uncaughtException" } });
      await c.flush(true);
      // Same as Node without a handler: the process is in an unknown state
      if (process.listenerCount("uncaughtException") <= 1) process.exit(1);
    };
    process.on("uncaughtException", onUncaught);
    undo.push(() => process.off("uncaughtException", onUncaught));
  }
  if (options.captureUnhandledRejections !== false) {
    const onRejection = (reason: unknown) => {
      c.captureException(reason, { tags: { mechanism: "unhandledRejection" } });
    };
    process.on("unhandledRejection", onRejection);
    undo.push(() => process.off("unhandledRejection", onRejection));
  }
  const beforeExit = () => void c.flush(true);
  process.on("beforeExit", beforeExit);
  undo.push(() => process.off("beforeExit", beforeExit));
}

type Req = { method?: string; originalUrl?: string; url?: string; route?: { path?: string } };
type Res = { statusCode?: number; headersSent?: boolean };

/** Express error middleware: reports the error with its request, then passes it on. */
export function expressErrorHandler(opts: { minStatus?: number } = {}) {
  const minStatus = opts.minStatus ?? 500;
  return function tracexErrorHandler(error: unknown, req: Req, res: Res, next: (e?: unknown) => void) {
    const status = Number((error as { status?: number; statusCode?: number })?.status ?? (error as { statusCode?: number })?.statusCode ?? 500);
    if (status >= minStatus) {
      client?.captureException(error, {
        request: {
          method: req.method,
          url: req.originalUrl || req.url,
          route: req.route?.path,
          status_code: status,
        },
      });
    }
    next(error);
  };
}

export function captureException(error: unknown, context?: CaptureContext): string | null {
  return client ? client.captureException(error, context) : null;
}

export function captureMessage(message: string, level: Level = "info", context?: CaptureContext): string | null {
  return client ? client.captureMessage(message, level, context) : null;
}

export function setUser(user: { id?: string | number } | null): void {
  client?.setUser(user);
}

export function setTag(key: string, value: string): void {
  client?.setTag(key, value);
}

export function addBreadcrumb(crumb: Breadcrumb): void {
  client?.addBreadcrumb(crumb);
}

/** Send queued events now; await it before a serverless function returns. */
export function flush(): Promise<void> {
  return client ? client.flush() : Promise.resolve();
}

export function close(): void {
  while (undo.length) undo.pop()?.();
  client = null;
}

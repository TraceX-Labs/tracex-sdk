/**
 * TraceX for the browser: catches errors, unhandled promise rejections and failed API
 * calls, with breadcrumbs of what happened before, and sends them to TraceX.
 *
 *   import * as TraceX from "@tracexpro/browser";
 *   TraceX.init({ key: "txp_pub_…", release: "web@1.4.0" });
 */
import { Client, scrubUrl } from "../../core/src/client";
import type { BaseOptions, Breadcrumb, CaptureContext, Level } from "../../core/src/types";

export type { BaseOptions, Breadcrumb, CaptureContext, Level, TraceXEvent } from "../../core/src/types";

export const VERSION = "0.1.0";

export interface BrowserOptions extends BaseOptions {
  /** Report API calls answered with 5xx (and, if set, these 4xx codes). Default true. */
  captureFailedRequests?: boolean | { statuses?: number[] };
  /** Also report console.error calls. Default false. */
  captureConsoleErrors?: boolean;
  /** Record clicks, page changes, requests and console warnings as breadcrumbs. Default true. */
  breadcrumbs?: boolean;
}

let client: Client | null = null;
const undo: Array<() => void> = [];

function contexts(): Record<string, unknown> {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  const ua = nav?.userAgent || "";
  return {
    browser: browserOf(ua),
    os: osOf(ua),
    device: {
      screen: typeof screen !== "undefined" ? `${screen.width}x${screen.height}` : undefined,
      language: nav?.language,
      online: nav?.onLine,
    },
    page: { url: scrubUrl(typeof location !== "undefined" ? location.href : undefined) },
  };
}

export function browserOf(ua: string): { name: string; version?: string } {
  const rules: Array<[string, RegExp]> = [
    ["Edge", /Edg\/(\d+)/],
    ["Opera", /OPR\/(\d+)/],
    ["Samsung Internet", /SamsungBrowser\/(\d+)/],
    ["Chrome", /Chrome\/(\d+)/],
    ["Firefox", /Firefox\/(\d+)/],
    ["Safari", /Version\/(\d+).*Safari/],
  ];
  for (const [name, pattern] of rules) {
    const match = pattern.exec(ua);
    if (match) return { name, version: match[1] };
  }
  return { name: "Unknown" };
}

export function osOf(ua: string): { name: string; version?: string } {
  if (/Windows NT 10/.test(ua)) return { name: "Windows", version: "10+" };
  if (/Windows/.test(ua)) return { name: "Windows" };
  if (/iPhone|iPad|iPod/.test(ua)) return { name: "iOS", version: /OS (\d+)/.exec(ua)?.[1] };
  if (/Mac OS X/.test(ua)) return { name: "macOS" };
  if (/Android/.test(ua)) return { name: "Android", version: /Android (\d+)/.exec(ua)?.[1] };
  if (/Linux/.test(ua)) return { name: "Linux" };
  return { name: "Unknown" };
}

function send(url: string, body: string, final: boolean): Promise<void> | void {
  // text/plain: a "simple" request, so the browser sends it without a CORS preflight
  if (final && typeof navigator !== "undefined" && navigator.sendBeacon) {
    navigator.sendBeacon(url, new Blob([body], { type: "text/plain" }));
    return;
  }
  return originalFetch(url, {
    method: "POST",
    body,
    keepalive: body.length < 60_000,
    headers: { "content-type": "text/plain" },
  }).then(() => undefined);
}

let originalFetch: typeof fetch = (...args) => fetch(...args);

function selector(el: Element | null): string {
  if (!el || !el.tagName) return "?";
  const id = el.id ? `#${el.id}` : "";
  const cls =
    typeof el.className === "string" && el.className
      ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
      : "";
  const label = el.getAttribute("aria-label") || el.getAttribute("name");
  return `${el.tagName.toLowerCase()}${id}${cls}${label ? `[${label.slice(0, 40)}]` : ""}`;
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url, location.href);
    return parsed.origin === location.origin ? parsed.pathname : `${parsed.host}${parsed.pathname}`;
  } catch {
    return url.split("?")[0];
  }
}

/** Start TraceX. Call once, as early as possible. */
export function init(options: BrowserOptions): void {
  if (client) close();
  if (typeof window === "undefined") return; // server rendering: use @tracexpro/node there
  client = new Client(options, "javascript", { name: "tracex.browser", version: VERSION }, send, contexts);
  const c = client;

  const onError = (event: ErrorEvent) => {
    // Script errors from other sites without CORS carry no details: skip them
    if (!event.error && event.message === "Script error.") return;
    c.captureException(event.error ?? event.message, { level: "error" });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    c.captureException(event.reason ?? "Unhandled promise rejection", { tags: { mechanism: "unhandledrejection" } });
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  undo.push(() => window.removeEventListener("error", onError));
  undo.push(() => window.removeEventListener("unhandledrejection", onRejection));

  const onHide = () => {
    if (document.visibilityState === "hidden") void c.flush(true);
  };
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", () => void c.flush(true));
  undo.push(() => document.removeEventListener("visibilitychange", onHide));

  const wantCrumbs = options.breadcrumbs !== false;
  if (wantCrumbs) {
    const onClick = (event: MouseEvent) =>
      c.addBreadcrumb({ category: "ui.click", message: selector(event.target as Element) });
    document.addEventListener("click", onClick, true);
    undo.push(() => document.removeEventListener("click", onClick, true));
    for (const method of ["pushState", "replaceState"] as const) {
      const original = history[method];
      history[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
        const to = args[2] ? pathOf(String(args[2])) : location.pathname;
        c.addBreadcrumb({ category: "navigation", message: `${location.pathname} → ${to}` });
        return original.apply(this, args);
      };
      undo.push(() => (history[method] = original));
    }
    const onPop = () => c.addBreadcrumb({ category: "navigation", message: location.pathname });
    window.addEventListener("popstate", onPop);
    undo.push(() => window.removeEventListener("popstate", onPop));
  }

  // Console: warnings and errors as breadcrumbs (and console.error as events if asked)
  for (const level of ["warn", "error"] as const) {
    const original = console[level];
    console[level] = (...args: unknown[]) => {
      const message = args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ").slice(0, 300);
      if (wantCrumbs) c.addBreadcrumb({ category: `console.${level}`, message });
      if (level === "error" && options.captureConsoleErrors) {
        const error = args.find((a) => a instanceof Error);
        if (error) c.captureException(error, { tags: { mechanism: "console" } });
        else c.captureMessage(message, "error", { tags: { mechanism: "console" } });
      }
      original.apply(console, args);
    };
    undo.push(() => (console[level] = original));
  }

  // fetch: breadcrumbs, and failed API calls as events
  const failed = options.captureFailedRequests ?? true;
  const statuses = typeof failed === "object" ? failed.statuses || [] : [];
  const nativeFetch = window.fetch;
  originalFetch = nativeFetch.bind(window);
  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (c.isOwnRequest(url)) return nativeFetch.call(window, input, init);
    const started = Date.now();
    try {
      const response = await nativeFetch.call(window, input, init);
      const crumb: Breadcrumb = {
        category: "fetch",
        message: `${method} ${pathOf(url)} → ${response.status}`,
        data: { ms: Date.now() - started },
      };
      if (wantCrumbs) c.addBreadcrumb(crumb);
      if (failed && (response.status >= 500 || statuses.includes(response.status))) {
        c.capture(
          {
            level: "error",
            exception: { type: "HTTPError", value: `${method} ${pathOf(url)} → ${response.status}` },
            request: { url, method, status_code: response.status, route: pathOf(url) },
          },
          { tags: { mechanism: "fetch" } },
        );
      }
      return response;
    } catch (error) {
      if (wantCrumbs) c.addBreadcrumb({ category: "fetch", message: `${method} ${pathOf(url)} → failed` });
      throw error;
    }
  };
  undo.push(() => {
    window.fetch = nativeFetch;
    originalFetch = (...args) => fetch(...args);
  });

  // XMLHttpRequest (older code and libraries like axios in some setups)
  const xhr = XMLHttpRequest.prototype;
  const open = xhr.open;
  const sendXhr = xhr.send;
  xhr.open = function (this: XMLHttpRequest & { __tx?: { method: string; url: string } }, method: string, url: string | URL, ...rest: unknown[]) {
    this.__tx = { method: String(method).toUpperCase(), url: String(url) };
    // @ts-expect-error — passing the optional arguments through as given
    return open.call(this, method, url, ...rest);
  };
  xhr.send = function (this: XMLHttpRequest & { __tx?: { method: string; url: string } }, body?: Document | XMLHttpRequestBodyInit | null) {
    const info = this.__tx;
    if (info && !c.isOwnRequest(info.url)) {
      this.addEventListener("loadend", () => {
        if (wantCrumbs) c.addBreadcrumb({ category: "xhr", message: `${info.method} ${pathOf(info.url)} → ${this.status}` });
        if (failed && (this.status >= 500 || statuses.includes(this.status))) {
          c.capture(
            {
              level: "error",
              exception: { type: "HTTPError", value: `${info.method} ${pathOf(info.url)} → ${this.status}` },
              request: { url: info.url, method: info.method, status_code: this.status, route: pathOf(info.url) },
            },
            { tags: { mechanism: "xhr" } },
          );
        }
      });
    }
    return sendXhr.call(this, body);
  };
  undo.push(() => {
    xhr.open = open;
    xhr.send = sendXhr;
  });
}

/** Report an error you caught yourself. Returns the event id. */
export function captureException(error: unknown, context?: CaptureContext): string | null {
  return client ? client.captureException(error, context) : null;
}

/** Report something that isn't an exception ("Coupon rejected"). */
export function captureMessage(message: string, level: Level = "info", context?: CaptureContext): string | null {
  return client ? client.captureMessage(message, level, context) : null;
}

/** Who is affected: an id only (never an email or name). Hashed by TraceX. */
export function setUser(user: { id?: string | number } | null): void {
  client?.setUser(user);
}

export function setTag(key: string, value: string): void {
  client?.setTag(key, value);
}

export function addBreadcrumb(crumb: Breadcrumb): void {
  client?.addBreadcrumb(crumb);
}

/** Send queued events now (before a redirect, for example). */
export function flush(): Promise<void> {
  return client ? client.flush() : Promise.resolve();
}

/** For a React error boundary's componentDidCatch (or onError in react-error-boundary). */
export function reactErrorHandler(error: unknown, info?: { componentStack?: string | null }): void {
  client?.captureException(error, {
    tags: { mechanism: "react", ...(info?.componentStack ? { component: info.componentStack.trim().split("\n")[0].trim().slice(0, 150) } : {}) },
  });
}

/** Stop TraceX and put back everything it wrapped. */
export function close(): void {
  while (undo.length) undo.pop()?.();
  client = null;
}

import { describe, parseStack } from "./stack";
import type { BaseOptions, Breadcrumb, CaptureContext, Level, TraceXEvent } from "./types";

export const DEFAULT_ENDPOINT = "https://ingest.tracexpro.com/api/events";
const MAX_BREADCRUMBS = 30;
const BATCH_SIZE = 10;
const FLUSH_MS = 1000;
const DEDUPE_MS = 5000;

const SECRET_PARAM = /([?&](?:token|key|secret|password|passwd|auth|code|sig|signature|access_token)=)[^&#]*/gi;

/** Query-string secrets out of a URL (the server scrubs again). */
export function scrubUrl(url: string | undefined): string | undefined {
  return url ? url.replace(SECRET_PARAM, "$1[Filtered]") : url;
}

export function uuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "");
  let out = "";
  for (let i = 0; i < 32; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

export type Sender = (url: string, body: string, final: boolean) => Promise<void> | void;

/** What every TraceX SDK shares: building, filtering, batching and sending events. */
export class Client {
  readonly options: Required<Pick<BaseOptions, "endpoint" | "sampleRate" | "maxEventsPerMinute">> &
    BaseOptions;
  private queue: TraceXEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private crumbs: Breadcrumb[] = [];
  private tags: Record<string, string> = {};
  private user: TraceXEvent["user"] | undefined;
  private sentThisMinute = 0;
  private minuteStarted = Date.now();
  private recent = new Map<string, number>();

  constructor(
    options: BaseOptions,
    private readonly platform: string,
    private readonly sdk: { name: string; version: string },
    private readonly send: Sender,
    private readonly contexts: () => Record<string, unknown> = () => ({}),
  ) {
    if (!options.key || !options.key.startsWith("txp_pub_")) {
      throw new Error("TraceX: pass your project's public key (txp_pub_…) as `key`.");
    }
    this.options = {
      endpoint: DEFAULT_ENDPOINT,
      sampleRate: 1,
      maxEventsPerMinute: 30,
      ...options,
    };
  }

  get url(): string {
    return `${this.options.endpoint}?key=${encodeURIComponent(this.options.key)}`;
  }

  setUser(user: { id?: string | number } | null): void {
    this.user = user && user.id !== undefined ? { id: user.id } : undefined;
  }

  setTag(key: string, value: string): void {
    this.tags[key] = String(value);
  }

  addBreadcrumb(crumb: Breadcrumb): void {
    this.crumbs.push({ timestamp: new Date().toISOString(), ...crumb });
    if (this.crumbs.length > MAX_BREADCRUMBS) this.crumbs.shift();
  }

  captureException(thrown: unknown, context: CaptureContext = {}): string | null {
    const { type, value, stack } = describe(thrown);
    return this.capture(
      {
        level: context.level || "error",
        exception: { type, value, stacktrace: parseStack(stack) },
      },
      context,
    );
  }

  captureMessage(message: string, level: Level = "info", context: CaptureContext = {}): string | null {
    return this.capture({ level, message }, context);
  }

  /** Build, filter and queue an event; returns its id (null when it was dropped). */
  capture(partial: Partial<TraceXEvent>, context: CaptureContext = {}): string | null {
    if (this.options.enabled === false) return null;
    const text = partial.exception?.value || partial.message || "";
    if (this.ignored(`${partial.exception?.type || ""}: ${text}`)) return null;
    if (Math.random() >= this.options.sampleRate) return null;
    const signature = `${partial.exception?.type}|${text}|${partial.exception?.stacktrace?.[0]?.filename}:${partial.exception?.stacktrace?.[0]?.lineno}`;
    const now = Date.now();
    const last = this.recent.get(signature);
    if (last && now - last < DEDUPE_MS) return null;
    this.recent.set(signature, now);
    if (this.recent.size > 200) this.recent.clear();
    if (now - this.minuteStarted > 60_000) {
      this.minuteStarted = now;
      this.sentThisMinute = 0;
    }
    if (this.sentThisMinute >= this.options.maxEventsPerMinute) return null;

    let event: TraceXEvent | null = {
      event_id: uuid(),
      timestamp: new Date().toISOString(),
      level: partial.level || "error",
      platform: this.platform,
      environment: this.options.environment,
      release: this.options.release,
      breadcrumbs: this.crumbs.slice(),
      contexts: this.contexts(),
      tags: { ...this.tags, ...(context.tags || {}) },
      user: this.user,
      sdk: this.sdk,
      ...partial,
    };
    if (context.fingerprint) event.fingerprint = context.fingerprint;
    if (context.request) event.request = context.request;
    if (event.request) event.request = { ...event.request, url: scrubUrl(event.request.url) };
    if (this.options.beforeSend) {
      try {
        event = this.options.beforeSend(event);
      } catch {
        // A failing beforeSend never breaks the app; the event is sent as it was
      }
      if (!event) return null;
    }
    this.sentThisMinute += 1;
    this.queue.push(event);
    this.addBreadcrumb({
      category: "tracex",
      message: `${event.exception?.type || event.level}: ${text.slice(0, 120)}`,
    });
    if (this.queue.length >= BATCH_SIZE) void this.flush();
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), FLUSH_MS);
    return event.event_id;
  }

  /** Send everything queued now. ``final``: the page or process is going away. */
  async flush(final = false): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.queue.length) {
      const batch = this.queue.splice(0, 50);
      try {
        await this.send(this.url, JSON.stringify({ events: batch }), final);
      } catch (error) {
        if (this.options.debug) console.warn("TraceX: couldn't send events", error);
      }
    }
  }

  private ignored(text: string): boolean {
    return (this.options.ignoreErrors || []).some((rule) =>
      typeof rule === "string" ? text.includes(rule) : rule.test(text),
    );
  }

  /** Requests to TraceX itself are never recorded (no loops). */
  isOwnRequest(url: string): boolean {
    return url.startsWith(this.options.endpoint);
  }
}

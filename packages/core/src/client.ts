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

/** What the server answered (unknown for a beacon sent as the page closes). */
export type SendResult = { status: number; body?: unknown } | void;
export type Sender = (url: string, body: string, final: boolean) => Promise<SendResult> | SendResult;

/** Why the server refused events, in words a developer can act on. */
const REFUSALS: Record<string, string> = {
  unknown_key: "the key isn't valid or was revoked. Copy it again from TraceX → Issues → Alerts and SDK.",
  origin_not_allowed: "this site isn't in the key's allowed sites. Add it under TraceX → Issues → Alerts and SDK → SDK keys → Sites.",
  rate_limited: "too many requests from this key; events are being dropped for a minute.",
  too_large: "the batch is over 512 KB.",
};

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
    const text = partial.exception?.value || partial.message || "";
    const label = `${partial.exception?.type || partial.level || "event"}: ${text.slice(0, 80)}`;
    if (this.options.enabled === false) return this.skip(label, "enabled is false");
    if (this.ignored(`${partial.exception?.type || ""}: ${text}`)) return this.skip(label, "it matches ignoreErrors");
    if (Math.random() >= this.options.sampleRate) return this.skip(label, `sampleRate is ${this.options.sampleRate}`);
    const signature = `${partial.exception?.type}|${text}|${partial.exception?.stacktrace?.[0]?.filename}:${partial.exception?.stacktrace?.[0]?.lineno}`;
    const now = Date.now();
    const last = this.recent.get(signature);
    if (last && now - last < DEDUPE_MS) return this.skip(label, "the same error was sent less than 5 seconds ago");
    this.recent.set(signature, now);
    if (this.recent.size > 200) this.recent.clear();
    if (now - this.minuteStarted > 60_000) {
      this.minuteStarted = now;
      this.sentThisMinute = 0;
    }
    if (this.sentThisMinute >= this.options.maxEventsPerMinute) {
      return this.skip(label, `maxEventsPerMinute (${this.options.maxEventsPerMinute}) was reached`);
    }

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
      } catch (error) {
        // A failing beforeSend never breaks the app; the event is sent as it was
        this.log("beforeSend threw; sending the event unchanged", error);
      }
      if (!event) return this.skip(label, "beforeSend returned null");
    }
    this.sentThisMinute += 1;
    this.queue.push(event);
    this.log(`captured ${label} (${event.event_id})`);
    this.addBreadcrumb({
      category: "tracex",
      message: `${event.exception?.type || event.level}: ${text.slice(0, 120)}`,
    });
    if (this.queue.length >= BATCH_SIZE) void this.flush();
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), FLUSH_MS);
    return event.event_id;
  }

  /** With ``debug: true``, what TraceX does (and why it didn't send something). */
  log(message: string, ...extra: unknown[]): void {
    if (this.options.debug) console.info(`[TraceX] ${message}`, ...extra);
  }

  private skip(label: string, why: string): null {
    this.log(`not sent: ${label} (${why})`);
    return null;
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
        const result = await this.send(this.url, JSON.stringify({ events: batch }), final);
        this.report(batch.length, result);
      } catch (error) {
        // Ad blockers and offline browsers end up here
        this.log(`couldn't reach ${this.options.endpoint} (blocked by an ad blocker, a CSP rule, or offline?)`, error);
      }
    }
  }

  private report(count: number, result: SendResult): void {
    if (!this.options.debug) return;
    if (!result) {
      this.log(`sent ${count} event(s) as the page closed`);
      return;
    }
    const body = (result.body || {}) as { error?: string; accepted?: number; dropped?: number };
    if (result.status < 300) {
      const dropped = body.dropped ? `; ${body.dropped} over this month's allowance, not stored` : "";
      this.log(`sent ${count} event(s): ${body.accepted ?? count} accepted${dropped}. See them under Issues in TraceX.`);
    } else {
      const why = (body.error && REFUSALS[body.error]) || `HTTP ${result.status}`;
      console.warn(`[TraceX] ${count} event(s) refused: ${why}`);
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

export type Level = "fatal" | "error" | "warning" | "info" | "debug";

export interface Frame {
  filename: string;
  function: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
}

export interface Breadcrumb {
  type?: string;
  category?: string;
  message?: string;
  timestamp?: string;
  data?: Record<string, unknown>;
}

export interface TraceXEvent {
  event_id: string;
  timestamp: string;
  level: Level;
  platform: string;
  environment?: string;
  release?: string;
  message?: string;
  exception?: { type?: string; value?: string; stacktrace?: Frame[] };
  request?: { url?: string; method?: string; status_code?: number; route?: string };
  breadcrumbs?: Breadcrumb[];
  contexts?: Record<string, unknown>;
  tags?: Record<string, string>;
  user?: { id?: string | number };
  fingerprint?: string[];
  sdk: { name: string; version: string };
}

export interface CaptureContext {
  tags?: Record<string, string>;
  level?: Level;
  fingerprint?: string[];
  request?: TraceXEvent["request"];
}

export interface BaseOptions {
  /** The project's public key (txp_pub_…) from Settings → Error tracking. */
  key: string;
  /** Where events go. Default: https://ingest.tracexpro.com/api/events */
  endpoint?: string;
  release?: string;
  environment?: string;
  /** Share of errors to send, 0 to 1. Default 1. */
  sampleRate?: number;
  /** At most this many events a minute from one page or process. Default 30. */
  maxEventsPerMinute?: number;
  /** Change or drop (return null) an event before it's sent. */
  beforeSend?: (event: TraceXEvent) => TraceXEvent | null;
  /** Errors to never send: substrings or patterns matched against the message. */
  ignoreErrors?: Array<string | RegExp>;
  /** Turn sending off (tests, local development). */
  enabled?: boolean;
  /** Log to the console what TraceX captures, sends and drops, and why. */
  debug?: boolean;
}

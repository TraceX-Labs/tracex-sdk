import type { Frame } from "./types";

// Chrome, Edge, Node:   "    at fn (https://x/app.js:10:5)"  or  "    at https://x/app.js:10:5"
const V8 = /^\s*at (?:(.+?) \()?((?:file|https?|blob|chrome-extension|webpack|node|app|\/|[a-zA-Z]:\\).*?|<anonymous>):(\d+)(?::(\d+))?\)?\s*$/;
// Firefox, Safari:      "fn@https://x/app.js:10:5"
const GECKO = /^\s*(.*?)(?:\((.*?)\))?(?:^|@)((?:file|https?|blob|chrome|webpack|resource|moz-extension|safari-extension|capacitor|\/|app).*?):(\d+)(?::(\d+))?\s*$/;

const NOT_APP = /node_modules|^node:|^internal\/|chrome-extension:|moz-extension:|safari-extension:|safari-web-extension:|<anonymous>|\/@tracexpro\//;

/** Frames from an error's stack, innermost (where it was thrown) first. */
export function parseStack(stack: string | undefined, maxFrames = 50): Frame[] {
  if (!stack) return [];
  const frames: Frame[] = [];
  for (const line of stack.split("\n")) {
    if (frames.length >= maxFrames) break;
    let match = V8.exec(line);
    if (match) {
      frames.push(frame(match[1], match[2], match[3], match[4]));
      continue;
    }
    if (line.includes("@") || /^\s*\w*\(/.test(line)) {
      match = GECKO.exec(line);
      if (match) frames.push(frame(match[1], match[3], match[4], match[5]));
    }
  }
  return frames;
}

function frame(fn: string | undefined, file: string, line?: string, col?: string): Frame {
  const filename = file || "?";
  return {
    filename,
    function: (fn || "?").replace(/^async /, "").trim() || "?",
    lineno: line ? Number(line) : undefined,
    colno: col ? Number(col) : undefined,
    in_app: !NOT_APP.test(filename),
  };
}

/** The error's type and message from anything thrown (an Error, a string, an object). */
export function describe(thrown: unknown): { type: string; value: string; stack?: string } {
  if (thrown instanceof Error) {
    return { type: thrown.name || "Error", value: thrown.message || "", stack: thrown.stack };
  }
  if (typeof thrown === "string") return { type: "Error", value: thrown };
  if (thrown && typeof thrown === "object") {
    const o = thrown as Record<string, unknown>;
    const value =
      typeof o.message === "string" ? o.message : safeJson(thrown).slice(0, 500) || "Object";
    return {
      type: typeof o.name === "string" ? o.name : "Error",
      value,
      stack: typeof o.stack === "string" ? o.stack : undefined,
    };
  }
  return { type: "Error", value: String(thrown) };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) || "";
  } catch {
    return "";
  }
}

// Fixed-window rate limits kept in the database (they survive restarts).
// Keys never hold an IP address: callers pass ipKey(), an HMAC of the
// address that changes every day.
import { hmac } from "./secret";
import { one, run } from "./db";

export class RateLimitError extends Error {
  constructor(public retryAfter: number) {
    super("rate limited");
  }
}

// Counts one hit; throws RateLimitError once `max` hits fell into the window.
export function hit(key: string, max: number, windowSeconds: number, at = Date.now()) {
  const windowMs = windowSeconds * 1000;
  const row = one<{ window_start: number; count: number }>("SELECT window_start,count FROM rate_limits WHERE key=?", key);
  if (!row || at - row.window_start >= windowMs) {
    run("INSERT INTO rate_limits(key,window_start,count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start,count=1", key, at);
    pruneSometimes(at);
    return;
  }
  if (row.count >= max) throw new RateLimitError(Math.ceil((row.window_start + windowMs - at) / 1000));
  run("UPDATE rate_limits SET count=count+1 WHERE key=?", key);
}

// Without throwing: true when the hit was allowed.
export function allow(key: string, max: number, windowSeconds: number, at = Date.now()) {
  try {
    hit(key, max, windowSeconds, at);
    return true;
  } catch (error) {
    if (error instanceof RateLimitError) return false;
    throw error;
  }
}

let lastPrune = 0;
function pruneSometimes(at: number) {
  if (at - lastPrune < 60 * 60 * 1000) return;
  lastPrune = at;
  // Windows are at most a day long.
  run("DELETE FROM rate_limits WHERE window_start < ?", at - 2 * 24 * 60 * 60 * 1000);
}

// The visitor's address as a daily HMAC: enough to tell repeated requests
// apart, useless for recognising anyone the next day.
export function ipKey(ip: string, at = Date.now()) {
  const day = Math.floor(at / 86_400_000);
  return hmac("ip", `${day}:${ip}`).slice(0, 22);
}

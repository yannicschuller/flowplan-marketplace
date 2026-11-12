// Retention: what has run out is deleted. Runs at most once an hour – on a
// timer started in instrumentation.ts and, as before, from the rate limiter
// whenever a new window starts – so it happens without new sign-ins too.
import { run } from "./db";

export const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 86_400_000;

export function cleanup(at = Date.now()) {
  return {
    // Rate-limit windows are at most a day long.
    rateLimits: Number(run("DELETE FROM rate_limits WHERE window_start < ?", at - 2 * DAY_MS).changes),
    sessions: Number(run("DELETE FROM sessions WHERE expires_at < ?", at).changes),
    // Sign-in links (15 minutes, once): gone a day after they ran out, so a
    // late click still says "expired" instead of "invalid".
    signInLinks: Number(run("DELETE FROM magic_links WHERE expires_at < ?", at - DAY_MS).changes),
  };
}

const state = globalThis as unknown as { marketplaceCleanup?: { last: number; timer?: ReturnType<typeof setInterval> } };
export function cleanupSometimes(at = Date.now()) {
  const s = (state.marketplaceCleanup ??= { last: 0 });
  if (at - s.last < CLEANUP_INTERVAL_MS) return null;
  s.last = at;
  return cleanup(at);
}
// The hourly timer (once per process; it never keeps the process alive).
export function startCleanupTimer() {
  const s = (state.marketplaceCleanup ??= { last: 0 });
  if (s.timer) return;
  const tick = () => {
    try {
      cleanupSometimes();
    } catch (error) {
      console.error("cleanup failed", error);
    }
  };
  tick();
  s.timer = setInterval(tick, CLEANUP_INTERVAL_MS);
  s.timer.unref?.();
}

/**
 * Image provider access control.
 *
 * ONE key, ONE model: the single Agnes AI key (AGNES_API_KEY) drives every
 * render through `agnes-image-2.5-flash`. The key is read only here, on the
 * server, and is never sent to the browser or written into the codebase.
 *
 * The free tier allows 20 requests per minute, so this module owns a hard
 * 20 RPM sliding-window gate plus a small concurrency cap. Every image request
 * in the process passes through `withImageKey`, so the limit can never be
 * exceeded no matter how many lanes the page runs.
 */

/** Requests allowed per rolling minute (provider limit). */
export const IMAGE_RPM = 15;
/** Rolling window length. */
const WINDOW_MS = 60_000;
/** Safety margin so clock drift never pushes a request over the edge. */
const SPACING_MS = Math.ceil(WINDOW_MS / IMAGE_RPM) + 100; // ~3.1s between starts

/**
 * How many renders may be in flight at once. A render can take tens of
 * seconds; more than this in parallel buys nothing once 20 RPM is the ceiling.
 */
export const PER_KEY_CONCURRENCY = 1;

export function agnesKey(): string {
  const key = process.env["AGNES_API_KEY"]?.trim();
  if (!key) throw new Error("Missing AGNES_API_KEY (Agnes AI image key)");
  return key;
}

/** Start times of recent requests, oldest first. */
let starts: number[] = [];
let inFlight = 0;
let lastStart = 0;

/* --- Adaptive throttle ------------------------------------------------ *
 * The documented 20 RPM is an upper bound; the provider's edge also rate
 * limits bursts (HTTP 429, "error code: 1015"). When that happens every
 * lane in the process must back off together, otherwise the retries below
 * simply burn the whole ladder in a few seconds — which is exactly what the
 * reported "did not render: 429" panels were. So a 429 opens a shared
 * cooldown and permanently widens the spacing until requests succeed again.
 */

/** No request may start before this timestamp. */
let cooldownUntil = 0;
/** Consecutive rate-limit hits; drives both cooldown length and spacing. */
let throttleLevel = 0;

/** Current minimum gap between two request starts. */
function spacing(): number {
  return SPACING_MS * (1 + throttleLevel);
}

/** Record a rate-limit response so every lane slows down. */
export function noteRateLimit(retryAfterMs?: number): number {
  throttleLevel = Math.min(throttleLevel + 1, 5);
  const backoff = retryAfterMs && retryAfterMs > 0
    ? Math.min(retryAfterMs, 120_000)
    : Math.min(5_000 * 2 ** (throttleLevel - 1), 60_000);
  cooldownUntil = Math.max(cooldownUntil, Date.now() + backoff);
  return backoff;
}

/** Record a success so the throttle relaxes again. */
export function noteImageSuccess(): void {
  if (throttleLevel > 0) throttleLevel--;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function prune(now: number) {
  starts = starts.filter((t) => now - t < WINDOW_MS);
}

/** Milliseconds to wait before another request may start. 0 = go now. */
function waitFor(now: number): number {
  prune(now);
  if (now < cooldownUntil) return cooldownUntil - now;
  if (inFlight >= PER_KEY_CONCURRENCY) return 200;
  const sinceLast = now - lastStart;
  const gap = spacing();
  if (sinceLast < gap) return gap - sinceLast;
  if (starts.length >= IMAGE_RPM) {
    const oldest = starts[0] as number;
    return Math.max(50, WINDOW_MS - (now - oldest));
  }
  return 0;
}

/**
 * Leases a rate-limit slot for the duration of `fn` and hands it the API key.
 * Keeps the historical signature (`slot`, `attempt`) so callers are unchanged;
 * with a single key those only matter for logging.
 */
export async function withImageKey<T>(
  _slot: number,
  _attempt: number,
  fn: (key: string, keyIndex: number) => Promise<T>,
): Promise<T> {
  const key = agnesKey();
  // Wait for a free slot inside the 20 RPM budget.
  for (;;) {
    const wait = waitFor(Date.now());
    if (wait <= 0) break;
    await sleep(Math.min(wait, 1_000));
  }
  const now = Date.now();
  lastStart = now;
  starts.push(now);
  inFlight++;
  try {
    return await fn(key, 0);
  } finally {
    inFlight--;
  }
}

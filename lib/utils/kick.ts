/**
 * Reliable "fire-and-mostly-forget" dispatch for server→server handoffs
 * on Vercel.
 *
 * WHY: `void fetch(url)` right before a route returns is a lost letter —
 * Vercel freezes the function the moment the response is sent, and the
 * un-awaited request often never leaves. That's how multi-receipt scans
 * ended up as childless containers (27 Jul scan: analyze finished, the
 * job-start handoff evaporated, no receipts were ever spawned).
 *
 * kickAndForget AWAITS the fetch just long enough to guarantee dispatch
 * (the target function starts executing as soon as the request lands),
 * then aborts the response read. Aborting our read does NOT cancel the
 * remote invocation — it runs to completion on its own budget. Cost to
 * the caller: at most `graceMs`.
 *
 * Use `await kickAndForget(...)` — the await is the entire point.
 */
export async function kickAndForget(
  url: string,
  init: RequestInit,
  graceMs = 2500
): Promise<{ dispatched: boolean; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), graceMs);
  try {
    await fetch(url, { ...init, signal: controller.signal });
    // Response fully arrived within the grace window — even better.
    return { dispatched: true };
  } catch (e) {
    if (controller.signal.aborted) {
      // We aborted the READ after the request was sent — dispatch OK.
      return { dispatched: true };
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[kick] dispatch FAILED for ${url}: ${msg}`);
    return { dispatched: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

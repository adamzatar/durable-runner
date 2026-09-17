// Resolves after `ms`, or immediately if the signal is already aborted or
// aborts while waiting. Shared by every fixed-interval loop (worker poll,
// heartbeat, lease renewal, recovery sweep) so that shutdown can interrupt
// a wait instead of sitting out the full interval.
//
// Only the wait is interruptible. A database write already in flight when
// the signal aborts is not cancelled; each loop awaits it before returning.
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Graceful shutdown on SIGTERM and SIGINT.
 *
 * Aborts all in-flight turn controllers, gives them up to 5s to emit their
 * `session.status_idle{stop_reason:"interrupted"}` via the driver's normal
 * abort path, then exits. Sessions that don't finish in time will be picked
 * up by the next startup's stale-recovery path.
 */
import { getRuntime } from "./state";
import { markStopping } from "./sessions/sweeper";
import { syncDb, closeDb } from "./db/client";

type GlobalShutdown = typeof globalThis & {
  __caShutdownInstalled?: boolean;
  __caSweeperHandle?: NodeJS.Timeout;
  __caDeploymentSchedulerHandle?: NodeJS.Timeout;
};
const g = globalThis as GlobalShutdown;

export function installShutdownHandlers(): void {
  if (g.__caShutdownInstalled) return;
  g.__caShutdownInstalled = true;

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  // Last-resort backstop: a stray rejected promise (e.g. an exec watcher that
  // rejects after the driver moved on) must not terminate the gateway. Node's
  // default for unhandledRejection is to crash the process; log and carry on
  // instead. Individual call sites still handle their own rejections — this
  // only catches the ones that slip through. The log is throttled so a tight
  // rejection loop can't flood the log; the suppressed count keeps the
  // signal that something is rejecting repeatedly.
  let lastRejectionLogMs = 0;
  let suppressedRejections = 0;
  process.on("unhandledRejection", (reason) => {
    const now = Date.now();
    if (now - lastRejectionLogMs < 1000) {
      suppressedRejections++;
      return;
    }
    lastRejectionLogMs = now;
    if (suppressedRejections > 0) {
      console.error(`[unhandledRejection] (${suppressedRejections} similar suppressed in the last interval)`);
      suppressedRejections = 0;
    }
    console.error("[unhandledRejection]", reason);
  });
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    // Second signal — force exit immediately
    console.log(`[shutdown] forced exit`);
    process.exit(1);
  }
  shuttingDown = true;

  const rt = getRuntime();
  const inflight = rt.inFlightRuns.size;

  if (inflight > 0) {
    console.log(`[shutdown] stopping ${inflight} in-flight turn${inflight > 1 ? "s" : ""}...`);
  } else {
    console.log(`[shutdown] shutting down...`);
  }

  // Tell the sweeper to stop starting new eviction work, then clear the
  // interval. Any in-progress sweep finishes its current candidate and bails.
  markStopping();
  if (g.__caSweeperHandle) {
    clearInterval(g.__caSweeperHandle);
    g.__caSweeperHandle = undefined;
  }
  if (g.__caDeploymentSchedulerHandle) {
    clearInterval(g.__caDeploymentSchedulerHandle);
    g.__caDeploymentSchedulerHandle = undefined;
  }

  for (const run of rt.inFlightRuns.values()) {
    try {
      run.controller.abort(new DOMException("shutting down", "AbortError"));
    } catch {
      /* ignore */
    }
  }

  // Give drivers a moment to append their idle-interrupted events
  if (inflight > 0) {
    await new Promise((r) => setTimeout(r, 5000));
  }

  // Sync embedded replica to Turso and close the DB cleanly
  syncDb();
  closeDb();

  process.exit(0);
}

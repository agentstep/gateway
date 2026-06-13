/**
 * Explicit runtime — construct and tear down the engine as a value.
 *
 *   const runtime = await createRuntime({ db: { path: "./data/app.db" } });
 *   const client = createClient({ apiKey });
 *   ...
 *   await runtime.close();
 *
 * This is the embedding and test-isolation surface: where tests used to
 * hand-delete nine globalThis singletons, they now create and close a
 * runtime. Transitional constraint (documented in docs/sdk-plan.md):
 * engine state still lives in process-wide singletons underneath, so
 * **one runtime per process at a time** — `createRuntime` throws if one
 * is already open. Full instance isolation (two concurrent runtimes)
 * lands when the service layer finishes migrating off the singletons.
 */
import { ensureInitialized } from "./init";
import { closeDb } from "./db/client";
import { registerTurnMiddleware, type TurnMiddleware } from "./sessions/turn-pipeline";

export interface RuntimeConfig {
  db?: {
    /** SQLite database path (sets DATABASE_PATH for this runtime). */
    path?: string;
  };
  /** Global turn concurrency (0 parks the queue — useful in tests). */
  concurrency?: number;
  /** Default container provider (docker, sprites, ...). */
  defaultProvider?: string;
  /** Turn middleware registered for the runtime's lifetime. */
  turnMiddleware?: TurnMiddleware[];
  /**
   * Skip ensureInitialized() (migrations, seeding, sweeper/scheduler
   * timers). Handlers still init on first request; use this when
   * embedding somewhere that must not start background timers.
   */
  deferInit?: boolean;
}

export interface Runtime {
  /** Tear down: stop timers, unregister middleware, close the DB, clear engine state. */
  close(): Promise<void>;
}

type RuntimeGlobals = typeof globalThis & {
  __caRuntimeOpen?: boolean;
  __caDb?: unknown;
  __caDrizzle?: unknown;
  __caInitialized?: unknown;
  __caInitPromise?: unknown;
  __caBusEmitters?: unknown;
  __caConfigCache?: unknown;
  __caRuntime?: unknown;
  __caSweeperHandle?: NodeJS.Timeout;
  __caDeploymentsHandle?: NodeJS.Timeout;
  __caActors?: unknown;
};

/** Reset all engine singletons. The public form of the test-suite ritual. */
export function resetEngineState(): void {
  const g = globalThis as RuntimeGlobals;
  if (g.__caSweeperHandle) {
    clearInterval(g.__caSweeperHandle);
    delete g.__caSweeperHandle;
  }
  if (g.__caDeploymentsHandle) {
    clearInterval(g.__caDeploymentsHandle);
    delete g.__caDeploymentsHandle;
  }
  try {
    closeDb();
  } catch { /* not open */ }
  delete g.__caDb;
  delete g.__caDrizzle;
  delete g.__caInitialized;
  delete g.__caInitPromise;
  delete g.__caBusEmitters;
  delete g.__caConfigCache;
  delete g.__caRuntime;
  delete g.__caActors;
}

export async function createRuntime(config: RuntimeConfig = {}): Promise<Runtime> {
  const g = globalThis as RuntimeGlobals;
  if (g.__caRuntimeOpen) {
    throw new Error(
      "a runtime is already open in this process — close() it first (one runtime per process until instance isolation lands)",
    );
  }

  if (config.db?.path) process.env.DATABASE_PATH = config.db.path;
  if (config.concurrency !== undefined) process.env.CONCURRENCY = String(config.concurrency);
  if (config.defaultProvider !== undefined) process.env.DEFAULT_PROVIDER = config.defaultProvider;

  const unregisters = (config.turnMiddleware ?? []).map((fn) => registerTurnMiddleware(fn));

  if (!config.deferInit) {
    await ensureInitialized();
  }
  g.__caRuntimeOpen = true;

  let closed = false;
  return {
    async close() {
      if (closed) return;
      closed = true;
      for (const off of unregisters) off();
      resetEngineState();
      delete g.__caRuntimeOpen;
    },
  };
}

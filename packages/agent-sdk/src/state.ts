/**
 * Global mutable runtime state — HMR-safe via globalThis so Next.js dev
 * reloads don't duplicate maps.
 */

export interface InFlightRun {
  sessionId: string;
  controller: AbortController;
  startedAt: number;
}

export type TurnInput =
  | { kind: "text"; eventId: string; text: string }
  | {
      kind: "tool_result";
      eventId: string;
      custom_tool_use_id: string;
      content: unknown[];
    };

export interface PendingUserInput {
  sessionId: string;
  input: TurnInput;
}

type RuntimeState = {
  inFlightRuns: Map<string, InFlightRun>;
  pendingUserInputs: Map<string, TurnInput[]>;
  /**
   * Sessions for which a turn has been scheduled but has not yet registered
   * in `inFlightRuns` (the sandbox-acquire window can be tens of seconds).
   * `inFlightRuns` alone is set too late to stop a second POST that arrives
   * during acquire from launching a concurrent turn, so the events handler
   * marks the session here synchronously the instant it decides to run.
   */
  startingTurns: Set<string>;
};

type GlobalState = typeof globalThis & {
  __caRuntime?: RuntimeState;
};

export function getRuntime(): RuntimeState {
  const g = globalThis as GlobalState;
  if (!g.__caRuntime) {
    g.__caRuntime = {
      inFlightRuns: new Map(),
      pendingUserInputs: new Map(),
      startingTurns: new Set(),
    };
  }
  return g.__caRuntime;
}

/** Mark a session as having a turn scheduled (covers the acquire window). */
export function markTurnStarting(sessionId: string): void {
  getRuntime().startingTurns.add(sessionId);
}

/** Clear the scheduled-turn marker (called once the turn fully settles). */
export function clearTurnStarting(sessionId: string): void {
  getRuntime().startingTurns.delete(sessionId);
}

/**
 * True if a turn is running or about to run for this session. Authoritative
 * "is the session busy?" signal — combines the in-flight map with the
 * pre-registration marker so callers don't race the acquire window.
 */
export function isTurnActive(sessionId: string): boolean {
  const rt = getRuntime();
  return rt.inFlightRuns.has(sessionId) || rt.startingTurns.has(sessionId);
}

export function pushPendingUserInput(input: PendingUserInput): void {
  const rt = getRuntime();
  const list = rt.pendingUserInputs.get(input.sessionId) ?? [];
  list.push(input.input);
  rt.pendingUserInputs.set(input.sessionId, list);
}

export function drainPendingUserInputs(sessionId: string): TurnInput[] {
  const rt = getRuntime();
  const list = rt.pendingUserInputs.get(sessionId) ?? [];
  rt.pendingUserInputs.delete(sessionId);
  return list;
}

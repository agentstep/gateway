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
   *
   * The value is an ownership epoch (see {@link markTurnStarting}): a turn's
   * cleanup may only clear the marker it set, never a successor's. runTurn's
   * inner paths drain queued input (marking the session for the NEXT turn)
   * before the wrapper's finally runs — an unconditional clear there would
   * delete the successor's marker during its pre-registration window.
   */
  startingTurns: Map<string, number>;
  /** Monotonic source for startingTurns epochs — never reused, so a stale
   * clear can't collide with a later mark. */
  nextTurnEpoch: number;
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
      startingTurns: new Map(),
      nextTurnEpoch: 1,
    };
  }
  return g.__caRuntime;
}

/**
 * Mark a session as having a turn scheduled (covers the acquire window).
 * Returns the marker's ownership epoch — pass it to {@link clearTurnStarting}
 * so cleanup can't clobber a marker set later for a successor turn.
 */
export function markTurnStarting(sessionId: string): number {
  const rt = getRuntime();
  const epoch = rt.nextTurnEpoch++;
  rt.startingTurns.set(sessionId, epoch);
  return epoch;
}

/**
 * Clear the scheduled-turn marker, but only if `epoch` still owns it.
 * `undefined` means "no marker existed when this turn entered" — any marker
 * present now belongs to a successor, so the call is a no-op.
 */
export function clearTurnStarting(sessionId: string, epoch: number | undefined): void {
  const rt = getRuntime();
  if (epoch !== undefined && rt.startingTurns.get(sessionId) === epoch) {
    rt.startingTurns.delete(sessionId);
  }
}

/**
 * The epoch of the session's current scheduled-turn marker, if any. runTurn's
 * wrapper snapshots this synchronously at entry — that marker (set by the
 * scheduler that launched it) is the one its finally is allowed to clear.
 */
export function getTurnStartingEpoch(sessionId: string): number | undefined {
  return getRuntime().startingTurns.get(sessionId);
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

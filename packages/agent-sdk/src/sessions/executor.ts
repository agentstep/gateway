/**
 * Turn executor — the seam between the driver and where a turn's harness
 * actually runs.
 *
 * Today there is exactly one implementation: `ContainerExecutor`, which
 * launches the backend CLI's wrapper inside the session's container via
 * the provider. The interface exists so a future executor (e.g. a
 * container-free "lite" tier that runs an in-process loop) plugs in at a
 * named boundary instead of a driver rewrite — the driver owns
 * translation, retries, and settlement either way.
 */
import type { ContainerProvider, ExecOptions, ExecSession } from "../providers/types";

export interface TurnExecutor {
  /** Human-readable name for logs and traces. */
  readonly kind: string;
  /** Whether stdout needs control-char stripping (provider-specific framing). */
  readonly stripControlChars: boolean;
  /** Launch one turn's process/loop against the execution target. */
  start(target: string, opts: ExecOptions): Promise<ExecSession>;
}

/** Runs the backend CLI wrapper inside the session's container. */
export class ContainerExecutor implements TurnExecutor {
  readonly kind = "container";

  constructor(private readonly provider: ContainerProvider) {}

  get stripControlChars(): boolean {
    return this.provider.stripControlChars;
  }

  start(target: string, opts: ExecOptions): Promise<ExecSession> {
    return this.provider.startExec(target, opts);
  }
}

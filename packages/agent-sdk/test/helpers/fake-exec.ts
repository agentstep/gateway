/**
 * In-process fake of `containers/exec.startExec` (formerly `sprite/exec`)
 * for deterministic driver tests. Tests enqueue scripted NDJSON turns ahead
 * of time; each `startExec` call consumes one turn from the queue, streams
 * it as if it came from claude, and resolves `exit` with code 0.
 *
 * Usage:
 *
 *   vi.mock("../../src/containers/exec", async () => {
 *     const fake = await import("./helpers/fake-exec");
 *     return { startExec: fake.startExec };
 *   });
 *
 *   // in test body
 *   fake.enqueueTurn({ ndjson: [...], onStdin: (body) => capture = body });
 *   await runTurn(sessionId, [...]);
 */
import type { ExecSession } from "../../src/containers/exec";

export interface FakeTurn {
  ndjson: string[];
  /** Invoked with the stdin body the driver passed in. */
  onStdin?: (body: string) => void;
  /** Invoked with the argv the driver passed in (wrapper path + backend args). */
  onArgv?: (argv: string[]) => void;
  /** Keep the stream open until the driver's abort signal fires, then error
   * it — mimics sprites' HTTP exec, whose read loop throws on interrupt. */
  hangUntilAbort?: boolean;
}

const queue: FakeTurn[] = [];

export function enqueueTurn(turn: FakeTurn): void {
  queue.push(turn);
}

export function resetQueue(): void {
  queue.length = 0;
}

export async function startExec(
  _sandboxName: string,
  opts: { argv: string[]; stdin?: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<ExecSession> {
  const turn = queue.shift();
  if (!turn) {
    throw new Error("fake-exec: no scripted turn queued");
  }
  turn.onStdin?.(opts.stdin ?? "");
  turn.onArgv?.(opts.argv);

  const body = turn.ndjson.join("\n") + "\n";
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (turn.ndjson.length > 0) controller.enqueue(encoder.encode(body));
      if (!turn.hangUntilAbort) {
        controller.close();
        return;
      }
      // Hold the stream open; error it when the driver aborts (sprites-style).
      const fail = (): void => {
        try {
          controller.error(new Error("fake-exec: aborted"));
        } catch {
          /* already closed */
        }
      };
      if (opts.signal?.aborted) fail();
      else opts.signal?.addEventListener("abort", fail, { once: true });
    },
  });

  return {
    stdout: stream,
    exit: Promise.resolve({ code: 0 }),
    async kill() {
      /* no-op */
    },
  };
}

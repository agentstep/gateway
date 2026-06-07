/**
 * Container provider abstraction.
 *
 * Every sandbox backend implements this interface — local runtimes
 * (sprites.dev, docker, podman, apple-container, mvm) and cloud sandboxes
 * (e2b, vercel, daytona, fly, modal, cloudflare), plus the no-op anthropic
 * managed-agents proxy. The driver, lifecycle, and backend setup code call
 * these methods instead of any provider's native API directly. The provider
 * is selected per-environment via `EnvironmentConfig.provider`.
 *
 * Cloud providers accept an optional `secrets` param on methods that
 * need credentials. Precedence: secrets > process.env > error.
 * Vault secrets are resolved per-session and passed by the lifecycle/driver.
 */

export type ProviderName = "sprites" | "docker" | "apple-container" | "apple-firecracker" | "podman" | "e2b" | "vercel" | "daytona" | "fly" | "modal" | "mvm" | "anthropic" | "cloudflare";

/** Optional provider credential overrides from vault secrets. */
export type ProviderSecrets = Record<string, string>;

/**
 * Thrown when a provider's backing sandbox no longer exists (e.g. sprites.dev
 * returns 404 "sprite not found" — the container was reaped upstream while
 * the gateway's pool entry was still cached). Callers catch this to drop the
 * stale pool entry and re-acquire a fresh container.
 */
export class ContainerGone extends Error {
  readonly sandboxName: string;
  constructor(sandboxName: string, message?: string) {
    super(message ?? `container ${sandboxName} no longer exists upstream`);
    this.name = "ContainerGone";
    this.sandboxName = sandboxName;
  }
}

export interface ExecOptions {
  argv: string[];
  stdin?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  secrets?: ProviderSecrets;
}

export interface ExecResult {
  code: number;
}

export interface ExecSession {
  /** Raw streamed stdout bytes */
  stdout: ReadableStream<Uint8Array>;
  /** Resolves when the process exits */
  exit: Promise<ExecResult>;
  /** Best-effort kill — aborts the process */
  kill(): Promise<void>;
}

export interface AvailabilityResult {
  available: boolean;
  message?: string;
}

export interface ContainerProvider {
  name: ProviderName;

  /**
   * Whether this provider supports the warm container pool.
   * Warm pool creation is skipped silently when this is false/undefined.
   * Set to true for local/persistent providers (docker, sprites, apple-container, podman).
   */
  supportsWarmPool?: boolean;

  /** Pre-flight check: is this provider usable right now?
   *  Secrets are available at turn-time (not env creation time).
   *  Returns { available: true } or { available: false, message: "..." }.
   *  Optional — providers that don't implement it are assumed available. */
  checkAvailability?(secrets?: ProviderSecrets): Promise<AvailabilityResult>;

  /** Create and start a new container */
  create(opts: { name: string; secrets?: ProviderSecrets }): Promise<void>;
  /** Force-remove a container (best-effort, does not throw on missing) */
  delete(name: string, secrets?: ProviderSecrets): Promise<void>;
  /** List containers matching an optional prefix (flat, no pagination) */
  list(opts?: { prefix?: string }): Promise<Array<{ name: string }>>;

  /**
   * One-shot execution: run argv in a container and wait for exit.
   * Used by backend setup (install wrapper, install CLI, etc.)
   */
  exec(
    name: string,
    argv: string[],
    opts?: { stdin?: string; timeoutMs?: number; secrets?: ProviderSecrets },
  ): Promise<{ stdout: string; stderr: string; exit_code: number }>;

  /**
   * Streaming execution: run argv in a container and stream stdout.
   * Used by the turn driver for CLI output.
   */
  startExec(name: string, opts: ExecOptions): Promise<ExecSession>;

  /**
   * Whether to strip control chars from stdout. True for sprites.dev
   * (HTTP multiplexing framing bytes), false for Docker.
   */
  stripControlChars: boolean;
}

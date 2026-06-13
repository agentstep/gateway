/**
 * Service layer — the SDK's business logic, decoupled from HTTP.
 * Handlers are codecs over these functions; the client's local transport
 * migrates to them as extraction completes (sessions/events next).
 */
export * from "./agents";
export * from "./environments";
export * from "./vaults";

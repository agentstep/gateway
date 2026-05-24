/**
 * Google Interactions API compatibility layer.
 * Routes registered at /google/v1beta/* in server adapters.
 */
export { handleCreateInteraction } from "./interactions";
export type { InteractionResponse, CreateInteractionRequest } from "./types";

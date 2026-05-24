/**
 * Google Interactions API compatibility layer.
 * Routes registered at /google/v1beta/* in server adapters.
 */
export { handleCreateInteraction, handleGetInteraction, handleDeleteInteraction, handleCancelInteraction } from "./interactions";
export { handleCreateGoogleAgent, handleListGoogleAgents, handleGetGoogleAgent, handleDeleteGoogleAgent } from "./agents";
export { handleGetEnvironmentFiles } from "./files";
export type { InteractionResponse, CreateInteractionRequest } from "./types";

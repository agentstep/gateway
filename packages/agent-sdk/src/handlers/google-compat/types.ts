/**
 * Google Interactions API type definitions.
 */

export interface CreateInteractionRequest {
  model?: string;
  agent?: string;
  input: string | unknown[];
  system_instruction?: string;
  tools?: unknown[];
  generation_config?: Record<string, unknown>;
  previous_interaction_id?: string;
  environment?: string | { type: string; sources?: unknown[]; network?: unknown };
  stream?: boolean;
}

export interface InteractionResponse {
  id: string;
  model?: string;
  agent?: string;
  created: string;
  updated: string;
  status: "in_progress" | "requires_action" | "completed" | "failed" | "cancelled";
  steps: InteractionStep[];
  usage: InteractionUsage;
  environment_id?: string;
  previous_interaction_id?: string;
}

export interface InteractionStep {
  type: string;
  [key: string]: unknown;
}

export interface InteractionUsage {
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
}

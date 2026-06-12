/**
 * Backend resolution — both modes are the SDK's programmatic client
 * (`createClient`): in-process handler dispatch for local mode, HTTP for
 * remote. The CLI is just the first consumer of the public client.
 */
import type { Backend } from "./interface.js";
import { createClient, type AgentStepClient } from "@agentstep/agent-sdk/client";
import { initForCli } from "../lifecycle.js";

function toBackend(client: AgentStepClient, init: () => Promise<void>): Backend {
  return {
    init,
    agents: client.agents,
    environments: client.environments,
    sessions: client.sessions,
    events: client.events,
    vaults: client.vaults,
    memory: client.memory,
    batch: client.batch,
    skills: client.skills,
    providers: client.providers,
  };
}

export function resolveBackend(opts: { remote?: string; apiKey?: string }): Backend {
  if (opts.remote) {
    if (!opts.apiKey) {
      throw new Error("API key required for remote mode. Set GATEWAY_API_KEY or run \"gateway config set api-key <key>\"");
    }
    return toBackend(createClient({ baseUrl: opts.remote, apiKey: opts.apiKey }), async () => {});
  }
  return toBackend(createClient(), async () => {
    await initForCli();
  });
}

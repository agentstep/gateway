/**
 * Backend resolution — both modes are the SDK's programmatic client
 * (`createGateway`): in-process handler dispatch for local mode, HTTP for
 * remote. The CLI is just the first consumer of the public client.
 */
import type { Backend } from "./interface.js";
import { createGateway, type GatewayClient } from "@agentstep/agent-sdk/client";
import { initForCli } from "../lifecycle.js";

function toBackend(gw: GatewayClient, init: () => Promise<void>): Backend {
  return {
    init,
    agents: gw.agents,
    environments: gw.environments,
    sessions: gw.sessions,
    events: gw.events,
    vaults: gw.vaults,
    memory: gw.memory,
    batch: gw.batch,
    skills: gw.skills,
    providers: gw.providers,
  };
}

export function resolveBackend(opts: { remote?: string; apiKey?: string }): Backend {
  if (opts.remote) {
    if (!opts.apiKey) {
      throw new Error("API key required for remote mode. Set GATEWAY_API_KEY or run \"gateway config set api-key <key>\"");
    }
    return toBackend(createGateway({ baseUrl: opts.remote, apiKey: opts.apiKey }), async () => {});
  }
  return toBackend(createGateway(), async () => {
    await initForCli();
  });
}

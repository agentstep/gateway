/**
 * Chat stream endpoint — POST /v1/sessions/:id/chat
 *
 * Accepts the de-facto chat-frontend request shape ({messages: [...]}),
 * posts the last user message to the session, and streams the resulting
 * turn back as a UI message stream (SSE frames: start, text-*,
 * reasoning-*, tool-input/output-available, finish, [DONE]). Any
 * standard chat frontend can point at a gateway session — any harness —
 * with zero translation on its side.
 *
 * Frame mapping from the gateway's event union:
 *   agent.message   → text-start / text-delta / text-end
 *   agent.thinking  → reasoning-start / reasoning-delta / reasoning-end
 *   agent.tool_use / agent.mcp_tool_use / agent.custom_tool_use
 *                   → tool-input-available
 *   agent.tool_result / agent.mcp_tool_result
 *                   → tool-output-available
 *   session.error   → error
 *   session.status_idle / _terminated → finish + [DONE], stream closes
 */
import { z } from "zod";
import { routeWrap } from "../http";
import { badRequest, notFound } from "../errors";
import { getSession, getSessionRow } from "../db/sessions";
import { appendEvent, subscribe } from "../sessions/bus";
import { getActor } from "../sessions/actor";
import { startTurn } from "../sessions/kickoff";
import { isTurnActive, pushPendingUserInput, type TurnInput } from "../state";
import { newId } from "../util/ids";

const MessagePart = z.object({ type: z.string(), text: z.string().optional() }).passthrough();
const ChatMessage = z.object({
  role: z.string(),
  content: z.string().optional(),
  parts: z.array(MessagePart).optional(),
}).passthrough();
const ChatSchema = z.object({ messages: z.array(ChatMessage).min(1) }).passthrough();

function lastUserText(messages: z.infer<typeof ChatSchema>["messages"]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string" && m.content.length > 0) return m.content;
    const text = (m.parts ?? [])
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
    return text || null;
  }
  return null;
}

const sse = (frame: unknown) => `data: ${JSON.stringify(frame)}\n\n`;

export function handleSessionChat(request: Request, sessionId: string): Promise<Response> {
  return routeWrap(request, async () => {
    const session = getSession(sessionId);
    if (!session) throw notFound(`session not found: ${sessionId}`);

    const body = await request.json().catch(() => null);
    const parsed = ChatSchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);
    const text = lastUserText(parsed.data.messages);
    if (!text) throw badRequest("no user message with text content found in messages");

    // Append the user message via the session actor; collect the turn input.
    const actor = getActor(sessionId);
    const { row, input } = await actor.enqueue(async () => {
      const row = appendEvent(sessionId, {
        type: "user.message",
        payload: { content: [{ type: "text", text }] },
        origin: "user",
        processedAt: null,
      });
      return { row, input: { kind: "text", eventId: row.id, text } as TurnInput };
    });

    // Kick off the turn unless one is already active (then it queues).
    const status = getSessionRow(sessionId)?.status ?? "idle";
    if (status === "running" || isTurnActive(sessionId)) {
      pushPendingUserInput({ sessionId, input });
    } else {
      await startTurn(sessionId, session.environment_id, [input]);
    }

    const encoder = new TextEncoder();
    const afterSeq = row.seq;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (frame: unknown) => controller.enqueue(encoder.encode(sse(frame)));
        send({ type: "start" });

        const finish = () => {
          send({ type: "finish" });
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          sub.unsubscribe();
          clearInterval(ping);
          controller.close();
        };

        const ping = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            clearInterval(ping);
          }
        }, 15_000);

        const sub = subscribe(sessionId, afterSeq, (evt) => {
          try {
            const e = evt as Record<string, unknown>;
            switch (evt.type) {
              case "agent.message": {
                const content = (e.content as Array<{ type: string; text?: string }>) ?? [];
                const textOut = content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
                if (textOut) {
                  const id = newId("evt");
                  send({ type: "text-start", id });
                  send({ type: "text-delta", id, delta: textOut });
                  send({ type: "text-end", id });
                }
                break;
              }
              case "agent.thinking": {
                const content = (e.content as Array<{ type: string; thinking?: string }>) ?? [];
                const thinking = content.map((b) => b.thinking ?? "").join("");
                if (thinking) {
                  const id = newId("evt");
                  send({ type: "reasoning-start", id });
                  send({ type: "reasoning-delta", id, delta: thinking });
                  send({ type: "reasoning-end", id });
                }
                break;
              }
              case "agent.tool_use":
              case "agent.custom_tool_use":
                send({
                  type: "tool-input-available",
                  toolCallId: e.tool_use_id,
                  toolName: e.name,
                  input: e.input ?? {},
                });
                break;
              case "agent.mcp_tool_use":
                send({
                  type: "tool-input-available",
                  toolCallId: e.tool_use_id,
                  toolName: `${e.server_name as string}.${e.tool_name as string}`,
                  input: e.input ?? {},
                });
                break;
              case "agent.tool_result":
              case "agent.mcp_tool_result":
                send({
                  type: "tool-output-available",
                  toolCallId: e.tool_use_id,
                  output: e.content ?? null,
                });
                break;
              case "session.error": {
                const err = e.error as { message?: string } | undefined;
                send({ type: "error", errorText: err?.message ?? "unknown error" });
                break;
              }
              case "session.status_idle":
              case "session.status_terminated":
                finish();
                break;
            }
          } catch {
            // Consumer went away mid-frame — tear down.
            sub.unsubscribe();
            clearInterval(ping);
          }
        });

        // If the session settled between the POST landing and the
        // subscription attaching, subscribe()'s backlog replay already
        // delivered the idle event and finish() ran.
      },
      cancel() {
        // Consumer disconnected — subscription cleanup happens in finish()
        // or the catch above on next event.
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  });
}

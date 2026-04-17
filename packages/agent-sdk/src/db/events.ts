import { eq, and, gt, asc, desc, isNull } from "drizzle-orm";
import { getDb } from "./client";
import { getDrizzle, schema } from "./drizzle";
import { newId } from "../util/ids";
import { nowMs, toIso } from "../util/clock";
import type { EventOrigin, EventRow, ManagedEvent } from "../types";

export interface AppendInput {
  type: string;
  payload: Record<string, unknown>;
  origin: EventOrigin;
  idempotencyKey?: string | null;
  processedAt?: number | null;
  /** OTel-style trace id — every event in one top-level run shares it. */
  traceId?: string | null;
  /** Span the event belongs to. On span.*_start/_end this is the boundary. */
  spanId?: string | null;
  /** Only meaningful on span.*_start events. */
  parentSpanId?: string | null;
}

/**
 * Append an event to a session's log inside an IMMEDIATE transaction.
 *
 * Reserves the next sequence number by reading `sessions.last_seq` and
 * updating it atomically. Honors the partial-unique idempotency_key index —
 * if a matching key already exists for this session, the existing row is
 * returned and no new row is inserted.
 *
 * NOTE: this function does NOT emit on the bus. The caller (typically
 * `lib/sessions/bus.ts`) is responsible for post-commit fan-out, so that
 * the order "commit first, then emit" is guaranteed.
 *
 * Uses raw getDb() to preserve the IMMEDIATE transaction semantics required
 * for the seq counter atomicity and idempotency-key deduplication.
 */
export function appendEvent(sessionId: string, input: AppendInput): EventRow {
  const db = getDb();

  return db.transaction(() => {
    if (input.idempotencyKey) {
      const dupe = db
        .prepare(
          `SELECT * FROM events WHERE session_id = ? AND idempotency_key = ?`,
        )
        .get(sessionId, input.idempotencyKey) as EventRow | undefined;
      if (dupe) return dupe;
    }

    const row = db
      .prepare(
        `SELECT last_seq FROM sessions WHERE id = ?`,
      )
      .get(sessionId) as { last_seq: number } | undefined;
    if (!row) throw new Error(`session not found: ${sessionId}`);

    const seq = row.last_seq + 1;
    const id = newId("evt");
    const receivedAt = nowMs();

    db.prepare(
      `INSERT INTO events (
         id, session_id, seq, type, payload_json,
         processed_at, received_at, origin, idempotency_key,
         trace_id, span_id, parent_span_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      sessionId,
      seq,
      input.type,
      JSON.stringify(input.payload),
      input.processedAt ?? null,
      receivedAt,
      input.origin,
      input.idempotencyKey ?? null,
      input.traceId ?? null,
      input.spanId ?? null,
      input.parentSpanId ?? null,
    );

    db.prepare(`UPDATE sessions SET last_seq = ?, updated_at = ? WHERE id = ?`).run(
      seq,
      receivedAt,
      sessionId,
    );

    return {
      id,
      session_id: sessionId,
      seq,
      type: input.type,
      payload_json: JSON.stringify(input.payload),
      processed_at: input.processedAt ?? null,
      received_at: receivedAt,
      origin: input.origin,
      idempotency_key: input.idempotencyKey ?? null,
      trace_id: input.traceId ?? null,
      span_id: input.spanId ?? null,
      parent_span_id: input.parentSpanId ?? null,
    };
  })();
}

/**
 * Append multiple events in a single transaction. Returns the inserted rows
 * in input order. Same idempotency semantics per row.
 *
 * The `last_seq` counter is read ONCE at the start of the transaction and
 * incremented in-memory across the batch — an earlier version re-read
 * `sessions.last_seq` for every row, which is O(N) SELECTs on the hot
 * NDJSON stream path.
 *
 * Uses raw getDb() to preserve the IMMEDIATE transaction semantics required
 * for the seq counter atomicity and idempotency-key deduplication.
 */
export function appendEventsBatch(sessionId: string, inputs: AppendInput[]): EventRow[] {
  const db = getDb();

  return db.transaction(() => {
    const rows: EventRow[] = [];

    // Read last_seq once per transaction and track it in memory.
    const cur = db
      .prepare(`SELECT last_seq FROM sessions WHERE id = ?`)
      .get(sessionId) as { last_seq: number } | undefined;
    if (!cur) throw new Error(`session not found: ${sessionId}`);
    let seq = cur.last_seq;

    const dupeStmt = db.prepare(
      `SELECT * FROM events WHERE session_id = ? AND idempotency_key = ?`,
    );
    const insertStmt = db.prepare(
      `INSERT INTO events (
         id, session_id, seq, type, payload_json,
         processed_at, received_at, origin, idempotency_key,
         trace_id, span_id, parent_span_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const input of inputs) {
      if (input.idempotencyKey) {
        const dupe = dupeStmt.get(sessionId, input.idempotencyKey) as
          | EventRow
          | undefined;
        if (dupe) {
          rows.push(dupe);
          continue;
        }
      }

      seq += 1;
      const id = newId("evt");
      const receivedAt = nowMs();

      insertStmt.run(
        id,
        sessionId,
        seq,
        input.type,
        JSON.stringify(input.payload),
        input.processedAt ?? null,
        receivedAt,
        input.origin,
        input.idempotencyKey ?? null,
        input.traceId ?? null,
        input.spanId ?? null,
        input.parentSpanId ?? null,
      );

      rows.push({
        id,
        session_id: sessionId,
        seq,
        type: input.type,
        payload_json: JSON.stringify(input.payload),
        processed_at: input.processedAt ?? null,
        received_at: receivedAt,
        origin: input.origin,
        idempotency_key: input.idempotencyKey ?? null,
        trace_id: input.traceId ?? null,
        span_id: input.spanId ?? null,
        parent_span_id: input.parentSpanId ?? null,
      });
    }

    // Single trailing update for the session's seq counter.
    if (seq !== cur.last_seq) {
      db.prepare(`UPDATE sessions SET last_seq = ?, updated_at = ? WHERE id = ?`).run(
        seq,
        nowMs(),
        sessionId,
      );
    }

    return rows;
  })();
}

export function markUserEventProcessed(eventId: string, when: number): void {
  const db = getDrizzle();
  db.update(schema.events)
    .set({ processed_at: when })
    .where(eq(schema.events.id, eventId))
    .run();
}

export function listEvents(
  sessionId: string,
  opts: {
    limit?: number;
    order?: "asc" | "desc";
    afterSeq?: number;
  },
): EventRow[] {
  const db = getDrizzle();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const orderDir = opts.order === "desc" ? "desc" : "asc";
  const afterSeq = opts.afterSeq ?? 0;

  const orderClause = orderDir === "desc" ? desc(schema.events.seq) : asc(schema.events.seq);

  return db
    .select()
    .from(schema.events)
    .where(
      and(
        eq(schema.events.session_id, sessionId),
        gt(schema.events.seq, afterSeq),
      ),
    )
    .orderBy(orderClause)
    .limit(limit)
    .all() as EventRow[];
}

export function getLastUnprocessedUserMessage(sessionId: string): EventRow | null {
  const db = getDrizzle();
  return (
    (db
      .select()
      .from(schema.events)
      .where(
        and(
          eq(schema.events.session_id, sessionId),
          eq(schema.events.type, "user.message"),
          isNull(schema.events.processed_at),
        ),
      )
      .orderBy(desc(schema.events.seq))
      .limit(1)
      .get() as EventRow | undefined) ?? null
  );
}

/**
 * Fetch every event that shares a trace_id, ordered by (session_id, seq).
 *
 * Cross-session: sub-agent threads inherit their parent's trace_id, so a
 * single trace scan returns the full waterfall including spawned children.
 */
export function listEventsByTrace(traceId: string, limit = 2000): EventRow[] {
  const db = getDrizzle();
  return db
    .select()
    .from(schema.events)
    .where(eq(schema.events.trace_id, traceId))
    .orderBy(
      asc(schema.events.received_at),
      asc(schema.events.session_id),
      asc(schema.events.seq),
    )
    .limit(Math.min(Math.max(limit, 1), 10000))
    .all() as EventRow[];
}

export function rowToManagedEvent(row: EventRow): ManagedEvent {
  const { type: _rawType, ...payload } = JSON.parse(row.payload_json) as Record<string, unknown>;
  const base: ManagedEvent = {
    id: row.id,
    seq: row.seq,
    session_id: row.session_id,
    type: row.type,
    processed_at: row.processed_at != null ? toIso(row.processed_at) : null,
    ...payload,
  };
  if (row.trace_id != null) base.trace_id = row.trace_id;
  if (row.span_id != null) base.span_id = row.span_id;
  if (row.parent_span_id != null) base.parent_span_id = row.parent_span_id;
  return base;
}

/**
 * Trace aggregation queries.
 *
 * These use GROUP BY + aggregations that don't map cleanly to Drizzle's
 * query builder, so they use Drizzle's `sql` tagged template with the
 * getDrizzle() instance (no raw getDb()).
 */
import { sql } from "drizzle-orm";
import { getDrizzle } from "./drizzle";

export interface TraceListRow {
  trace_id: string;
  start_ms: number;
  end_ms: number;
  event_count: number;
  session_count: number;
  first_session_id: string;
}

export function listTraces(opts: { sessionId?: string; limit: number }): TraceListRow[] {
  const db = getDrizzle();
  const { sessionId, limit } = opts;

  if (sessionId) {
    return db.all(sql`
      SELECT trace_id,
             MIN(received_at)           AS start_ms,
             MAX(received_at)           AS end_ms,
             COUNT(*)                   AS event_count,
             COUNT(DISTINCT session_id) AS session_count,
             MIN(session_id)            AS first_session_id
      FROM events
      WHERE trace_id IS NOT NULL AND session_id = ${sessionId}
      GROUP BY trace_id
      ORDER BY end_ms DESC
      LIMIT ${limit}
    `) as TraceListRow[];
  }

  return db.all(sql`
    SELECT trace_id,
           MIN(received_at)           AS start_ms,
           MAX(received_at)           AS end_ms,
           COUNT(*)                   AS event_count,
           COUNT(DISTINCT session_id) AS session_count,
           MIN(session_id)            AS first_session_id
    FROM events
    WHERE trace_id IS NOT NULL
    GROUP BY trace_id
    ORDER BY end_ms DESC
    LIMIT ${limit}
  `) as TraceListRow[];
}

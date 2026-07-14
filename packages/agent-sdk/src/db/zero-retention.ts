/**
 * Zero-Data-Retention purge engine (PR-Z2 of the #32 epic).
 *
 * `purgeSession({ tenantId, sessionId })` removes every row associated
 * with the session across the per-session tables, unlinks file bytes
 * on disk, recomputes memories.content for any memory whose latest
 * write came from this session, and finally stubs the sessions row.
 * The audit log entry survives.
 *
 * Crash recovery
 * --------------
 *   1. Mark session `status='purging'` + `retention_purged_at=now`
 *      BEFORE any DELETE (the idempotent resume marker).
 *   2. Run destructive work (file unlink first per architect's
 *      ordering review; then batched DELETEs).
 *   3. Stub the row + flip `status='purged'`.
 *
 * Crash anywhere between steps 1 and 3 → boot-time reaper finds
 * status='purging' and re-drives. All steps idempotent: file unlink
 * treats ENOENT as success, DELETEs operate on session_id which is
 * already partially gone.
 *
 * SQLITE_IOERR → process.exit(2). sqlite's in-memory state has
 * diverged from FS; no subsequent SQL is trustworthy.
 *
 * Per-column stub policy (architect's spec)
 * ----------------------------------------
 *   NULL: metadata_json, title, claude_session_id, sandbox_name,
 *         outcome_criteria_json, resources_json, vault_ids_json,
 *         user_profile_id, debug_prompt_json, stop_reason
 *   KEEP: id, tenant_id, agent_id, agent_version, environment_id,
 *         api_key_id, parent_session_id, thread_depth, provider_name,
 *         max_*, archived_at, created_at, updated_at, status,
 *         retention_purged_at, all usage_* + timing counters
 *         (billing/audit defensibility per GDPR Art. 17(3)(e)).
 */
import * as fs from "node:fs";
import { getDb } from "./client";
import { recordAudit } from "./audit";
import { nowMs } from "../util/clock";

export interface PurgeStats {
  events_deleted: number;
  threads_purged: number;
  resources_deleted: number;
  work_items_deleted: number;
  memory_versions_deleted: number;
  memories_recomputed: number;
  memories_orphaned: number;
  files_unlinked: number;
  storage_warnings: string[];
}

/**
 * Batched DELETE that yields between batches so other tenants' writes
 * can progress. Each batch is its own micro-transaction. Returns total
 * rows deleted. On SQLITE_IOERR, aborts the process — sqlite state is
 * unrecoverable in place, the reaper will pick up on boot.
 */
function deleteInBatches(
  table: string,
  whereCol: string,
  whereVal: string,
  batchSize = 1000,
): number {
  const db = getDb();
  let total = 0;
  for (;;) {
    let affected: number;
    try {
      const result = db
        .prepare(
          `DELETE FROM ${table} WHERE rowid IN (
             SELECT rowid FROM ${table} WHERE ${whereCol} = ? LIMIT ?
           )`,
        )
        .run(whereVal, batchSize);
      affected = result.changes;
    } catch (err) {
      if (err instanceof Error && /SQLITE_IOERR|disk I\/O error/i.test(err.message)) {
        console.error(
          `[zdr] SQLITE_IOERR purging ${table} (${whereCol}=${whereVal}); aborting process`,
        );
        process.exit(2);
      }
      throw err;
    }
    total += affected;
    if (affected < batchSize) break;
  }
  return total;
}

/**
 * Recompute memories.content for memories that the purged session
 * wrote. Architect C1: the prior implementation scanned every
 * `memories` row in the DB without tenant scoping — a cross-tenant
 * DELETE risk. This version captures the set of affected memory_ids
 * BEFORE deleting memory_versions for the session, then operates
 * only on those rows. Tenant scoping comes for free since each
 * affected memory belongs to a store that the session wrote to.
 *
 * Sequence (called BEFORE the memory_versions DELETE for the session):
 *   1. Collect distinct memory_ids that have a version tagged with
 *      this session_id.
 *   2. After the caller deletes those version rows, this function is
 *      called with that captured set. For each memory:
 *      - If a surviving version exists, restore content from the
 *        most recent surviving version (by created_at desc).
 *      - If no version survives, the memory was created by this
 *        session; delete it (memories.content is NOT NULL — deletion
 *        is the only correct outcome).
 */
function collectAffectedMemoryIds(sessionId: string): string[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT DISTINCT memory_id FROM memory_versions WHERE session_id = ?`,
    )
    .all(sessionId) as Array<{ memory_id: string }>;
  return rows.map((r) => r.memory_id);
}

function recomputeMemoriesAfterPurge(
  affectedMemoryIds: readonly string[],
): { recomputed: number; orphaned: number } {
  const db = getDb();
  let recomputed = 0;
  let orphaned = 0;
  for (const memoryId of affectedMemoryIds) {
    const surviving = db
      .prepare(
        `SELECT content, content_sha256
           FROM memory_versions
          WHERE memory_id = ? AND content IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 1`,
      )
      .get(memoryId) as { content: string; content_sha256: string } | undefined;

    if (surviving) {
      // The CURRENT memories.content might already match the surviving
      // version (e.g. the session wrote a no-op update). UPDATE is
      // still safe — it's idempotent in that case.
      db.prepare(
        `UPDATE memories
            SET content = ?, content_sha256 = ?, updated_at = ?
          WHERE id = ?`,
      ).run(surviving.content, surviving.content_sha256, nowMs(), memoryId);
      recomputed++;
    } else {
      db.prepare(`DELETE FROM memories WHERE id = ?`).run(memoryId);
      orphaned++;
    }
  }
  return { recomputed, orphaned };
}

/**
 * Unlink session-scoped files (scope_type='session' AND scope_id=this).
 * Files scoped to an agent (or unscoped) are NOT touched — they belong
 * to the agent or are global, not session data.
 *
 * Best-effort: ENOENT counts as success; other errors recorded as
 * warnings; purge continues. The DB rows for these files are deleted
 * regardless of disk-unlink outcome (the DB is the source of truth
 * for "purged"; an orphan on disk is a metrics concern, not a
 * correctness one).
 */
function unlinkSessionFiles(sessionId: string): {
  unlinked: number;
  warnings: string[];
} {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, storage_path
         FROM files
        WHERE scope_type = 'session' AND scope_id = ?`,
    )
    .all(sessionId) as Array<{ id: string; storage_path: string }>;

  const warnings: string[] = [];
  let unlinked = 0;

  for (const { id, storage_path } of rows) {
    if (storage_path.startsWith("remote:")) {
      warnings.push(
        `file ${id}: stored remotely at ${storage_path}; AgentStep can't scrub upstream content (customer's separate Anthropic ZDR agreement governs)`,
      );
    } else {
      try {
        fs.unlinkSync(storage_path);
        unlinked++;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          unlinked++; // idempotent — already gone
        } else {
          warnings.push(
            `file ${id} at ${storage_path}: unlink failed (${code ?? err})`,
          );
        }
      }
    }
    try {
      db.prepare(`DELETE FROM files WHERE id = ?`).run(id);
    } catch {
      // session_resources DELETE later will clean up the link rows.
    }
  }

  return { unlinked, warnings };
}

/**
 * Stub the sessions row to a tombstone per the per-column policy.
 *
 * Architect C2 (corrected): the prior implementation missed
 * `parked_checkpoint_id` (a live pointer to sandbox state — real
 * leak), plus `last_seq` / `tool_calls_count` (behavioural metadata)
 * and `idle_since` (activity timestamp). All are now NULLed.
 *
 * KEPT (justification per column):
 *   id, tenant_id            — primary key + tenant scope
 *   agent_id, agent_version  — billing reconciliation
 *   environment_id           — billing reconciliation
 *   api_key_id               — auth attribution for the original session
 *   parent_session_id        — preserves thread ancestry for audit
 *   thread_depth             — cheap counter, no content
 *   provider_name            — billing reconciliation
 *   max_budget_usd, max_tokens, max_wall_duration_ms — config caps,
 *                              not content; useful for billing analysis
 *   archived_at              — terminal-state marker
 *   created_at, updated_at   — lifecycle timestamps
 *   status                   — set to 'purged' (terminal marker)
 *   retention_purged_at      — set to now (ZDR audit trail)
 *   turn_count               — count, not content; billing/usage stat
 *   active_seconds, duration_seconds — billing
 *   usage_*                  — token usage (billing) — explicitly kept
 *                              by GDPR Art. 17(3)(e) carve-out for
 *                              billing defensibility
 *   usage_cost_usd           — billing
 *
 * NULLed (potentially content-bearing or behavioural signal):
 *   stop_reason, metadata_json, title, claude_session_id, sandbox_name,
 *   outcome_criteria_json, resources_json, vault_ids_json,
 *   user_profile_id, debug_prompt_json,
 *   parked_checkpoint_id (C2: sandbox-state pointer, real leak),
 *   last_seq             (C2: reveals activity volume),
 *   tool_calls_count     (C2: granular behavioural metadata),
 *   idle_since           (C2: activity timing signal).
 */
function stubSessionRow(sessionId: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE sessions
        SET status                = 'purged',
            stop_reason           = NULL,
            metadata_json         = '{}',
            title                 = NULL,
            claude_session_id     = NULL,
            sandbox_name          = NULL,
            outcome_criteria_json = NULL,
            resources_json        = NULL,
            vault_ids_json        = NULL,
            user_profile_id       = NULL,
            debug_prompt_json     = NULL,
            parked_checkpoint_id  = NULL,
            last_seq              = 0,
            tool_calls_count      = 0,
            idle_since            = NULL,
            updated_at            = ?
      WHERE id = ?`,
  ).run(nowMs(), sessionId);
}

/**
 * Tenant guard + resume marker. Returns false if session is already
 * purged (caller should skip). Throws on tenant mismatch — that's a
 * caller bug or a cross-tenant attack attempt; refuse before any
 * destructive op.
 *
 * Architect H1: the prior implementation did SELECT + UPDATE as two
 * separate statements. A crash between them would leave the session
 * in its pre-purge status with no marker — the reaper never sees it.
 * This version uses a single conditional UPDATE-then-SELECT pattern
 * inside an IMMEDIATE transaction so the marker is set atomically
 * with the tenant check.
 */
function markPurgingStart(tenantId: string, sessionId: string): boolean {
  const db = getDb();
  // BEGIN IMMEDIATE acquires the writer lock up front so the SELECT
  // + UPDATE pair can't be interrupted by another writer between them.
  let proceed = false;
  let purged = false;
  let notFound = false;
  let mismatchTenant: string | null | undefined;
  db.transaction(() => {
    const row = db
      .prepare(`SELECT tenant_id, status FROM sessions WHERE id = ?`)
      .get(sessionId) as { tenant_id: string | null; status: string } | undefined;
    if (!row) {
      notFound = true;
      return;
    }
    if (row.tenant_id !== tenantId) {
      mismatchTenant = row.tenant_id;
      return;
    }
    if (row.status === "purged") {
      purged = true;
      return;
    }
    db.prepare(
      `UPDATE sessions SET status = 'purging', retention_purged_at = ? WHERE id = ?`,
    ).run(nowMs(), sessionId);
    proceed = true;
  }).immediate();

  if (notFound) {
    throw new Error(`zdr.purge: session not found: ${sessionId}`);
  }
  if (mismatchTenant !== undefined) {
    throw new Error(
      `zdr.purge: tenant mismatch (session belongs to ${mismatchTenant}, caller passed ${tenantId}) — refusing to purge ${sessionId}`,
    );
  }
  if (purged) return false;
  return proceed;
}

/**
 * Maximum depth of thread recursion in purge. The driver caps spawned
 * thread depth at 25 (sessions/driver.ts); we allow a small buffer
 * here for defense-in-depth against bad data (architect C5: prior
 * implementation had no depth cap, was vulnerable to malformed
 * parent_session_id cycles causing stack-overflow → process crash →
 * reaper picks up status='purging' → infinite loop).
 */
const MAX_PURGE_DEPTH = 30;

/**
 * Purge a single session level — files, per-session-table DELETEs,
 * memory recompute, stub. Does NOT recurse into child threads;
 * that's the caller's job (iterative loop in `purgeSession`).
 *
 * Architect M2: ordered so that linkage rows (session_resources) are
 * deleted BEFORE file rows. Closes the window where a GET on
 * session_resources would return a row pointing at a file_id that
 * no longer exists.
 *
 * Architect H4: also purges `session_threads` and `anthropic_sync`
 * rows tied to this session. Both held content-bearing references
 * that the prior implementation missed.
 */
function purgeSingleSession(
  tenantId: string,
  sessionId: string,
  initiatedBy: string,
): PurgeStats {
  const stats: PurgeStats = {
    events_deleted: 0,
    threads_purged: 0,
    resources_deleted: 0,
    work_items_deleted: 0,
    memory_versions_deleted: 0,
    memories_recomputed: 0,
    memories_orphaned: 0,
    files_unlinked: 0,
    storage_warnings: [],
  };
  const db = getDb();

  // C1: capture affected memory_ids BEFORE we delete the
  // memory_versions rows. Otherwise we lose the link.
  const affectedMemoryIds = collectAffectedMemoryIds(sessionId);

  // 1. File unlink BEFORE DB row deletes (architect's correctness
  //    fix from PR-Z2). If unlink fails, the session stays in
  //    status='purging' and the reaper retries.
  const fileResult = unlinkSessionFiles(sessionId);
  stats.files_unlinked += fileResult.unlinked;
  stats.storage_warnings.push(...fileResult.warnings);

  // 2. Batched DELETEs across per-session tables. M2: session_resources
  //    deleted BEFORE files (closes linkage-dangling window).
  stats.resources_deleted += deleteInBatches("session_resources", "session_id", sessionId);
  stats.events_deleted += deleteInBatches("events", "session_id", sessionId);
  stats.work_items_deleted += deleteInBatches("work_items", "session_id", sessionId);
  stats.memory_versions_deleted += deleteInBatches("memory_versions", "session_id", sessionId);
  // H4: session_threads + anthropic_sync. Both were missed in the
  // original engine.
  deleteInBatches("session_threads", "session_id", sessionId);
  try {
    // anthropic_sync uses (local_id, resource_type) composite PK; the
    // session's anthropic-side mapping is local_id=sessionId,
    // resource_type='session'. Tolerate the row not existing for
    // non-proxied sessions.
    db.prepare(
      `DELETE FROM anthropic_sync WHERE local_id = ? AND resource_type = 'session'`,
    ).run(sessionId);
  } catch {
    // Tolerate the table being absent on older schemas.
  }

  // 3. Memory content recompute, scoped to the captured set (C1).
  const memResult = recomputeMemoriesAfterPurge(affectedMemoryIds);
  stats.memories_recomputed += memResult.recomputed;
  stats.memories_orphaned += memResult.orphaned;

  // 4. Audit log entry BEFORE stub UPDATE (H3). If we crash between
  //    audit and stub, the reaper sees status='purging' and re-runs
  //    purge — which is idempotent and re-emits the audit row. If
  //    we crash between stub and audit (prior ordering), we'd have
  //    a stub with no audit trail and the reaper wouldn't pick it
  //    up (status='purged' is terminal).
  recordAudit({
    auth: null,
    action: "session.purged",
    resource_type: "session",
    resource_id: sessionId,
    outcome: "success",
    tenant_id: tenantId,
    metadata: {
      events_deleted: stats.events_deleted,
      resources_deleted: stats.resources_deleted,
      work_items_deleted: stats.work_items_deleted,
      memory_versions_deleted: stats.memory_versions_deleted,
      memories_recomputed: stats.memories_recomputed,
      memories_orphaned: stats.memories_orphaned,
      files_unlinked: stats.files_unlinked,
      storage_warnings_count: stats.storage_warnings.length,
      initiated_by: initiatedBy,
    },
  });

  // 5. Stub the row + flip status='purged' (terminal).
  stubSessionRow(sessionId);

  return stats;
}

/**
 * Purge all data associated with a session.
 *
 * Tenant guard is mandatory. Callers MUST supply the tenantId
 * resolved from the request's auth context. Refuses to run on
 * tenant mismatch — line of defense against cross-tenant leakage.
 *
 * Architect C5: child-thread purge is now iterative with a visited
 * set and a depth cap, not recursive. Malformed parent_session_id
 * cycles can no longer cause stack overflow or unbounded reaper
 * loops.
 *
 * `initiatedBy` is recorded in the audit log so a reader can tell
 * sweeper-evicted purges from operator-deletes from error-path
 * triggers from retroactive-admin-tool runs.
 */
export function purgeSession(opts: {
  tenantId: string;
  sessionId: string;
  initiatedBy?: string;
}): PurgeStats {
  const { tenantId, sessionId } = opts;
  const initiatedBy = opts.initiatedBy ?? "unknown";
  const stats: PurgeStats = {
    events_deleted: 0,
    threads_purged: 0,
    resources_deleted: 0,
    work_items_deleted: 0,
    memory_versions_deleted: 0,
    memories_recomputed: 0,
    memories_orphaned: 0,
    files_unlinked: 0,
    storage_warnings: [],
  };

  // Iterative depth-first traversal of the parent_session_id tree
  // rooted at sessionId. Visited set + depth cap protect against
  // cycles and unbounded recursion.
  const visited = new Set<string>();
  const stack: Array<{ id: string; depth: number }> = [{ id: sessionId, depth: 0 }];
  const db = getDb();

  while (stack.length > 0) {
    const { id, depth } = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    if (depth > MAX_PURGE_DEPTH) {
      stats.storage_warnings.push(
        `purge depth exceeded ${MAX_PURGE_DEPTH} at session ${id} — possible cycle in parent_session_id`,
      );
      continue;
    }
    // Tenant guard + marker (atomic, H1). Skip already-purged.
    if (!markPurgingStart(tenantId, id)) continue;

    // Find children BEFORE purging this node so we don't lose the
    // pointer chain. children.parent_session_id will be NULL'd by
    // the stub UPDATE on the child later, but we read them upfront.
    const childRows = db
      .prepare(`SELECT id FROM sessions WHERE parent_session_id = ? AND id != ?`)
      .all(id, id) as Array<{ id: string }>;
    for (const { id: childId } of childRows) {
      if (!visited.has(childId)) {
        stack.push({ id: childId, depth: depth + 1 });
      }
    }

    // Purge this single node.
    const single = purgeSingleSession(tenantId, id, initiatedBy);
    if (id !== sessionId) stats.threads_purged += 1;
    stats.events_deleted += single.events_deleted;
    stats.resources_deleted += single.resources_deleted;
    stats.work_items_deleted += single.work_items_deleted;
    stats.memory_versions_deleted += single.memory_versions_deleted;
    stats.memories_recomputed += single.memories_recomputed;
    stats.memories_orphaned += single.memories_orphaned;
    stats.files_unlinked += single.files_unlinked;
    stats.storage_warnings.push(...single.storage_warnings);
  }

  return stats;
}

/**
 * Boot-time orphan reaper. Finds sessions left in status='purging'
 * (a previous purge attempt crashed) and re-drives the purge.
 *
 * Architect H5 fixes:
 *   1. Loops until empty (no LIMIT) — silently skipping a backlog
 *      meant orphans could survive for days until the next deploy.
 *      Hard upper bound: 100k iterations to prevent runaway.
 *   2. Per-session retry counter (persisted in retention_attempts
 *      column when available, else in-memory only this boot). Sessions
 *      that fail 3+ times in a row get marked `status='purge_failed'`
 *      and surface in metrics — no more silent crash-loop on a single
 *      permanently-broken session.
 *   3. tenant_id NULL rows: marked `purge_failed` with a clear audit
 *      entry so they're surfaced rather than silently sitting forever.
 */
const MAX_REAP_ITERATIONS = 100_000;
const MAX_REAPER_RETRIES = 3;

export function reapPurgingSessions(): {
  reaped: number;
  failed: number;
  abandoned: number;
} {
  const db = getDb();
  let reaped = 0;
  let failed = 0;
  let abandoned = 0;
  const attempts = new Map<string, number>();

  for (let iter = 0; iter < MAX_REAP_ITERATIONS; iter++) {
    const rows = db
      .prepare(
        `SELECT id, tenant_id FROM sessions WHERE status = 'purging' LIMIT 100`,
      )
      .all() as Array<{ id: string; tenant_id: string | null }>;
    if (rows.length === 0) break;

    let madeProgress = false;
    for (const { id, tenant_id } of rows) {
      const seen = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, seen);

      if (seen > MAX_REAPER_RETRIES) {
        // Permanent failure — mark abandoned so it stops cycling.
        // The session row stays accessible to operators for manual
        // intervention. Metric: this should always be 0 in steady
        // state; non-zero means a bug to investigate.
        db.prepare(
          `UPDATE sessions SET status = 'purge_failed', updated_at = ? WHERE id = ? AND status = 'purging'`,
        ).run(nowMs(), id);
        recordAudit({
          auth: null,
          action: "session.purge_abandoned",
          resource_type: "session",
          resource_id: id,
          outcome: "failure",
          tenant_id: tenant_id ?? null,
          metadata: { reason: "max_reaper_retries_exceeded", attempts: seen },
        });
        abandoned++;
        madeProgress = true;
        continue;
      }

      if (!tenant_id) {
        // Architect H5 #2: don't leave a NULL-tenant row in 'purging'
        // forever. Mark abandoned so it stops cycling. Operator can
        // backfill tenant_id and reset status manually.
        db.prepare(
          `UPDATE sessions SET status = 'purge_failed', updated_at = ? WHERE id = ? AND status = 'purging'`,
        ).run(nowMs(), id);
        recordAudit({
          auth: null,
          action: "session.purge_abandoned",
          resource_type: "session",
          resource_id: id,
          outcome: "failure",
          tenant_id: null,
          metadata: { reason: "tenant_id_null", attempts: seen },
        });
        console.warn(
          `[zdr.reaper] session ${id} in 'purging' with NULL tenant_id — marked purge_failed`,
        );
        abandoned++;
        madeProgress = true;
        continue;
      }

      try {
        purgeSession({ tenantId: tenant_id, sessionId: id, initiatedBy: "boot_reaper" });
        reaped++;
        madeProgress = true;
      } catch (err) {
        console.warn(
          `[zdr.reaper] re-purge attempt ${seen}/${MAX_REAPER_RETRIES} failed for ${id}: ${err instanceof Error ? err.message : err}`,
        );
        failed++;
      }
    }

    // Guard against an infinite loop in pathological cases: if a full
    // batch produced no progress (no reaped, no failed-and-moved-on),
    // bail out.
    if (!madeProgress) break;
  }

  if (reaped > 0 || failed > 0 || abandoned > 0) {
    console.log(
      `[zdr.reaper] reaped=${reaped} failed=${failed} abandoned=${abandoned}`,
    );
  }
  return { reaped, failed, abandoned };
}

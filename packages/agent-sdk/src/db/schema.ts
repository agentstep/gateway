/**
 * Drizzle ORM schema — declarative table definitions for all 14 tables.
 *
 * This is the source of truth for column names, types, and defaults.
 * The actual CREATE TABLE + ALTER TABLE migrations still run in
 * migrations.ts (idempotent, PRAGMA-guarded). Drizzle doesn't
 * *create* the tables — it just types the queries against them.
 *
 * Tables are added incrementally as each db-layer file is migrated.
 */
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

// ── settings ──────────────────────────────────────────────────────────

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value"),
  updated_at: integer("updated_at"),
});

// ── proxy_resources ───────────────────────────────────────────────────

export const proxyResources = sqliteTable("proxy_resources", {
  resource_id: text("resource_id").primaryKey(),
  resource_type: text("resource_type").notNull(),
  created_at: integer("created_at").notNull(),
});

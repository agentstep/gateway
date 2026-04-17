/**
 * Drizzle ORM instance — wraps the existing libsql Database singleton.
 *
 * Usage: `import { db } from "./drizzle"` in db-layer files.
 * The underlying connection is still managed by client.ts (getDb/closeDb).
 * This module just wraps it in Drizzle's type-safe query builder.
 */
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { getDb } from "./client";
import * as schema from "./schema";

type GlobalDrizzle = typeof globalThis & {
  __caDrizzle?: BetterSQLite3Database<typeof schema>;
};
const g = globalThis as GlobalDrizzle;

export function getDrizzle(): BetterSQLite3Database<typeof schema> {
  if (g.__caDrizzle) return g.__caDrizzle;
  const raw = getDb();
  g.__caDrizzle = drizzle(raw, { schema });
  return g.__caDrizzle;
}

export { schema };

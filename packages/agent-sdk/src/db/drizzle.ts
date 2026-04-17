/**
 * Drizzle ORM instance — wraps the existing libsql Database singleton.
 *
 * The project uses the `libsql` npm package (a synchronous better-sqlite3-
 * compatible SQLite driver). Drizzle's `drizzle-orm/better-sqlite3` adapter
 * requires the `better-sqlite3` package at import time, so we wire up the
 * session and database classes directly — same runtime path, no peer-dep.
 *
 * Usage: `import { getDrizzle, schema } from "./drizzle"` in db-layer files.
 * The underlying connection is still managed by client.ts (getDb/closeDb).
 */
import type { Database as BetterSQLite3 } from "better-sqlite3";
import { BetterSQLiteSession } from "drizzle-orm/better-sqlite3/session";
import { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core/db";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core/dialect";
import {
  createTableRelationsHelpers,
  extractTablesRelationalConfig,
  type TablesRelationalConfig,
  type RelationalSchemaConfig,
} from "drizzle-orm/relations";
import { entityKind } from "drizzle-orm/entity";
import { getDb } from "./client";
import * as schema from "./schema";

type FullSchema = typeof schema;
type SchemaConfig = RelationalSchemaConfig<TablesRelationalConfig>;

// Drizzle DB type using better-sqlite3 RunResult (libsql is API-compatible)
type LibSQLDrizzleDB = BaseSQLiteDatabase<
  "sync",
  import("better-sqlite3").RunResult,
  FullSchema,
  TablesRelationalConfig
>;

type GlobalDrizzle = typeof globalThis & {
  __caDrizzle?: LibSQLDrizzleDB;
};
const g = globalThis as GlobalDrizzle;

export function getDrizzle(): LibSQLDrizzleDB {
  if (g.__caDrizzle) return g.__caDrizzle;
  const raw = getDb();
  const dialect = new SQLiteSyncDialect({});
  const tablesConfig = extractTablesRelationalConfig(
    schema,
    createTableRelationsHelpers,
  );
  const schemaConfig: SchemaConfig = {
    fullSchema: schema,
    schema: tablesConfig.tables,
    tableNamesMap: tablesConfig.tableNamesMap,
  };
  // libsql is API-compatible with better-sqlite3; cast to satisfy the type.
  const session = new BetterSQLiteSession<FullSchema, TablesRelationalConfig>(
    raw as unknown as BetterSQLite3,
    dialect,
    schemaConfig,
    {},
  );

  class LibSQLDatabase extends BaseSQLiteDatabase<
    "sync",
    import("better-sqlite3").RunResult,
    FullSchema,
    TablesRelationalConfig
  > {
    static override readonly [entityKind]: string = "LibSQLDatabase";
  }

  g.__caDrizzle = new LibSQLDatabase("sync", dialect, session, schemaConfig);
  return g.__caDrizzle;
}

export { schema };

import { PgBoss } from "pg-boss";
import type { JobLogger } from "./types";

/**
 * Pure factory — no caching, no process hooks, no config reading. Owning the
 * boss lifecycle (singleton caching, shutdown hooks, reading connection
 * settings) is the application's job.
 *
 * The `error` and `warning` handlers are the reason to prefer this over
 * `new PgBoss(...)` directly: an unhandled pg-boss `error` event crashes the
 * Node process.
 */
export function createBoss(args: {
  connectionString: string;
  migrate: boolean;
  max?: number;
  /** Surfaces in `pg_stat_activity` — set it to something you can grep for. */
  applicationName?: string;
  /** Postgres schema pg-boss owns. Defaults to pg-boss's own default. */
  schema?: string;
  logger: JobLogger;
}): PgBoss {
  const boss = new PgBoss({
    application_name: args.applicationName ?? "bosskit",
    connectionString: args.connectionString,
    max: args.max ?? 5,
    migrate: args.migrate,
    schema: args.schema ?? "pgboss",
    useListenNotify: true,
  });
  // Mandatory: an unhandled 'error' event would crash the Node process.
  boss.on("error", (err) => args.logger.error({ err }, "pg-boss error"));
  boss.on("warning", (warning) => args.logger.warn({ warning }, "pg-boss warning"));
  return boss;
}

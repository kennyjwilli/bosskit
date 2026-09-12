import { type ConstructorOptions, PgBoss } from "pg-boss";
import type { JobLogger } from "./types";

/**
 * Pure factory — no caching, no process hooks, no config reading. Owning the
 * boss lifecycle (singleton caching, shutdown hooks, reading connection
 * settings) is the application's job.
 *
 * Takes pg-boss's own constructor options, so nothing pg-boss accepts needs a
 * bosskit release to reach it. `migrate` is required where pg-boss defaults
 * it: whether this process installs the schema or expects it installed is a
 * decision every deployment has to make. The `error` and `warning` handlers
 * are the reason to prefer this over `new PgBoss(...)` directly: an unhandled
 * pg-boss `error` event crashes the Node process.
 */
export function createBoss(
  options: ConstructorOptions & { migrate: boolean; logger: JobLogger }
): PgBoss {
  const { logger, ...pgBossOptions } = options;
  const boss = new PgBoss({
    // Surfaces in pg_stat_activity — worth overriding with something you can grep for.
    application_name: "bosskit",
    max: 5,
    schema: "pgboss",
    useListenNotify: true,
    ...pgBossOptions,
  });
  // Mandatory: an unhandled 'error' event would crash the Node process.
  boss.on("error", (err) => logger.error({ err }, "pg-boss error"));
  boss.on("warning", (warning) => logger.warn({ warning }, "pg-boss warning"));
  return boss;
}

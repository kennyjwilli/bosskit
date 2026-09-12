import { type ConstructorOptions, PgBoss } from "pg-boss";
import type { JobLogger } from "./types";

/**
 * `new PgBoss()` with its `error` event handled; unhandled, that event crashes
 * the process. `migrate` is required where pg-boss defaults it: whether this
 * process installs the schema is a decision every deployment has to make.
 */
export function createBoss(
  options: ConstructorOptions & { migrate: boolean; logger: JobLogger }
): PgBoss {
  const { logger, ...pgBossOptions } = options;
  const boss = new PgBoss(pgBossOptions);
  boss.on("error", (err) => logger.error({ err }, "pg-boss error"));
  boss.on("warning", (warning) => logger.warn({ warning }, "pg-boss warning"));
  return boss;
}

import crypto from "node:crypto";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

/**
 * Create a throwaway database for one test file and drop it afterwards.
 *
 * Far simpler than an application's equivalent: the only schema bosskit needs
 * is `pgboss`, which pg-boss creates itself when `createBoss` is called with
 * `migrate: true`. So there is no template database, no migration step, and no
 * global setup — just CREATE, hand back a handle, DROP.
 *
 * Requires TEST_DATABASE_URL pointing at a Postgres a test run may freely
 * create and drop databases on. Never point this at anything you care about.
 */
export async function setupTestDb(options: { testFile: string }): Promise<{
  db: ReturnType<typeof drizzle>;
  url: string;
  teardown: () => Promise<void>;
}> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    throw new Error(
      "TEST_DATABASE_URL is not set — see CONTRIBUTING or scripts/test-integration.sh"
    );
  }

  // Name after the test file plus a random suffix: readable when a run leaks a
  // database, and unique because one file may call this more than once.
  const slug = path
    .basename(options.testFile)
    .replace(/\.integration\.test\.ts$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30);
  const dbName = `bosskit_test_${slug}_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;

  const admin = postgres(adminUrl, { max: 1 });
  let client: ReturnType<typeof postgres> | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);

    const url = new URL(adminUrl);
    url.pathname = `/${dbName}`;
    const dbUrl = url.toString();

    client = postgres(dbUrl, { max: 5 });
    const db = drizzle(client);

    return {
      db,
      url: dbUrl,
      teardown: async () => {
        await client?.end();
        // Terminate stragglers first; pg-boss keeps a LISTEN connection that
        // would otherwise block the DROP.
        await admin.unsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`
        );
        await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
        await admin.end();
      },
    };
  } catch (err) {
    // Best-effort cleanup so a partial failure leaks neither the database nor
    // its connections. Cleanup errors are logged, never thrown — they must not
    // mask the original failure.
    await client?.end().catch((e) => console.error("setupTestDb: client.end failed", e));
    await admin
      .unsafe(`DROP DATABASE IF EXISTS "${dbName}"`)
      .catch((e) => console.error("setupTestDb: drop failed", e));
    await admin.end().catch((e) => console.error("setupTestDb: admin.end failed", e));
    throw err;
  }
}
